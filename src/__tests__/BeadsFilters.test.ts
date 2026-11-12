import { describe, it, expect } from "vitest";
import {
	distinctOptions,
	emptyFilters,
	hasActiveFilter,
	matchesFilters,
	statusLabel,
	FilterState,
} from "../beads/filters";
import { BeadIssue } from "../beads/types";

function issue(over: Partial<BeadIssue> = {}): BeadIssue {
	return { id: "kestrel-1", title: "An epic", status: "open", priority: 2, issue_type: "epic", ...over };
}

function filters(over: Partial<FilterState> = {}): FilterState {
	return { ...emptyFilters(), ...over };
}

const EPICS = { epics: true };
const OTHER_TAB = { epics: false };

describe("status filter", () => {
	it("shows only epics in the selected status on the Epics tab", () => {
		const epics = [
			issue({ id: "a", status: "in_progress" }),
			issue({ id: "b", status: "open" }),
			issue({ id: "c", status: "deferred" }),
		];
		const f = filters({ status: "in_progress" });
		expect(epics.filter((e) => matchesFilters(e, f, EPICS)).map((e) => e.id)).toEqual(["a"]);
	});

	it("matches every status when no status is selected", () => {
		for (const status of ["open", "in_progress", "deferred", "closed"]) {
			expect(matchesFilters(issue({ status }), emptyFilters(), EPICS)).toBe(true);
		}
	});

	it("is ignored on other tabs, so a status picked on Epics cannot empty them", () => {
		const f = filters({ status: "in_progress" });
		expect(matchesFilters(issue({ status: "closed" }), f, OTHER_TAB)).toBe(true);
	});

	it("combines with the other filters (AND)", () => {
		const f = filters({ status: "in_progress", assignee: "Corey Wynn" });
		expect(matchesFilters(issue({ status: "in_progress", assignee: "Corey Wynn" }), f, EPICS)).toBe(true);
		expect(matchesFilters(issue({ status: "in_progress", assignee: "Someone Else" }), f, EPICS)).toBe(false);
		expect(matchesFilters(issue({ status: "open", assignee: "Corey Wynn" }), f, EPICS)).toBe(false);
	});

	it("falls back to owner for the assignee filter when assignee is unset", () => {
		const f = filters({ assignee: "corey@example.com", status: "open" });
		expect(matchesFilters(issue({ owner: "corey@example.com" }), f, EPICS)).toBe(true);
	});
});

describe("hasActiveFilter", () => {
	it("counts the status filter only where it applies", () => {
		const f = filters({ status: "deferred" });
		expect(hasActiveFilter(f, EPICS)).toBe(true);
		expect(hasActiveFilter(f, OTHER_TAB)).toBe(false);
	});

	it("is false for empty filters and a whitespace-only search", () => {
		expect(hasActiveFilter(emptyFilters(), EPICS)).toBe(false);
		expect(hasActiveFilter(filters({ search: "   " }), EPICS)).toBe(false);
	});
});

describe("distinctOptions statuses", () => {
	it("offers only statuses present, active work first", () => {
		const opts = distinctOptions([
			issue({ status: "closed" }),
			issue({ status: "deferred" }),
			issue({ status: "open" }),
			issue({ status: "in_progress" }),
			issue({ status: "open" }),
		]);
		expect(opts.statuses).toEqual(["in_progress", "open", "deferred", "closed"]);
	});

	it("sorts statuses it does not know after the known ones", () => {
		const opts = distinctOptions([issue({ status: "pinned" }), issue({ status: "open" }), issue({ status: "hooked" })]);
		expect(opts.statuses).toEqual(["open", "hooked", "pinned"]);
	});

	it("is empty for no issues", () => {
		expect(distinctOptions([]).statuses).toEqual([]);
	});
});

describe("statusLabel", () => {
	it("turns bd's snake_case into words", () => {
		expect(statusLabel("in_progress")).toBe("in progress");
		expect(statusLabel("open")).toBe("open");
	});
});

describe("author merging", () => {
	it("merges an owner email with the same person's assignee name and prefers the name", () => {
		const opts = distinctOptions(
			[issue({ owner: "Corey.Wynn@kestrelintelligence.com" }), issue({ assignee: "Corey Wynn" })],
			["genesis.velazquezreyes@kestrelintelligence.com"],
		);
		expect(opts.assignees).toEqual(["Corey Wynn", "Genesis Velazquezreyes"]);
	});
	it("filters by person across email and name forms", () => {
		const f = filters({ assignee: "Corey Wynn" });
		expect(matchesFilters(issue({ owner: "Corey.Wynn@kestrelintelligence.com" }), f, OTHER_TAB)).toBe(true);
		expect(matchesFilters(issue({ owner: "abraham.edens@kestrelintelligence.com" }), f, OTHER_TAB)).toBe(false);
	});
});
