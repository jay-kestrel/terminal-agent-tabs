import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * These pin the ARGV bd is invoked with, because that is exactly where the
 * "closed epic is invisible in the pane" bug lived: the pane was asking bd for
 * one 25-row page and then filtering it client-side, so a bead sitting at row
 * 134 of 628 could not be found by searching — and the empty result rendered
 * identically to the bead not existing.
 *
 * Asserting on argv (rather than on rendered rows) is deliberate: the defect
 * was never in the parsing or the drawing, it was in the question asked.
 */

const calls: string[][] = [];

vi.mock("child_process", () => ({
	execFile: (
		_bin: string,
		args: string[],
		_opts: unknown,
		cb: (e: null, stdout: string, stderr: string) => void,
	) => {
		calls.push(args);
		cb(null, "[]", "");
		return { kill: () => undefined };
	},
}));

import { bdByStatus, bdSearch, bdEpicStatus } from "../beads/bd";

const OPTS = { bdPath: "bd", cwd: "/repo" };

/** The one call made during this test, as a single string for easy matching. */
function lastArgv(): string {
	return calls[calls.length - 1].join(" ");
}

beforeEach(() => {
	calls.length = 0;
});

describe("bdByStatus", () => {
	it("passes --sort through to bd so ordering happens before the limit", async () => {
		await bdByStatus(OPTS, "closed", 25, "closed");
		// Not `.toContain("--sort")` alone: the point is that bd does the sorting
		// while it still has all 628 rows. Sorting the returned 25 client-side
		// would look identical in the UI and be wrong.
		expect(lastArgv()).toBe(
			"list --status closed --json --no-pager --limit 25 --sort closed",
		);
	});

	it("omits --sort entirely when no sort is asked for", async () => {
		await bdByStatus(OPTS, "in_progress", 25);
		expect(lastArgv()).toBe(
			"list --status in_progress --json --no-pager --limit 25",
		);
	});
});

describe("bdSearch", () => {
	it("asks bd to search, scoped to a status, rather than filtering a page", async () => {
		await bdSearch(OPTS, "gryt", "closed", 500);
		expect(lastArgv()).toBe("search --json --status closed --limit 500 -- gryt");
	});

	it("puts the query after `--` so a query starting with a dash is not a flag", async () => {
		await bdSearch(OPTS, "--version", "all", 500);
		const args = calls[calls.length - 1];
		// If `--` were dropped, bd would parse this as its own flag and the
		// search would either error or return something unrelated.
		expect(args[args.length - 2]).toBe("--");
		expect(args[args.length - 1]).toBe("--version");
	});

	it("can span every status, since bd excludes closed by default", async () => {
		await bdSearch(OPTS, "gryt", "all", 500);
		expect(lastArgv()).toContain("--status all");
	});
});

describe("bdEpicStatus", () => {
	it("asks for epics without filtering closed ones out", async () => {
		await bdEpicStatus(OPTS);
		// bd returns closed epics too. A source comment used to claim otherwise,
		// which sent a search for a missing closed epic looking in the wrong layer.
		expect(lastArgv()).toBe("epic status --json");
		expect(lastArgv()).not.toContain("--status");
	});
});
