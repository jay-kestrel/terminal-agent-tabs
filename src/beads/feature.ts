import {
	App,
	FileSystemAdapter,
	MarkdownPostProcessorContext,
	Notice,
	WorkspaceLeaf,
} from "obsidian";
import { FSWatcher, watch, existsSync } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	activeProject,
	activeOptions,
	makeProject,
	migrateSettings,
} from "./settings";
import { BeadsView } from "./view";
import { BeadEditorView } from "./editor";
import { BeadsGraphView, GraphState } from "./graph";
import {
	BeadIssue,
	VIEW_TYPE_BEADS,
	VIEW_TYPE_BEADS_EDITOR,
	VIEW_TYPE_BEADS_GRAPH,
} from "./types";
import { bdStatusCounts, invalidateReadCache } from "./bd";
import { registerBeadsCodeBlock } from "./codeblock";
import { showHarnessMenu, showPlanningMenu, HarnessProfile } from "./harness";

/**
 * The host plugin surface BeadsFeature needs. Declared structurally (rather
 * than importing the concrete plugin class) so this module stays a leaf of the
 * beads subtree and does not create an import cycle with `src/main.ts`.
 */
export interface BeadsHost {
	app: App;
	/** Persisted plugin data; beads settings live under the `beads` key. */
	saveSettings(): Promise<void>;
	registerView(
		type: string,
		factory: (leaf: WorkspaceLeaf) => BeadsView | BeadEditorView | BeadsGraphView,
	): void;
	addRibbonIcon(icon: string, title: string, cb: () => void): HTMLElement;
	addCommand(command: { id: string; name: string; callback: () => void }): void;
	addStatusBarItem(): HTMLElement;
	registerInterval(id: number): number;
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => void | Promise<void>,
	): unknown;
	/**
	 * Open an agent session tab in the merged plugin's own PTY infrastructure,
	 * primed (but NOT submitted) with `prompt`. See `main.ts`.
	 */
	openPrimedAgentSession(request: PrimedSessionRequest): Promise<void>;
	/**
	 * The same flow, embedded: start the agent inside `container` (an element
	 * the caller owns and tears down) instead of in a workspace tab. Used by the
	 * bead editor's agent pane. Throws if the session could not be spawned.
	 */
	mountInlineAgentSession(
		container: HTMLElement,
		request: PrimedSessionRequest,
	): InlineAgentSession;
	/** CLI profile ids/names available for session tabs, for the harness menu. */
	listSessionTargets(): { id: string; displayName: string }[];
}

/**
 * Handle to an agent terminal embedded in a beads view. Declared here rather
 * than imported from the host so this module stays a leaf of the beads subtree;
 * the host satisfies it structurally.
 */
export interface InlineAgentSession {
	focus(): void;
	/** Re-fit the terminal to its container after a layout change. */
	fit(): void;
	/** Terminate the process and unmount the terminal. */
	dispose(): Promise<void>;
	/**
	 * Resolves once the prompt has been TYPED into the agent's input — never
	 * submitted. Rejects if the session died before that could happen.
	 */
	primed: Promise<void>;
}

export interface PrimedSessionRequest {
	/** CLI profile id from the host's own `cliProfiles`. */
	cliId: string;
	/** Working directory for the session — the bead's project root. */
	cwd: string;
	/** Extra argv appended to the CLI profile's own args. */
	additionalArgs: string[];
	/** Text typed into the agent's input, WITHOUT a trailing newline. */
	prompt: string;
	/** Tab header, e.g. "kestrel-3gy.84 · Claude". */
	title: string;
}

/**
 * The beads half of the merged plugin. Formerly `BeadsPlugin extends Plugin`;
 * now a plain object owned by the host plugin, so both halves share one
 * manifest, one data.json and one settings tab. Every Obsidian registration it
 * used to make on its own is delegated to the host, which means the host's
 * unload teardown still covers them.
 */
export class BeadsFeature {
	settings!: BeadsSettings;
	readonly app: App;

	private refreshTimer: number | null = null;
	private watcher: FSWatcher | null = null;
	private watchedRoot: string | null = null;
	private watchDebounce: number | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusSeq = 0;

