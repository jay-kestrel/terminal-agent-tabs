import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type { BeadsFeature as BeadsPlugin } from "./feature";
import { activeOptions } from "./settings";
import { BeadIssue, PRIORITIES, VIEW_TYPE_BEADS } from "./types";
import {
	bdReady,
	bdBlocked,
	bdByStatus,
	bdChildren,
	bdEpicStatus,
	bdStatusCounts,
	BdError,
	BdOptions,
} from "./bd";
import { renderIssueRow } from "./row";
import { EpicsState, emptyEpicsState, renderEpics } from "./epics";

interface TabDef {
	key: string;
	label: string;
	/** Key in `bd status --json`'s summary block; omitted = no count badge. */
	countKey?: string;
}

/** The Epics tab is state-shaped differently (see EpicsState) — special-cased. */
const EPICS_TAB = "epics";

const TABS: TabDef[] = [
	{ key: "ready", label: "Ready", countKey: "ready_issues" },
	{ key: "in_progress", label: "In progress", countKey: "in_progress_issues" },
	{ key: "blocked", label: "Blocked", countKey: "blocked_issues" },
	{ key: EPICS_TAB, label: "Epics" },
	{ key: "closed", label: "Closed", countKey: "closed_issues" },
];
const PAGE = 25;

interface TabState {
	issues: BeadIssue[];
	limit: number;
	hasMore: boolean;
	loaded: boolean;
	loading: boolean;
	error?: string;
}

function byPriority(issues: BeadIssue[]): BeadIssue[] {
	return issues
		.slice()
		.sort(
			(a, b) =>
				(a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id),
		);
}

/**
 * Client-side filter state for the active tab's list. Empty string = no
 * constraint on that field. Kept simple on purpose: this is a plain
 * "every selected field must match" AND — bd's own query language already
 * handles real boolean expressions (see `bd query --help` / codeblock.ts's
 * `query:` directive), so there's no reason to reinvent that here for four
 * dropdowns worth of state.
 */
interface FilterState {
	label: string;
	assignee: string;
	priority: string;
	type: string;
	/** Free-text substring match against id + title, case-insensitive. */
	search: string;
}

function emptyFilters(): FilterState {
	return { label: "", assignee: "", priority: "", type: "", search: "" };
}

function hasActiveFilter(f: FilterState): boolean {
	return (
		f.label !== "" || f.assignee !== "" || f.priority !== "" || f.type !== "" || f.search.trim() !== ""
	);
}

/** The assignee shown/filtered on: `assignee` if set, else `owner`. */
function issueAssignee(issue: BeadIssue): string {
	return issue.assignee || issue.owner || "";
}

function matchesFilters(issue: BeadIssue, f: FilterState): boolean {
	if (f.label && !(issue.labels ?? []).includes(f.label)) return false;
	if (f.assignee && issueAssignee(issue) !== f.assignee) return false;
	if (f.priority && String(issue.priority ?? 2) !== f.priority) return false;
	if (f.type && issue.issue_type !== f.type) return false;
	const q = f.search.trim().toLowerCase();
	if (q && !issue.id.toLowerCase().includes(q) && !issue.title.toLowerCase().includes(q)) return false;
	return true;
}

/**
 * Distinct values present in the currently-loaded issue set, for populating
 * the filter dropdowns. Deliberately scoped to what's loaded (not a separate
 * bd call to enumerate every label/assignee in the project) — the pane already
 * paginates, so "options visible right now" is the honest set to offer; a
 * value that hasn't loaded yet naturally appears once "Load more" brings it in.
 */
function distinctOptions(issues: BeadIssue[]) {
	const labels = new Set<string>();
	const assignees = new Set<string>();
	const types = new Set<string>();
	const priorities = new Set<number>();
	for (const issue of issues) {
		for (const l of issue.labels ?? []) labels.add(l);
		const a = issueAssignee(issue);
		if (a) assignees.add(a);
		if (issue.issue_type) types.add(issue.issue_type);
		priorities.add(issue.priority ?? 2);
	}
	return {
		labels: Array.from(labels).sort(),
		assignees: Array.from(assignees).sort(),
		types: Array.from(types).sort(),
		priorities: Array.from(priorities).sort((a, b) => a - b),
	};
}

/**
 * Tabbed, lazily-loaded pane. Only the active tab hits `bd` (plus one cheap
 * `bd status` for the tab counts), and each tab paginates with "Load more" —
 * so opening the pane is fast even with thousands of closed issues.
 */
