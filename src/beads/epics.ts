import { setIcon } from "obsidian";
import { BeadIssue } from "./types";
import { BdEpicStatus } from "./bd";
import { renderIssueRow, renderPriorityDot } from "./row";

/**
 * Per-status rollup buckets shown on an expanded epic, in display order.
 *
 * NOTE: `bd epic status` rolls up only closed-vs-total, so the collapsed row
 * uses bd's numbers directly and this finer split is counted off the child
 * records `bd children` already returns — no extra bd calls, no re-walking of
 * the parent-child graph.
 */
const ROLLUP_BUCKETS: { status: string; label: string }[] = [
	{ status: "in_progress", label: "in progress" },
	{ status: "open", label: "open" },
	// No "blocked" bucket: dependency-blocked issues keep `status=open` in bd,
	// so it would always read 0 here. Use the Blocked tab for that set.
	{ status: "deferred", label: "deferred" },
	{ status: "closed", label: "closed" },
];

export interface EpicsState {
	epics: BdEpicStatus[];
	/** Children per epic id, fetched lazily on first expand. */
	children: Record<string, BeadIssue[]>;
	/** Epic ids whose children are currently showing. */
	expanded: Set<string>;
	/** Epic ids with an in-flight `bd children` call. */
	loadingChildren: Set<string>;
	loaded: boolean;
	loading: boolean;
	error?: string;
}

export function emptyEpicsState(): EpicsState {
	return {
		epics: [],
		children: {},
		expanded: new Set(),
		loadingChildren: new Set(),
		loaded: false,
		loading: false,
	};
}

export interface EpicsHandlers {
	/** Expand / collapse one epic (loads its children on first expand). */
	onToggle: (id: string) => void;
	/** Open a bead (epic or child) in the bead editor. */
	onOpen: (issue: BeadIssue) => void;
	/** Open the dependency graph scoped to one epic. */
	onGraph: (issue: BeadIssue) => void;
	/** Open a new-bead form pre-linked as this epic's child. */
	onAddChild: (issue: BeadIssue) => void;
}

function countByStatus(children: BeadIssue[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const c of children) {
		counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
	}
	return counts;
}

function byPriority(issues: BeadIssue[]): BeadIssue[] {
	return issues
		.slice()
		.sort(
			(a, b) =>
				(a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id),
		);
}

/** The clickable epic header: chevron, priority, title, and bd's rollup. */
function renderEpicHead(
	parent: HTMLElement,
	entry: BdEpicStatus,
	expanded: boolean,
	handlers: EpicsHandlers,
): void {
	const { epic, total_children: total, closed_children: closed } = entry;
	const head = parent.createDiv({ cls: "beads-epic-head" });
	head.toggleClass("is-expanded", expanded);

	const chevron = head.createSpan({ cls: "beads-epic-chevron" });
	setIcon(chevron, expanded ? "chevron-down" : "chevron-right");

	renderPriorityDot(head, epic.priority ?? 2);

	const main = head.createDiv({ cls: "beads-main" });
	main.createDiv({ cls: "beads-title", text: epic.title });
	const meta = main.createDiv({ cls: "beads-meta" });
	meta.createSpan({ cls: "beads-id", text: epic.id });
	meta.createSpan({
		cls: "beads-epic-progress-text",
		text: total > 0 ? `${closed}/${total} closed` : "no children",
	});
	if (entry.eligible_for_close) {
		meta.createSpan({ cls: "beads-epic-eligible", text: "ready to close" });
	}
	if (total > 0) {
		const bar = main.createDiv({ cls: "beads-epic-bar" });
		const fill = bar.createDiv({ cls: "beads-epic-bar-fill" });
		fill.style.width = `${Math.round((closed / total) * 100)}%`;
	}

	const openBtn = head.createEl("button", {
		cls: "clickable-icon beads-epic-open-btn",
		attr: { "aria-label": "Open epic" },
	});
	setIcon(openBtn, "square-arrow-out-up-right");
	openBtn.onclick = (e) => {
		e.stopPropagation();
		handlers.onOpen(epic);
	};

	const graphBtn = head.createEl("button", {
		cls: "clickable-icon beads-graph-btn",
		attr: { "aria-label": "View dependency graph" },
	});
	setIcon(graphBtn, "git-fork");
	graphBtn.onclick = (e) => {
		e.stopPropagation();
		handlers.onGraph(epic);
	};

	const addBtn = head.createEl("button", {
		cls: "clickable-icon beads-add-child-btn",
		attr: { "aria-label": "Add child bead" },
	});
	setIcon(addBtn, "plus");
	addBtn.onclick = (e) => {
		e.stopPropagation();
		handlers.onAddChild(epic);
	};

	head.onclick = () => handlers.onToggle(epic.id);
}

/**
 * The Epics tab body: every open epic with its child rollup, each expandable
 * in place into its own children. Rows for individual children come from the
 * shared `renderIssueRow`, so a child looks and behaves exactly as it does in
 * the Ready / Blocked / Closed tabs.
 */
export function renderEpics(
	body: HTMLElement,
	state: EpicsState,
	handlers: EpicsHandlers,
): void {
	if (state.error) {
		body.createDiv({ cls: "beads-empty beads-error", text: state.error });
		return;
	}
	if (state.loading && state.epics.length === 0) {
		body.createDiv({ cls: "beads-empty", text: "Loading…" });
		return;
	}
	if (state.epics.length === 0) {
		body.createDiv({ cls: "beads-empty", text: "No open epics." });
		return;
	}

	const list = body.createDiv({ cls: "beads-list" });
	for (const entry of state.epics) {
		const id = entry.epic.id;
		const expanded = state.expanded.has(id);
		const group = list.createDiv({ cls: "beads-epic" });
		renderEpicHead(group, entry, expanded, handlers);
		if (!expanded) continue;

		const kids = group.createDiv({ cls: "beads-epic-children" });
		if (state.loadingChildren.has(id) && !state.children[id]) {
			kids.createDiv({ cls: "beads-empty", text: "Loading…" });
			continue;
		}
		const children = state.children[id] ?? [];
		if (children.length === 0) {
			kids.createDiv({ cls: "beads-empty", text: "No children." });
			continue;
		}

		const counts = countByStatus(children);
		const chips = kids.createDiv({ cls: "beads-epic-rollup" });
		for (const bucket of ROLLUP_BUCKETS) {
			const n = counts.get(bucket.status);
			if (!n) continue;
			chips.createSpan({
				cls: `beads-epic-chip beads-epic-chip-${bucket.status}`,
				text: `${n} ${bucket.label}`,
			});
		}

		for (const child of byPriority(children)) {
			renderIssueRow(kids, child, {
				onOpen: (i) => handlers.onOpen(i),
				onGraph: (i) => handlers.onGraph(i),
				onAddChild: (i) => handlers.onAddChild(i),
			});
		}
	}
}
