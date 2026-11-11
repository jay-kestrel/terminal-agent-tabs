import { BeadIssue } from "./types";

/**
 * Client-side filter state for the active tab's list. Empty string = no
 * constraint on that field. Kept simple on purpose: this is a plain
 * "every selected field must match" AND — bd's own query language already
 * handles real boolean expressions (see `bd query --help` / codeblock.ts's
 * `query:` directive), so there's no reason to reinvent that here for a
 * handful of dropdowns worth of state.
 *
 * Pure (no Obsidian API) so it can be unit-tested.
 */
export interface FilterState {
	label: string;
	assignee: string;
	priority: string;
	type: string;
	/**
	 * Status of the row itself. Applied on the Epics tab only: every other tab
	 * is already one status (or bd-derived readiness), so a status filter carried
	 * across a tab switch would just empty those lists.
	 */
	status: string;
	/** Free-text substring match against id + title, case-insensitive. */
	search: string;
}

/** Which tab the filters are being applied for. */
export interface FilterScope {
	/** True on the Epics tab — the only tab the status filter applies to. */
	epics: boolean;
}

export function emptyFilters(): FilterState {
	return { label: "", assignee: "", priority: "", type: "", status: "", search: "" };
}

/** True when any filter that applies in `scope` is set (drives "Clear filters"). */
export function hasActiveFilter(f: FilterState, scope: FilterScope): boolean {
	return (
		f.label !== "" ||
		f.assignee !== "" ||
		f.priority !== "" ||
		f.type !== "" ||
		(scope.epics && f.status !== "") ||
		f.search.trim() !== ""
	);
}

/** The assignee shown/filtered on: `assignee` if set, else `owner`. */
export function issueAssignee(issue: BeadIssue): string {
	return issue.assignee || issue.owner || "";
}

export function matchesFilters(issue: BeadIssue, f: FilterState, scope: FilterScope): boolean {
	if (f.label && !(issue.labels ?? []).includes(f.label)) return false;
	if (f.assignee && issueAssignee(issue) !== f.assignee) return false;
	if (f.priority && String(issue.priority ?? 2) !== f.priority) return false;
	if (f.type && issue.issue_type !== f.type) return false;
	if (scope.epics && f.status && issue.status !== f.status) return false;
	const q = f.search.trim().toLowerCase();
	if (q && !issue.id.toLowerCase().includes(q) && !issue.title.toLowerCase().includes(q)) return false;
	return true;
}

/** Display order for the status dropdown: active work first, parked/done last. */
const STATUS_ORDER = ["in_progress", "open", "blocked", "deferred", "closed"];

/** Human label for a bd status value (`in_progress` → `in progress`). */
export function statusLabel(status: string): string {
	return status.replace(/_/g, " ");
}

function byStatusOrder(a: string, b: string): number {
	const ia = STATUS_ORDER.indexOf(a);
	const ib = STATUS_ORDER.indexOf(b);
	// Statuses bd adds later (unknown here) sort after the known ones, alphabetically.
	return (ia === -1 ? STATUS_ORDER.length : ia) - (ib === -1 ? STATUS_ORDER.length : ib) || a.localeCompare(b);
}

/**
 * Distinct values present in the currently-loaded issue set, for populating
 * the filter dropdowns. Deliberately scoped to what's loaded (not a separate
 * bd call to enumerate every label/assignee in the project) — the pane already
 * paginates, so "options visible right now" is the honest set to offer; a
 * value that hasn't loaded yet naturally appears once "Load more" brings it in.
 */
export function distinctOptions(issues: BeadIssue[]) {
	const labels = new Set<string>();
	const assignees = new Set<string>();
	const types = new Set<string>();
	const statuses = new Set<string>();
	const priorities = new Set<number>();
	for (const issue of issues) {
		for (const l of issue.labels ?? []) labels.add(l);
		const a = issueAssignee(issue);
		if (a) assignees.add(a);
		if (issue.issue_type) types.add(issue.issue_type);
		if (issue.status) statuses.add(issue.status);
		priorities.add(issue.priority ?? 2);
	}
	return {
		labels: Array.from(labels).sort(),
		assignees: Array.from(assignees).sort(),
		types: Array.from(types).sort(),
		statuses: Array.from(statuses).sort(byStatusOrder),
		priorities: Array.from(priorities).sort((a, b) => a - b),
	};
}
