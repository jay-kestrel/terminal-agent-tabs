import { setIcon } from "obsidian";
import { BeadIssue } from "./types";

const PRIORITY_NAME: Record<number, string> = {
	0: "P0 · critical",
	1: "P1 · high",
	2: "P2 · medium",
	3: "P3 · low",
	4: "P4 · backlog",
};

export interface RowHandlers {
	/** Row click — open the bead. */
	onOpen: (issue: BeadIssue) => void;
	/** Show a "⛓ n" dependency-count hint (blocked list only). */
	showDeps?: boolean;
	/** Epic rows only: click-through to that epic's dependency graph. */
	onGraph?: (issue: BeadIssue) => void;
	/** Hand the bead to a CLI coding agent (menu anchored on the click). */
	onWork?: (issue: BeadIssue, event: MouseEvent) => void;
}

/** A small colored priority dot (native-restrained) with the label on hover. */
export function renderPriorityDot(parent: HTMLElement, priority: number): void {
	const pr = priority ?? 2;
	const dot = parent.createSpan({ cls: `beads-dot beads-p${pr}` });
	const name = PRIORITY_NAME[pr] ?? `P${pr}`;
	dot.setAttribute("aria-label", name);
	dot.setAttribute("title", name);
}

/**
 * The single row component used by the pane and the `beads` code block. All
 * bead-derived text is set via `text:` (inert `textContent`) — never HTML.
 * The whole row is clickable; there is no checkbox (close/reopen happens in the
 * bead editor via its status field).
 */
export function renderIssueRow(
	parent: HTMLElement,
	issue: BeadIssue,
	handlers: RowHandlers,
): void {
	const row = parent.createDiv({ cls: "beads-row" });
	if (issue.status === "closed") row.addClass("beads-row-closed");

	renderPriorityDot(row, issue.priority ?? 2);

	const main = row.createDiv({ cls: "beads-main" });
	main.createDiv({ cls: "beads-title", text: issue.title });
	const meta = main.createDiv({ cls: "beads-meta" });
	meta.createSpan({ cls: "beads-id", text: issue.id });
	if (issue.issue_type) {
		meta.createSpan({ cls: "beads-type", text: issue.issue_type });
	}
	if (handlers.showDeps && (issue.dependency_count ?? 0) > 0) {
		meta.createSpan({
			cls: "beads-deps",
			text: `⛓ ${issue.dependency_count}`,
		});
	}

	if (handlers.onWork && issue.status !== "closed") {
		const workBtn = row.createEl("button", {
			cls: "clickable-icon beads-work-btn",
			attr: { "aria-label": "Work the bead", title: "Work the bead" },
		});
		setIcon(workBtn, "bot");
		workBtn.onclick = (e) => {
			e.stopPropagation(); // don't also open the bead editor
			handlers.onWork?.(issue, e);
		};
	}

	if (handlers.onGraph && issue.issue_type === "epic") {
		const graphBtn = row.createEl("button", {
			cls: "clickable-icon beads-graph-btn",
			attr: { "aria-label": "View dependency graph" },
		});
		setIcon(graphBtn, "git-fork");
		graphBtn.onclick = (e) => {
			e.stopPropagation();
			handlers.onGraph?.(issue);
		};
	}

	row.onclick = () => handlers.onOpen(issue);
}
