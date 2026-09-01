import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import { instance as vizInstance } from "@viz-js/viz";
import type { BeadsFeature as BeadsPlugin, InlineAgentSession, PrimedSessionRequest } from "./feature";
import { activeOptions } from "./settings";
import { VIEW_TYPE_BEADS_GRAPH, BeadIssue, EDITABLE_STATUSES } from "./types";
import { bdExport, bdShow, bdUpdate, BdError, BdOptions } from "./bd";
import { buildGraphDot, parseExportJsonl, GraphBuildError } from "./graphBuilder";
import { renderPriorityDot } from "./row";
import { makePaneResizable } from "../utils";

/**
 * Graphviz-as-WASM, loaded once per session.
 *
 * `@viz-js/viz` embeds the Graphviz WASM binary *inside* its JS bundle, so
 * esbuild bundles the whole engine into main.js and nothing is ever fetched at
 * runtime — the same offline/CSP-safe constraint that forced D3 to be vendored.
 * (@hpcc-js/wasm-graphviz resolves a separate `.wasm` asset, and d3-graphviz
 * layers a full d3 dependency on top of it; neither buys us anything here.)
 */
let vizPromise: ReturnType<typeof vizInstance> | undefined;
function getViz(): ReturnType<typeof vizInstance> {
	if (!vizPromise) vizPromise = vizInstance();
	return vizPromise;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;
const ZOOM_LAYER_CLASS = "beads-graph-zoom";
/** Pointer travel (px) past which a press counts as a pan, not a node click. */
const CLICK_SLOP_PX = 4;

export interface GraphState {
	id?: string;
	all?: boolean;
}

/** Strip anything active out of the engine's SVG before it touches the DOM. */
function sanitize(svg: SVGSVGElement): void {
	for (const el of Array.from(svg.querySelectorAll("script, foreignObject"))) {
		el.remove();
	}
	// Issue titles flow into DOT labels, so treat the rendered SVG as untrusted:
	// drop event handlers and every link target (we never need one — clicks are
	// handled by our own listener).
	for (const el of Array.from(svg.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "href" || name === "xlink:href") {
				el.removeAttribute(attr.name);
			}
		}
	}
}

/** The bd issue id of a Graphviz `g.node`, which DOT emits as its `<title>`. */
function nodeId(g: Element): string | undefined {
	return g.querySelector("title")?.textContent?.trim() || undefined;
}

/**
 * Dependency-graph tab.
 *
 * The DOT we render is the same clean, layered DAG as bd's terminal view (a
 * `rank=same` sub-graph per dependency layer, bd's status colours per node) —
 * built locally from one `bd export` (see graphBuilder.ts) rather than by
 * shelling out to bd's own very slow `--dot`. Graphviz does the layout, via a
 * bundled WASM build, and the resulting SVG is rendered straight into the
 * pane. That replaces bd's `--html` output, whose force-directed D3 layout
 * collapses into an unreadable hairball past a few dozen nodes.
 *
 * The SVG lives in the pane's own DOM (no iframe) so a node click can call
 * `plugin.openBead()` directly; see `sanitize()` for what that costs us.
 */
/** Tick rate for the "N s elapsed" label while a graph build is in flight. */
const ELAPSED_TICK_MS = 1_000;

export class BeadsGraphView extends ItemView {
	private state: GraphState = {};
	private loading = false;
	private error?: string;
	private cancelled = false;
	private dot?: string;
	private loadSeq = 0;

	// Cancellation + elapsed-time tracking for the in-flight `bd export` call.
	// `bd` is a single process (confirmed no detached Dolt child), so aborting
	// it is a clean kill, not an orphan risk — see bd.ts.
	private abortController?: AbortController;
	private loadStartedAt = 0;
	private elapsedSec = 0;
	private elapsedTimer?: number;

	// Pan/zoom state, in the SVG's own user units. Applied to a wrapper <g> we
	// insert around Graphviz's output, so the root <svg>/viewBox stays put and
	// screen->user conversion below is always against an unchanging CTM.
	private zoomLayer?: SVGGElement;
	private tx = 0;
	private ty = 0;
	private k = 1;