	constructor(
		private host: BeadsHost,
		persisted: Parameters<typeof migrateSettings>[0],
	) {
		this.app = host.app;
		this.settings = migrateSettings(persisted);
	}

	/** Called once from the host's onload, after settings are loaded. */
	load(): void {
		this.detectRoot();

		this.host.registerView(
			VIEW_TYPE_BEADS,
			(leaf) => new BeadsView(leaf, this),
		);

		this.host.registerView(
			VIEW_TYPE_BEADS_EDITOR,
			(leaf) => new BeadEditorView(leaf, this),
		);

		this.host.registerView(
			VIEW_TYPE_BEADS_GRAPH,
			(leaf) => new BeadsGraphView(leaf, this),
		);

		this.host.addRibbonIcon("list-checks", "Open Beads pane", () => {
			void this.activateView();
		});

		// Command ids are namespaced so they cannot collide with the terminal
		// half's ids inside the one shared plugin manifest.
		this.host.addCommand({
			id: "beads-open-pane",
			name: "Beads: open pane",
			callback: () => void this.activateView(),
		});

		this.host.addCommand({
			id: "beads-new-bead",
			name: "Beads: new bead",
			callback: () => void this.newBead(),
		});

		this.host.addCommand({
			id: "beads-refresh",
			name: "Beads: refresh pane",
			callback: () => this.refreshViews(),
		});

		this.host.addCommand({
			id: "beads-open-graph-all",
			name: "Beads: open dependency graph (all issues)",
			callback: () => void this.openGraph({ all: true }),
		});

		registerBeadsCodeBlock(this);

		this.statusBarEl = this.host.addStatusBarItem();
		this.statusBarEl.addClass("beads-statusbar");

		this.restartRefreshTimer();
		this.restartWatch();
		this.updateStatusBar();
	}

	unload(): void {
		this.stopWatch();
	}