export class BeadsView extends ItemView {
	private active = "ready";
	private counts: Record<string, number> = {};
	private tabs: Record<string, TabState> = {};
	private epics: EpicsState = emptyEpicsState();
	private baseState: "ok" | "no-root" | "no-db" = "no-root";
	private loadSeq = 0;
	/** Label/assignee/priority/type filter for the active tab's list (Epics tab excluded). */
	private filters: FilterState = emptyFilters();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	private emptyTab(): TabState {
		return { issues: [], limit: PAGE, hasMore: false, loaded: false, loading: false };
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS;
	}
	getDisplayText(): string {
		return "Beads";
	}
	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.refresh();
	}

	onClose(): Promise<void> {
		// Synchronous teardown, kept Promise-returning to match ItemView.onClose.
		// (Was `async` in the standalone plugin; the merged repo's eslint config
		// errors on an async function with no await.)
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
		this.epics = emptyEpicsState();
		return Promise.resolve();
	}

	/** Whether the active tab has an in-flight load (drives the spinner). */
	private isLoading(): boolean {
		return this.active === EPICS_TAB
			? this.epics.loading
			: this.tabs[this.active].loading;
	}

	private resolveOpts(): BdOptions | null {
		const opts = activeOptions(this.plugin.settings);
		if (!opts) {
			this.baseState = "no-root";
			return null;
		}
		if (!existsSync(join(opts.cwd, ".beads"))) {
			this.baseState = "no-db";
			return null;
		}
		this.baseState = "ok";
		return opts;
	}

	/** Full refresh: re-count and re-load the active tab; drop cached tabs. */
	async refresh(): Promise<void> {
		for (const t of TABS) {
			this.tabs[t.key].loaded = false;
			this.tabs[t.key].limit = PAGE;
		}
		this.filters = emptyFilters();
		// Keep which epics are open across a refresh; drop their cached children
		// so an expanded epic re-reads from bd instead of showing stale rows.
		this.epics.loaded = false;
		this.epics.children = {};
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const seq = ++this.loadSeq;
		try {
			this.counts = await bdStatusCounts(opts);
		} catch {
			/* counts are optional chrome */
		}
		if (seq !== this.loadSeq) return;
		await this.loadTab(this.active, seq);
	}

	private fetchTab(
		key: string,
		opts: BdOptions,
		limit: number,
	): Promise<BeadIssue[]> {
		switch (key) {
			case "ready":
				return bdReady(opts, limit);
			case "in_progress":
				return bdByStatus(opts, "in_progress", limit);
			case "closed":
				return bdByStatus(opts, "closed", limit);
			case "blocked":
				return bdBlocked(opts); // no server-side limit; paginated client-side
			default:
				return Promise.resolve([]);
		}
	}

	/**
	 * `bd epic status --json` in one call — bd already knows every epic and its
	 * closed/total child rollup, so nothing is recomputed here. Children are
	 * fetched separately, only for epics the user actually expands.
	 */
	private async loadEpics(seq?: number): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const mySeq = seq ?? ++this.loadSeq;
		this.epics.loading = true;
		this.epics.error = undefined;
		this.render();
		try {
			const entries = await bdEpicStatus(opts);
			if (mySeq !== this.loadSeq) return;
			this.epics.epics = entries;
			this.epics.loaded = true;
			// Re-fill children for epics that were left expanded by a refresh.
			for (const id of this.epics.expanded) {
				if (!this.epics.children[id]) void this.loadChildren(id, mySeq);
			}
		} catch (e) {
			if (mySeq !== this.loadSeq) return;
			this.epics.error = e instanceof BdError ? e.message : String(e);
		} finally {
			if (mySeq === this.loadSeq) {
				this.epics.loading = false;
				this.render();
			}
		}
	}

	/** `bd children --json -- <id>` for one epic, cached until the next refresh. */
	private async loadChildren(id: string, seq: number): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts || this.epics.loadingChildren.has(id)) return;
		this.epics.loadingChildren.add(id);
		this.render();
		try {
			const children = await bdChildren(opts, id);
			if (seq !== this.loadSeq) return;
			this.epics.children[id] = children;
		} catch (e) {
			if (seq !== this.loadSeq) return;
			this.epics.error = e instanceof BdError ? e.message : String(e);
		} finally {
			this.epics.loadingChildren.delete(id);
			if (seq === this.loadSeq) this.render();
		}
	}

	private toggleEpic(id: string): void {
		if (this.epics.expanded.has(id)) {
			this.epics.expanded.delete(id);
			this.render();
			return;
		}
		this.epics.expanded.add(id);
		if (this.epics.children[id]) this.render(); // cached → instant
		else void this.loadChildren(id, this.loadSeq);
	}

	private async loadTab(key: string, seq?: number): Promise<void> {
		if (key === EPICS_TAB) {
			await this.loadEpics(seq);
			return;
		}
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const mySeq = seq ?? ++this.loadSeq;
		const tab = this.tabs[key];
		tab.loading = true;
		tab.error = undefined;
		this.render();
		try {
			const fetched = await this.fetchTab(key, opts, tab.limit);
			if (mySeq !== this.loadSeq) return;
			const sorted = byPriority(fetched);
			if (key === "blocked") {
				tab.hasMore = sorted.length > tab.limit;
				tab.issues = sorted.slice(0, tab.limit);
			} else {
				tab.hasMore = fetched.length === tab.limit;
				tab.issues = sorted;
			}
			tab.loaded = true;
		} catch (e) {
			if (mySeq !== this.loadSeq) return;
			tab.error = e instanceof BdError ? e.message : String(e);
		} finally {
			if (mySeq === this.loadSeq) {
				tab.loading = false;
				this.render();
			}
		}
	}

	private async switchTab(key: string): Promise<void> {
		if (this.active === key) return;
		this.active = key;
		this.filters = emptyFilters();
		const loaded = key === EPICS_TAB ? this.epics.loaded : this.tabs[key].loaded;
		if (loaded) this.render(); // cached → instant
		else await this.loadTab(key);
	}

	private async loadMore(): Promise<void> {
		this.tabs[this.active].limit += PAGE;
		await this.loadTab(this.active);
	}

	private openBead(issue: BeadIssue): void {
		void this.plugin.openBead(issue.id);
	}

	// --- render ---------------------------------------------------------

	/**
	 * Project switcher: takes the slot the static "Beads" title used to occupy,
	 * so the pane always names the project it is showing. Falls back to the
	 * plain title when nothing is configured yet.
	 */
	private renderProjectPicker(header: HTMLElement): void {
		const s = this.plugin.settings;
		if (s.projects.length === 0) {
			header.createDiv({ cls: "beads-header-title", text: "Beads" });
			return;
		}
		const select = header.createEl("select", {
			cls: "dropdown beads-project-select",
			attr: { "aria-label": "Active project" },
		});
		for (const project of s.projects) {
			const option = select.createEl("option", {
				value: project.id,
				text: project.name || project.path || "(unnamed)",
			});
			option.selected = project.id === s.activeProjectId;
		}
		select.onchange = () => void this.plugin.setActiveProject(select.value);
	}

	/**
	 * Compact filter bar for the active tab's list: label / assignee / priority
	 * / type, each populated from the distinct values in the currently-loaded
	 * issue set (not a fixed list, not a separate bd call). Client-side, not a
	 * `bd query` expression — see the module-level `FilterState` doc for why.
	 */
	private renderFilterBar(body: HTMLElement, issues: BeadIssue[]): void {
		const opts = distinctOptions(issues);
		const bar = body.createDiv({ cls: "beads-filterbar" });

		const search = bar.createEl("input", {
			cls: "beads-filter-search",
			attr: { type: "search", placeholder: "Search…" },
		});
		search.value = this.filters.search;
		search.oninput = () => {
			const cursor = search.selectionStart;
			this.filters.search = search.value;
			this.render(); // rebuilds the whole pane, including this input — restore focus/cursor below
			const restored = this.contentEl.querySelector<HTMLInputElement>(".beads-filter-search");
			restored?.focus();
			if (restored && cursor !== null) restored.setSelectionRange(cursor, cursor);
		};

		const addSelect = (
			label: string,
			value: string,
			choices: { value: string; text: string }[],
			onChange: (v: string) => void,
		): void => {
			const select = bar.createEl("select", {
				cls: "dropdown beads-filter-select",
				attr: { "aria-label": label },
			});
			const allOption = select.createEl("option", { value: "", text: label });
			allOption.selected = value === "";
			for (const c of choices) {
				const option = select.createEl("option", { value: c.value, text: c.text });
				option.selected = c.value === value;
			}
			select.onchange = () => {
				onChange(select.value);
				this.render();
			};
		};

		addSelect(
			"All labels",
			this.filters.label,
			opts.labels.map((l) => ({ value: l, text: l })),
			(v) => (this.filters.label = v),
		);
		addSelect(
			"All authors",
			this.filters.assignee,
			opts.assignees.map((a) => ({ value: a, text: a })),
			(v) => (this.filters.assignee = v),
		);
		addSelect(
			"All priorities",
			this.filters.priority,
			opts.priorities.map((p) => ({
				value: String(p),
				text: PRIORITIES.find((x) => x.value === p)?.label ?? `P${p}`,
			})),
			(v) => (this.filters.priority = v),
		);
		addSelect(
			"All types",
			this.filters.type,
			opts.types.map((t) => ({ value: t, text: t })),
			(v) => (this.filters.type = v),
		);

		if (hasActiveFilter(this.filters)) {
			const clear = bar.createEl("button", {
				cls: "beads-filter-clear",
				text: "Clear filters",
			});
			clear.onclick = () => {
				this.filters = emptyFilters();
				this.render();
			};
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-pane");

		// Header
		const header = root.createDiv({ cls: "beads-header" });
		this.renderProjectPicker(header);
		const actions = header.createDiv({ cls: "beads-header-actions" });
		const captureBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Capture a bead" },
		});
		setIcon(captureBtn, "plus");
		captureBtn.onclick = () => void this.plugin.newBead();
		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.toggleClass("beads-spin", this.isLoading());
		refreshBtn.onclick = () => void this.refresh();

		if (this.baseState === "no-root") {
			root.createDiv({
				cls: "beads-empty",
				text: "No project set. Open Beads settings and add a project pointing at a directory containing .beads/.",
			});
			return;
		}
		if (this.baseState === "no-db") {
			root.createDiv({
				cls: "beads-empty",
				text: "No bd database here — this folder has no .beads/. Check the project path in Beads settings.",
			});
			return;
		}

		// Tab bar
		const tabBar = root.createDiv({ cls: "beads-tabs" });
		for (const t of TABS) {
			const btn = tabBar.createEl("button", { cls: "beads-tab" });
			btn.toggleClass("is-active", t.key === this.active);
			btn.createSpan({ text: t.label });
			const n = t.countKey ? this.counts[t.countKey] : undefined;
			if (typeof n === "number") {
				btn.createSpan({ cls: "beads-tab-count", text: String(n) });
			}
			btn.onclick = () => void this.switchTab(t.key);
		}

		// Active tab content
		const body = root.createDiv({ cls: "beads-tab-body" });

		if (this.active === EPICS_TAB) {
			renderEpics(body, this.epics, {
				onToggle: (id) => this.toggleEpic(id),
				onOpen: (i) => this.openBead(i),
				onGraph: (i) => void this.plugin.openGraph({ id: i.id }),
				onAddChild: (i) => void this.plugin.newBead({ parent: i.id }),
				onAddDependent: (i) => void this.plugin.newBead({ blockedBy: i.id }),
			});
			return;
		}

		const tab = this.tabs[this.active];

		if (tab.error) {
			body.createDiv({ cls: "beads-empty beads-error", text: tab.error });
			return;
		}
		if (tab.loading && tab.issues.length === 0) {
			body.createDiv({ cls: "beads-empty", text: "Loading…" });
			return;
		}
		if (tab.issues.length === 0) {
			body.createDiv({
				cls: "beads-empty",
				text: this.active === "ready" ? "Nothing ready 🎉" : "Nothing here.",
			});
			return;
		}

		this.renderFilterBar(body, tab.issues);
		const visible = tab.issues.filter((i) => matchesFilters(i, this.filters));

		if (visible.length === 0) {
			body.createDiv({
				cls: "beads-empty",
				text: "No issues match the current filters.",
			});
			return;
		}

		const list = body.createDiv({ cls: "beads-list" });
		for (const issue of visible) {
			renderIssueRow(list, issue, {
				onOpen: (i) => this.openBead(i),
				showDeps: this.active === "blocked",
				onGraph: (i) => void this.plugin.openGraph({ id: i.id }),
				onWork: (i, e) => this.plugin.workBead(i, e),
				onAddChild: (i) => void this.plugin.newBead({ parent: i.id }),
				onAddDependent: (i) => void this.plugin.newBead({ blockedBy: i.id }),
			});
		}

		if (tab.hasMore) {
			const more = body.createEl("button", {
				cls: "beads-loadmore",
				text: tab.loading ? "Loading…" : "Load more",
			});
			more.disabled = tab.loading;
			more.onclick = () => void this.loadMore();
		}
	}
}