	// The one node-detail popup, if a node is currently selected. `seq` guards
	// against a slow bdShow() resolving after the user clicked a different node
	// (or closed the popup) in the meantime.
	private popupEl?: HTMLElement;
	private popupSeq = 0;

	// The graph and the agent pane are SIBLINGS, not nested — same reasoning as
	// BeadEditorView: render() empties its own root on every load, and a
	// terminal inside that root would be destroyed (and its process orphaned)
	// by an unrelated reload (e.g. the watcher-driven background refresh).
	private bodyEl: HTMLElement | null = null;
	private paneEl: HTMLElement | null = null;
	private agent: InlineAgentSession | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS_GRAPH;
	}
	getDisplayText(): string {
		return this.state.all ? "Beads: all issues" : this.state.id ? `Graph: ${this.state.id}` : "Beads graph";
	}
	getIcon(): string {
		return "git-fork";
	}

	async setState(state: unknown, result: Parameters<ItemView["setState"]>[1]): Promise<void> {
		this.state = (state as GraphState) ?? {};
		await super.setState(state, result);
		await this.loadGraph();
	}

	getState(): Record<string, unknown> {
		return { ...this.state };
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.loadGraph();
	}

	private resolveOpts(): BdOptions | null {
		const opts = activeOptions(this.plugin.settings);
		if (!opts) return null;
		if (!existsSync(join(opts.cwd, ".beads"))) return null;
		return opts;
	}

	/**
	 * `preserveView`, when true and a graph is already showing, keeps the
	 * current pan/zoom instead of re-fitting. Used by watcher/timer-driven
	 * background reloads (see `refreshFromExternalChange`) so a graph update
	 * from an agent creating beads in a terminal doesn't yank the view out from
	 * under someone who's mid-pan/zoom. An explicit user-initiated load (first
	 * open, Refresh click, or a genuinely empty view) always re-fits.
	 */
	private async loadGraph(preserveView = false): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			this.error = "No project root / .beads database configured (Settings → Beads).";
			this.dot = undefined;
			this.render();
			return;
		}
		const keepPanZoom = preserveView && this.dot !== undefined;
		const seq = ++this.loadSeq;
		this.loading = true;
		this.error = undefined;
		this.cancelled = false;
		this.abortController = new AbortController();
		this.startElapsedTimer();
		this.render();
		try {
			// One `bd export` for the whole repo, then the scoping/layering/DOT
			// emission happens locally — see graphBuilder.ts for why (bd's own
			// `--dot` closure walk cost 8–142s where the export costs ~1.5s).
			const jsonl = await bdExport({ ...opts, signal: this.abortController.signal });
			if (seq !== this.loadSeq) return;
			const dot = buildGraphDot(parseExportJsonl(jsonl), {
				id: this.state.id,
				all: this.state.all,
			});
			if (seq !== this.loadSeq) return;
			this.dot = dot;
			if (!keepPanZoom) this.resetZoom(); // a new graph starts fitted, not wherever the last one was panned to
		} catch (e) {
			if (seq !== this.loadSeq) return;
			if (e instanceof BdError && e.aborted) {
				this.cancelled = true;
			} else if (e instanceof BdError || e instanceof GraphBuildError) {
				this.error = e.message;
			} else {
				this.error = String(e);
			}
		} finally {
			// Only the newest load owns the shared timer/controller. A superseded
			// load clearing them would stop the *current* load's elapsed counter and
			// null out the controller its Cancel button aborts through, leaving the
			// user watching a frozen counter with a dead Cancel. The superseded
			// load's own controller reference is already gone (overwritten by the
			// newer load above), so skipping the clear leaks nothing.
			if (seq === this.loadSeq) {
				this.stopElapsedTimer();
				this.abortController = undefined;
				this.loading = false;
				this.render();
			}
		}
	}

	private startElapsedTimer(): void {
		this.loadStartedAt = Date.now();
		this.elapsedSec = 0;
		this.stopElapsedTimer();
		this.elapsedTimer = window.setInterval(() => {
			this.elapsedSec = Math.floor((Date.now() - this.loadStartedAt) / 1000);
			if (this.loading) this.render();
		}, ELAPSED_TICK_MS);
	}

	private stopElapsedTimer(): void {
		if (this.elapsedTimer) {
			window.clearInterval(this.elapsedTimer);
			this.elapsedTimer = undefined;
		}
	}

	async onClose(): Promise<void> {
		this.stopElapsedTimer();
		this.abortController?.abort();
		// Kill the embedded agent before the DOM goes away, so closing the tab
		// cannot leave an orphaned PTY behind.
		await this.closeAgent();
		this.contentEl.empty();
		this.bodyEl = null;
		this.paneEl = null;
	}

	onResize(): void {
		this.agent?.fit();
	}

	/** Called by `BeadsFeature` on a `.beads` watcher/timer tick — reloads without disturbing the current pan/zoom. */
	refreshFromExternalChange(): void {
		if (this.loading) return; // a load already in flight will pick up the change
		// A node popup's own `bd show` touches `.beads/`, which re-triggers this
		// via the watcher a moment later — reloading now would blow away the
		// popup's DOM (render() empties the canvas) right after opening it. Skip;
		// the next timer/watcher tick after the popup closes will catch up.
		if (this.popupEl) return;
		void this.loadGraph(true);
	}

	// --- agent pane --------------------------------------------------------

	/**
	 * The two-part layout: the graph pinned above, an agent pane below it.
	 * Built lazily so the first `render()` call (from `onOpen`) creates it.
	 */
	private ensureShell(): HTMLElement {
		if (this.bodyEl?.isConnected) return this.bodyEl;
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-graph-shell");
		this.bodyEl = root.createDiv();
		this.paneEl = root.createDiv({ cls: "beads-agent-pane beads-hidden" });
		return this.bodyEl;
	}

	/**
	 * Start an agent in the pane below the graph. Reached only from the "Plan"
	 * button's preview modal — an explicit click, an explicit harness choice,
	 * and an explicit second click on a modal that shows the exact prompt. See
	 * harness.ts for the full safety posture (typed, never submitted).
	 */
	private async startAgent(request: PrimedSessionRequest): Promise<void> {
		await this.closeAgent();
		const pane = this.paneEl;
		if (!pane) throw new Error("The graph view is not ready.");

		pane.empty();
		pane.removeClass("beads-hidden");
		makePaneResizable(pane);

		const bar = pane.createDiv({ cls: "beads-agent-bar" });
		const label = bar.createDiv({ cls: "beads-agent-title", text: request.title });
		const closeBtn = bar.createEl("button", {
			cls: "beads-agent-close",
			text: "Close agent",
		});
		closeBtn.onclick = () => void this.closeAgent();
		const host = pane.createDiv({ cls: "beads-agent-terminal" });

		try {
			this.agent = this.plugin.mountInlineAgentSession(host, request);
		} catch (e) {
			this.hideAgentPane();
			throw e instanceof Error ? e : new Error(String(e));
		}
		const agent = this.agent;
		agent.primed.then(
			() => agent.focus(),
			(e: Error) => {
				label.setText(`${request.title} — ${e.message}`);
				new Notice(`Beads: ${e.message}`);
			},
		);
	}

	private async closeAgent(): Promise<void> {
		const agent = this.agent;
		this.agent = null;
		if (agent) await agent.dispose();
		this.hideAgentPane();
	}

	private hideAgentPane(): void {
		this.paneEl?.empty();
		this.paneEl?.addClass("beads-hidden");
	}

	/** Cancel the in-flight `bd export` call. bd's process dies cleanly (SIGTERM), no orphan risk. */
	private cancelLoad(): void {
		this.abortController?.abort();
	}

	private resetZoom(): void {
		this.tx = 0;
		this.ty = 0;
		this.k = 1;
		this.applyTransform();
	}

	private applyTransform(): void {
		this.zoomLayer?.setAttribute(
			"transform",
			`translate(${this.tx} ${this.ty}) scale(${this.k})`,
		);
	}

	private render(): void {
		const root = this.ensureShell();
		root.empty();
		this.zoomLayer = undefined;
		this.popupEl = undefined;
		this.popupSeq++; // invalidate any in-flight bdShow from before this re-render
		root.addClass("beads-graph-pane");

		const header = root.createDiv({ cls: "beads-graph-header" });
		header.createDiv({
			cls: "beads-graph-title",
			text: this.state.all ? "All issues" : (this.state.id ?? "Beads graph"),
		});
		const buttons = header.createDiv({ cls: "beads-graph-actions" });
		// Bead-agnostic — no specific bead is "the" subject while looking at a
		// graph, so this opens the same harness-menu/preview flow as "Work the
		// bead" but with a short, project-scoped prompt instead of one bead's.
		const plan = buttons.createEl("button", { cls: "mod-cta", text: "Plan" });
		plan.onclick = (e) => this.plugin.planningSession(e, (request) => this.startAgent(request));
		const fit = buttons.createEl("button", { text: "Reset zoom" });
		fit.onclick = () => this.resetZoom();
		if (this.loading) {
			const cancel = buttons.createEl("button", { text: "Cancel" });
			cancel.onclick = () => this.cancelLoad();
		}
		const refresh = buttons.createEl("button", {
			text: this.loading ? "Loading…" : "Refresh",
		});
		refresh.disabled = this.loading;
		refresh.onclick = () => void this.loadGraph();

		if (this.error) {
			root.createDiv({ cls: "beads-empty beads-error", text: this.error });
			return;
		}
		if (this.loading && !this.dot) {
			// A graph is one `bd export` of the whole issue database — a couple
			// of seconds on a large repo, not the minutes bd's own closure walk
			// used to cost. It is still a Dolt read that grows with repo size,
			// so keep ticking the elapsed time: "still working" has to stay
			// visibly distinct from "hung", and Cancel stays available.
			root.createDiv({
				cls: "beads-empty",
				text: `Building graph — reading the issue database… (${this.elapsedSec}s elapsed)`,
			});
			return;
		}
		if (this.cancelled && !this.dot) {
			root.createDiv({ cls: "beads-empty", text: "Cancelled." });
			return;
		}
		if (!this.dot) return;

		const canvas = root.createDiv({ cls: "beads-graph-canvas" });
		void this.drawInto(canvas, this.dot);
	}

	/** Lay the DOT out with Graphviz and mount the SVG. Async: the first call waits on the WASM engine. */
	private async drawInto(canvas: HTMLElement, dot: string): Promise<void> {
		const seq = this.loadSeq;
		let markup: string;
		try {
			const viz = await getViz();
			markup = viz.renderString(dot, { format: "svg" });
		} catch (e) {
			if (seq !== this.loadSeq || !canvas.isConnected) return;
			canvas.createDiv({
				cls: "beads-empty beads-error",
				text: `Could not lay out the graph: ${String(e)}`,
			});
			return;
		}
		if (seq !== this.loadSeq || !canvas.isConnected) return;

		const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
		const svg = doc.documentElement as unknown as SVGSVGElement;
		if (svg.tagName.toLowerCase() !== "svg") {
			canvas.createDiv({ cls: "beads-empty beads-error", text: "Graphviz returned no SVG." });
			return;
		}
		sanitize(svg);

		// Fill the pane and let the viewBox Graphviz emitted do the initial fit.
		svg.setAttribute("width", "100%");
		svg.setAttribute("height", "100%");
		svg.classList.add("beads-graph-svg");

		const mounted = canvas.appendChild(document.importNode(svg, true));

		// Re-parent Graphviz's content under a wrapper <g> that carries pan/zoom.
		const layer = mounted.createSvg("g", { cls: ZOOM_LAYER_CLASS });
		while (mounted.firstChild && mounted.firstChild !== layer) {
			layer.appendChild(mounted.firstChild);
		}
		this.zoomLayer = layer;
		this.applyTransform();

		this.wire(canvas, mounted);
	}

	/** Screen coordinates → the root SVG's user units (unaffected by our pan/zoom). */
	private toUser(svg: SVGSVGElement, x: number, y: number): { x: number; y: number } {
		const ctm = svg.getScreenCTM();
		if (!ctm) return { x, y };
		const p = new DOMPoint(x, y).matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}

	// Listeners go on the containing HTMLElement (Obsidian's registerDomEvent
	// only takes those, and these events all bubble); the <svg> is still what we
	// measure against for screen->user coordinates.
	private wire(host: HTMLElement, svg: SVGSVGElement): void {
		this.registerDomEvent(host, "wheel", (e: WheelEvent) => {
			e.preventDefault();
			const p = this.toUser(svg, e.clientX, e.clientY);
			const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.k * Math.exp(-e.deltaY * 0.002)));
			const ratio = next / this.k;
			// Keep the point under the cursor pinned while the scale changes.
			this.tx = p.x - ratio * (p.x - this.tx);
			this.ty = p.y - ratio * (p.y - this.ty);
			this.k = next;
			this.applyTransform();
		});

		let dragging = false;
		let moved = false;
		let last = { x: 0, y: 0 };
		let downAt = { x: 0, y: 0 };
		// The node (if any) under the pointer at press time. Captured *before*
		// setPointerCapture, because once the host has capture the UA retargets
		// the synthesized `click` event's `target` to the capturing element
		// (host) regardless of what's visually under the cursor — so the click
		// handler can't hit-test itself and must use this instead.
		let downNode: Element | null = null;
		this.registerDomEvent(host, "pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			// Don't engage pan/capture for presses inside the popup: setPointerCapture
			// retargets the *click* event's target to `host` for the rest of this
			// gesture (the same quirk that once broke node clicks), which would
			// stop it from ever reaching a button's own onclick — e.g. "Open".
			if (this.popupEl && (e.target as Element | null)?.closest(".beads-graph-popup")) return;
			dragging = true;
			moved = false;
			downAt = { x: e.clientX, y: e.clientY };
			last = this.toUser(svg, e.clientX, e.clientY);
			downNode = (e.target as Element | null)?.closest?.("g.node") ?? null;
			host.setPointerCapture(e.pointerId);
		});
		this.registerDomEvent(host, "pointermove", (e: PointerEvent) => {
			if (!dragging) return;
			if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > CLICK_SLOP_PX) moved = true;
			const p = this.toUser(svg, e.clientX, e.clientY);
			this.tx += p.x - last.x;
			this.ty += p.y - last.y;
			last = p;
			this.applyTransform();
		});
		const endDrag = (e: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
		};
		this.registerDomEvent(host, "pointerup", endDrag);
		this.registerDomEvent(host, "pointercancel", endDrag);

		this.registerDomEvent(host, "click", (e: MouseEvent) => {
			if (moved) return; // that was a pan, not a click
			// Use the node hit-tested at pointerdown, not e.target: pointer
			// capture retargets the click event's target to `host`.
			const g = downNode;
			if (!g) {
				this.closePopup();
				return;
			}
			const id = nodeId(g);
			if (id) void this.showPopup(host, id, e.clientX, e.clientY);
		});
	}

	private closePopup(): void {
		this.popupSeq++; // invalidate any in-flight bdShow for the closed popup
		this.popupEl?.remove();
		this.popupEl = undefined;
	}

	/** Node click → fetch the full issue and show a small detail popover at the click point. */
	private async showPopup(host: HTMLElement, id: string, clientX: number, clientY: number): Promise<void> {
		this.closePopup();
		const seq = ++this.popupSeq;
		const opts = this.resolveOpts();

		const rect = host.getBoundingClientRect();
		const popup = host.createDiv({ cls: "beads-graph-popup" });
		popup.style.left = `${clientX - rect.left}px`;
		popup.style.top = `${clientY - rect.top}px`;
		this.popupEl = popup;
		popup.createDiv({ cls: "beads-empty", text: "Loading…" });

		if (!opts) return; // shouldn't happen (the pane wouldn't have rendered a graph), but stay defensive

		let issue: BeadIssue | null;
		try {
			issue = await bdShow(opts, id);
		} catch (e) {
			if (seq !== this.popupSeq) return;
			popup.empty();
			popup.createDiv({
				cls: "beads-empty beads-error",
				text: e instanceof BdError ? e.message : String(e),
			});
			return;
		}
		if (seq !== this.popupSeq) return; // superseded by a newer click/close
		popup.empty();
		if (!issue) {
			popup.createDiv({ cls: "beads-empty", text: `${id} — not found (stale graph?)` });
			return;
		}

		const head = popup.createDiv({ cls: "beads-graph-popup-head" });
		renderPriorityDot(head, issue.priority ?? 2);
		const main = head.createDiv({ cls: "beads-main" });
		main.createDiv({ cls: "beads-title", text: issue.title });
		const meta = main.createDiv({ cls: "beads-meta" });
		meta.createSpan({ cls: "beads-id", text: issue.id });
		const closeXBtn = head.createEl("button", {
			cls: "clickable-icon beads-graph-popup-close",
			attr: { "aria-label": "Close" },
		});
		closeXBtn.setText("×");
		closeXBtn.onclick = () => this.closePopup();

		// Status is editable right here — the same field/values as the full
		// editor's Status dropdown (bdUpdate), not a separate close-with-reason
		// flow, so there's one consistent way to change a bead's status.
		const statusRow = popup.createDiv({ cls: "beads-graph-popup-status" });
		const statusSel = statusRow.createEl("select", { cls: "dropdown" });
		if (!EDITABLE_STATUSES.includes(issue.status as (typeof EDITABLE_STATUSES)[number])) {
			statusSel.createEl("option", { value: issue.status, text: issue.status });
		}
		for (const s of EDITABLE_STATUSES) statusSel.createEl("option", { value: s, text: s });
		statusSel.value = issue.status;
		statusSel.onchange = () => {
			void this.updateStatus(opts, issue.id, statusSel.value, statusSel);
		};

		if (issue.description) {
			popup.createDiv({ cls: "beads-graph-popup-desc", text: issue.description });
		}

		const actions = popup.createDiv({ cls: "beads-graph-popup-actions" });
		if (issue.issue_type === "epic") {
			const addChildBtn = actions.createEl("button", { text: "Add child" });
			addChildBtn.onclick = () => {
				this.closePopup();
				void this.plugin.newBead({ parent: issue.id });
			};
		}
		if (issue.status !== "closed") {
			const addDepBtn = actions.createEl("button", { text: "Add follow-up" });
			addDepBtn.onclick = () => {
				this.closePopup();
				void this.plugin.newBead({ blockedBy: issue.id });
			};
		}
		const openBtn = actions.createEl("button", { cls: "mod-cta", text: "Open" });
		openBtn.onclick = () => {
			this.closePopup();
			void this.plugin.openBead(issue.id);
		};
	}

	/** Change a bead's status from the popup, then refresh the graph so its node color updates. */
	private async updateStatus(
		opts: BdOptions,
		id: string,
		status: string,
		select: HTMLSelectElement,
	): Promise<void> {
		select.disabled = true;
		try {
			await bdUpdate(opts, id, { status });
			new Notice(`Beads: ${id} → ${status}`);
			this.plugin.refreshViews();
			await this.loadGraph(); // re-fetch + re-lay-out so the node's color reflects the new status
		} catch (e) {
			new Notice(`Beads: ${e instanceof BdError ? e.message : String(e)}`, 8000);
			select.disabled = false;
		}
	}
}