	/** Delegated to the host so beads modules can keep calling `plugin.*`. */
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (
			source: string,
			el: HTMLElement,
			ctx: MarkdownPostProcessorContext,
		) => void | Promise<void>,
	): unknown {
		return this.host.registerMarkdownCodeBlockProcessor(language, handler);
	}

	/** Session targets offered in the "Work the bead" menu. */
	sessionTargets(): { id: string; displayName: string }[] {
		return this.host.listSessionTargets();
	}

	async saveSettings(): Promise<void> {
		await this.host.saveSettings();
		// Re-point the filesystem watcher if the active project changed.
		this.restartWatch();
	}

	/** Open (or reveal) the Beads pane in the right sidebar. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_BEADS);
		let leaf: WorkspaceLeaf | null;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({
				type: VIEW_TYPE_BEADS,
				active: true,
			});
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/**
	 * Open a bead in the embedded editor as a main-area tab (like opening a
	 * note). If an editor for the same bead is already open, reveal it instead
	 * of stacking another tab.
	 */
	async openBead(id: string): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_EDITOR)) {
			const state = leaf.getViewState().state as { id?: string } | undefined;
			if (state?.id === id) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { id },
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Open (or reveal) a dependency-graph tab for one epic/issue, or the whole
	 * repo (`{ all: true }`). One tab per distinct scope, same as `openBead`.
	 */
	async openGraph(state: GraphState): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_GRAPH)) {
			const s = leaf.getViewState().state as GraphState | undefined;
			if (!!s?.all === !!state.all && s?.id === state.id) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_GRAPH,
			active: true,
			state: state as Record<string, unknown>,
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * "Work the bead": offer the configured CLI harnesses for `issue`, then show
	 * a preview of the generated prompt. Requires a real click (the `MouseEvent`
	 * anchors the menu) — nothing here ever fires on its own.
	 *
	 * MERGED-PLUGIN CHANGE: the preview now also offers "Open session tab",
	 * which starts the agent in this plugin's own PTY session and TYPES the
	 * prompt into it without submitting. See `harness.ts`.
	 *
	 * `openInlineSession` is supplied only by callers that have somewhere to put
	 * a terminal of their own (the bead editor). When present the preview offers
	 * a third route that runs the agent there instead of in a new tab; the
	 * prompt handling is identical either way.
	 */
	workBead(
		issue: BeadIssue,
		event: MouseEvent,
		openInlineSession?: (request: PrimedSessionRequest) => Promise<void>,
	): void {
		const opts = activeOptions(this.settings);
		const project = activeProject(this.settings);
		if (!opts || !project) {
			new Notice("Beads: add a project and select it first.");
			return;
		}
		showHarnessMenu(this.app, event, issue, {
			opts,
			projectName: project.name || project.path,
			promptTemplate: this.settings.promptTemplate,
			terminalCommand: this.settings.terminalCommand,
			harnesses: this.settings.harnesses,
			sessionTargets: this.sessionTargets(),
			openPrimedSession: (request) => this.host.openPrimedAgentSession(request),
			openInlineSession,
		});
	}

	/**
	 * The bead-agnostic counterpart to `workBead` — a planning session scoped
	 * to the active project rather than one bead, for launching from the graph
	 * view (or anywhere else that isn't a single bead's context).
	 */
	planningSession(event: MouseEvent): void {
		const opts = activeOptions(this.settings);
		const project = activeProject(this.settings);
		if (!opts || !project) {
			new Notice("Beads: add a project and select it first.");
			return;
		}
		showPlanningMenu(this.app, event, {
			opts,
			projectName: project.name || project.path,
			promptTemplate: this.settings.planningPromptTemplate,
			terminalCommand: this.settings.terminalCommand,
			harnesses: this.settings.harnesses,
			sessionTargets: this.sessionTargets(),
			openPrimedSession: (request) => this.host.openPrimedAgentSession(request),
		});
	}

	/** Pass-through so views can embed an agent terminal (see `editor.ts`). */
	mountInlineAgentSession(
		container: HTMLElement,
		request: PrimedSessionRequest,
	): InlineAgentSession {
		return this.host.mountInlineAgentSession(container, request);
	}

	/** Look up a harness profile by id (used by the settings section). */
	findHarness(id: string): HarnessProfile | undefined {
		return this.settings.harnesses.find((h) => h.id === id);
	}

	/**
	 * Open a blank editor tab to create a new bead — optionally pre-linked as a
	 * child of `opts.parent` (hierarchy) or blocked by `opts.blockedBy` (a plain
	 * dependency, for "once I do this, don't let me forget X").
	 */
	async newBead(opts?: { parent?: string; blockedBy?: string }): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { create: true, parent: opts?.parent, blockedBy: opts?.blockedBy },
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Refresh every open Beads pane and graph tab, and the status-bar ready
	 * count.
	 *
	 * Both `BeadsView.refresh()` and the status bar want the same `bd status
	 * --json` summary, so this fetches it ONCE (when at least one pane is
	 * open) and hands the same object to every pane and to `updateStatusBar`,
	 * instead of each independently spawning its own `bd status` process —
	 * this call fires on every refresh-timer tick, every external `.beads`
	 * write, and every save/create/close mutation, so the duplicate spawn was
	 * not a one-off cost.
	 */
	refreshViews(): void {
		// Any open graph tab reloads too — e.g. an agent creating beads in a
		// terminal while a graph is open should make them show up without a
		// manual click. `refreshFromExternalChange` keeps the current pan/zoom
		// instead of re-fitting, since this fires in the background, not from
		// the user asking for a fresh view.
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BEADS_GRAPH)) {
			if (leaf.view instanceof BeadsGraphView) leaf.view.refreshFromExternalChange();
		}

		const views = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BEADS)
			.map((leaf) => leaf.view)
			.filter((v): v is BeadsView => v instanceof BeadsView);

		if (views.length === 0) {
			this.updateStatusBar();
			return;
		}

		const opts = activeOptions(this.settings);
		if (!opts) {
			// keepPagination: true — this path fires from the 30s timer, the
			// .beads watcher, and every mutation, never from the user clicking
			// Refresh, so a page they'd paged further into shouldn't collapse.
			for (const view of views) void view.refresh(undefined, true);
			this.updateStatusBar();
			return;
		}

		void bdStatusCounts(opts)
			.catch(() => ({}) as Record<string, number>)
			.then((counts) => {
				for (const view of views) void view.refresh(counts, true);
				this.updateStatusBar(counts);
			});
	}

	/**
	 * Auto-fill the first project on first load: if no projects are configured
	 * and the vault folder itself contains a `.beads/`, seed one from it. Never
	 * touches a project list the user has already set up.
	 */
	private detectRoot(): void {
		if (this.settings.projects.length > 0) return;
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const base = adapter.getBasePath();
			if (existsSync(join(base, ".beads"))) {
				const project = makeProject(base);
				this.settings.projects = [project];
				this.settings.activeProjectId = project.id;
				void this.saveSettings();
			}
		}
	}

	/**
	 * Switch which project every surface reads from. Only one project is live at
	 * a time — the pane, watcher and status bar all follow this pointer.
	 */
	async setActiveProject(id: string): Promise<void> {
		if (this.settings.activeProjectId === id) return;
		if (!this.settings.projects.some((p) => p.id === id)) return;
		this.settings.activeProjectId = id;
		await this.saveSettings();
		invalidateReadCache();
		this.refreshViews();
	}

	/**
	 * Ambient "● N ready" in the status bar (works even with the pane closed).
	 * Reports the ACTIVE project only — an aggregate across projects would be
	 * both ambiguous (which repo is the number about?) and N subprocess spawns
	 * per refresh tick.
	 *
	 * `precomputedCounts`, when supplied (from `refreshViews()`, which already
	 * fetched the same `bd status` summary for the open panes), skips this
	 * method's own `bd status` call entirely.
	 */
	updateStatusBar(precomputedCounts?: Record<string, number>): void {
		if (!this.statusBarEl) return;
		if (precomputedCounts) {
			this.statusBarEl.setText(`● ${precomputedCounts.ready_issues ?? 0} ready`);
			return;
		}
		const opts = activeOptions(this.settings);
		if (!opts) {
			this.statusBarEl.setText("");
			return;
		}
		// Drop stale results: only the latest request may write the count.
		const my = ++this.statusSeq;
		void bdStatusCounts(opts)
			.then((counts) => {
				if (my === this.statusSeq) this.statusBarEl?.setText(`● ${counts.ready_issues ?? 0} ready`);
			})
			.catch(() => {
				if (my === this.statusSeq) this.statusBarEl?.setText("");
			});
	}

	restartRefreshTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		const secs = this.settings.refreshIntervalSec;
		if (secs > 0) {
			this.refreshTimer = window.setInterval(
				() => this.refreshViews(),
				secs * 1000,
			);
			this.host.registerInterval(this.refreshTimer);
		}
	}

	/**
	 * Watch the `.beads` directory so external `bd` writes refresh the pane.
	 * Only the ACTIVE project is watched: the pane can only show one project at
	 * a time, so a change in an inactive one has nothing on screen to refresh.
	 */
	restartWatch(): void {
		const root = activeProject(this.settings)?.path ?? "";
		if (root === this.watchedRoot && this.watcher) return;
		this.stopWatch();
		this.watchedRoot = root;
		if (!root) return;
		const beadsDir = join(root, ".beads");
		try {
			this.watcher = watch(
				beadsDir,
				{ persistent: false, recursive: false },
				() => this.onBeadsChanged(),
			);
			this.watcher.on("error", () => this.stopWatch());
		} catch {
			// .beads may not exist yet; a later refresh/settings change retries.
			this.watcher = null;
		}
	}

	private onBeadsChanged(): void {
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
		}
		this.watchDebounce = window.setTimeout(() => {
			this.watchDebounce = null;
			// An external bd write changed the DB — drop cached embed reads so
			// code blocks re-render fresh, not from the stale TTL cache.
			invalidateReadCache();
			this.refreshViews();
		}, 400);
	}

	private stopWatch(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
			this.watchDebounce = null;
		}
	}
}
