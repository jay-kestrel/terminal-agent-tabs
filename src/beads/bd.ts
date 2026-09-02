import { execFile } from "child_process";
import { BeadIssue } from "./types";

/**
 * Thin wrapper around the `bd` CLI.
 *
 * SECURITY: every call uses `execFile` with an argument ARRAY — no shell is
 * spawned, so issue IDs, titles, reasons, and query expressions cannot inject
 * shell metacharacters (`;`, `|`, `$()`, backticks, ...). Never switch this to
 * `exec`/`spawn` with a concatenated command string. Data-controlled positional
 * args are additionally placed after a `--` end-of-options sentinel so a value
 * starting with `-` can't be reinterpreted as a bd flag (CWE-88).
 *
 * RESOURCE SAFETY: a global concurrency cap bounds how many `bd` processes can
 * run at once, the code-block read path is de-duplicated, TTL-cached, and
 * serialized to one at a time, and every call has a timeout + output cap.
 */

export interface BdResult {
	stdout: string;
	stderr: string;
}

export class BdError extends Error {
	constructor(
		message: string,
		readonly stderr: string = "",
		readonly cause?: unknown,
		/** True when this call was cancelled via `BdOptions.signal`, not a real failure. */
		readonly aborted: boolean = false,
	) {
		super(message);
		this.name = "BdError";
	}
}

const DEFAULT_TIMEOUT_MS = 15_000;
// Output cap for any single bd call. Sized off the biggest payload we ask for:
// `bd export` (the whole issue DB, used by the graph view) measured 4.5 MB for
// 1232 issues, i.e. ~3.8 KB/issue, so 64 MB covers roughly 17k issues. This is
// a ceiling, not an allocation — Node grows the buffer as output arrives — so
// the only cost of being generous is how much a runaway `bd` could buffer
// before we give up on it, and the timeout bounds that anyway.
//
// Overflow is NOT silent: `execFile` kills the child and calls back with
// `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` (verified on Node 26 — the truncated
// buffer is passed alongside a real error, and we only ever resolve on `!err`),
// so `rawExec` turns it into a `BdError` the UI shows. See the explicit message
// for that code below.
const MAX_BUFFER = 64 * 1024 * 1024;

export interface BdOptions {
	/** Path to the bd binary (or just "bd" to resolve via PATH). */
	bdPath: string;
	/** Working directory — the project root containing `.beads`. */
	cwd: string;
	timeoutMs?: number;
	/**
	 * Lets a caller cancel a long-running `bd` call (e.g. a graph build the user
	 * gave up waiting on). `execFile` kills the child with SIGTERM on abort —
	 * `bd` is a single process (no detached Dolt child observed), so this is a
	 * clean kill, not an orphan risk.
	 */
	signal?: AbortSignal;
}

// --- Global concurrency guard --------------------------------------------
// Cap simultaneous bd processes plugin-wide. `active` counts slots in use.
const MAX_CONCURRENT = 4;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
	if (active < MAX_CONCURRENT) {
		active++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) next(); // hand the slot straight to the next waiter (active unchanged)
	else active--;
}

function rawExec(args: string[], opts: BdOptions): Promise<BdResult> {
	return new Promise((resolve, reject) => {
		execFile(
			opts.bdPath,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
				signal: opts.signal,
			},
			(err, stdout, stderr) => {
				if (err) {
					const aborted = (err as NodeJS.ErrnoException).code === "ABORT_ERR" || opts.signal?.aborted === true;
					const code = (err as NodeJS.ErrnoException).code;
					const msg = aborted
						? "Cancelled."
						: code === "ENOENT"
							? `bd binary not found at "${opts.bdPath}". Set the path in Beads settings.`
							: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
								? `bd ${args[0] ?? ""} produced more than ${Math.round(MAX_BUFFER / (1024 * 1024))} MB of output, so the result was discarded rather than used half-read. This repo may be too large for this plugin's output cap.`
								: `bd ${args[0] ?? ""} failed: ${err.message}`;
					reject(new BdError(msg, String(stderr), err, aborted));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

/** Run a bd command through the global concurrency cap. */
async function run(args: string[], opts: BdOptions): Promise<BdResult> {
	await acquire();
	try {
		return await rawExec(args, opts);
	} finally {
		release();
	}
}

function parseIssues(stdout: string): BeadIssue[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (e) {
		throw new BdError(`Could not parse bd JSON output: ${String(e)}`);
	}
	if (Array.isArray(parsed)) return parsed as BeadIssue[];
	if (parsed && typeof parsed === "object") return [parsed as BeadIssue];
	return [];
}

// --- Code-block read cache -----------------------------------------------
// The pane always reads fresh. ONLY the `beads` code block uses this cache
// (guardrail: "no local caches except the code-block's explicit TTL"), so many
// embedded blocks re-rendering don't hammer bd. Cleared on any mutation.
const READ_TTL_MS = 4_000;
const CODEBLOCK_LIMIT_MAX = 50;
const READ_CACHE_MAX = 64;
interface CacheEntry {
	at: number;
	issues: BeadIssue[];
}
const readCache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<BeadIssue[]>>();
// Serialize code-block reads to at most ONE at a time (design guardrail), on top
// of the global cap. Identical concurrent queries still share one process via
// `pending`; repeats within the TTL are served from `readCache`.
let readGate: Promise<unknown> = Promise.resolve();

function cacheKey(opts: BdOptions, args: string[]): string {
	return JSON.stringify([opts.bdPath, opts.cwd, args]);
}

/**
 * Clear the code-block read cache — call after any bd mutation (ours, or via
 * the `.beads` watcher an external one).
 */
export function invalidateReadCache(): void {
	readCache.clear();
	pending.clear();
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return CODEBLOCK_LIMIT_MAX;
	return Math.min(Math.floor(limit), CODEBLOCK_LIMIT_MAX);
}

/** De-duplicated, TTL-cached, singly-serialized read for the code block. */
async function readCached(args: string[], opts: BdOptions): Promise<BeadIssue[]> {
	const key = cacheKey(opts, args);
	const hit = readCache.get(key);
	if (hit) {
		if (Date.now() - hit.at < READ_TTL_MS) return hit.issues;
		readCache.delete(key); // evict stale so the map can't grow unbounded
	}
	const inflight = pending.get(key);
	if (inflight) return inflight;
	const p = (async () => {
		// Wait our turn behind any other code-block read (max 1 concurrent).
		const prev = readGate;
		let done!: () => void;
		readGate = new Promise<void>((r) => (done = r));
		await prev.catch(() => undefined);
		try {
			const { stdout } = await run(args, opts);
			const issues = parseIssues(stdout);
			if (readCache.size >= READ_CACHE_MAX) readCache.clear();
			readCache.set(key, { at: Date.now(), issues });
			return issues;
		} finally {
			pending.delete(key);
			done();
		}
	})();
	pending.set(key, p);
	return p;
}

// --- Pane reads (always fresh) -------------------------------------------

/**
 * `bd ready --json` — unblocked, actionable work (deps satisfied). This is the
 * "what can I do right now" set; bd computes it, we only display it.
 */
export async function bdReady(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	const { stdout } = await run(
		["ready", "--json", "--limit", String(limit)],
		opts,
	);
	return parseIssues(stdout);
}

/**
 * `bd blocked --json` — issues waiting on unsatisfied dependencies. NOTE:
 * dependency-blocked issues keep `status=open`, so they can only be found via
 * this command — never by subtracting `ready` from `list`.
 */
export async function bdBlocked(opts: BdOptions): Promise<BeadIssue[]> {
	const { stdout } = await run(["blocked", "--json"], opts);
	return parseIssues(stdout);
}

/**
 * `bd list --status <status> --json` — issues in one stored status.
 *
 * `sort` is bd's own ordering (priority, created, updated, closed, id, …),
 * applied server-side BEFORE the limit. That matters: the pane pages 25 at a
 * time, so sorting client-side would only ever reorder whichever 25 bd
 * happened to return first. The Closed tab passes `closed` so the most
 * recently closed work lands on page one — bd's default order is not recency,
 * and without this a bead closed today can sit 100+ rows deep behind ones
 * closed weeks earlier.
 */
export async function bdByStatus(
	opts: BdOptions,
	status: string,
	limit: number,
	sort?: string,
): Promise<BeadIssue[]> {
	const args = ["list", "--status", status, "--json", "--no-pager", "--limit", String(limit)];
	if (sort) args.push("--sort", sort);
	const { stdout } = await run(args, opts);
	return parseIssues(stdout);
}

/**
 * `bd search --json --status <status> -- <query>` — text search over title and
 * ID run BY BD, against the whole database rather than the loaded page.
 *
 * This exists because filtering `tab.issues` client-side can only ever match
 * within the current page: with PAGE=25 and hundreds of closed issues, typing
 * an id that exists but sits deeper renders "No issues match", which is
 * indistinguishable from "that bead does not exist". Search has to reach the
 * database or it silently lies about absence.
 *
 * `status` is passed straight through as bd's filter — note bd EXCLUDES closed
 * by default, so a caller wanting closed rows must say so explicitly
 * ("closed", or "all" to span every status).
 */
export async function bdSearch(
	opts: BdOptions,
	query: string,
	status: string,
	limit: number,
): Promise<BeadIssue[]> {
	const { stdout } = await run(
		["search", "--json", "--status", status, "--limit", String(limit), "--", query],
		opts,
	);
	return parseIssues(stdout);
}

/** `bd show --json -- <id>` → the single issue (or null if not found). */
export async function bdShow(
	opts: BdOptions,
	id: string,
): Promise<BeadIssue | null> {
	const { stdout } = await run(["show", "--json", "--", id], opts);
	const issues = parseIssues(stdout);
	return issues[0] ?? null;
}

/**
 * `bd dep list --json [--direction=up] -- <id>` — the issues on one side of an
 * issue's dependency edges. `down` (default) = what this issue depends on (its
 * blockers); `up` = what depends on this issue (its dependents). bd returns
 * full issue records here, so no extra title lookup is needed.
 */
export async function bdDepList(
	opts: BdOptions,
	id: string,
	direction: "down" | "up",
): Promise<BeadIssue[]> {
	const args = ["dep", "list", "--json"];
	if (direction === "up") args.push("--direction=up");
	args.push("--", id);
	const { stdout } = await run(args, opts);
	return parseIssues(stdout);
}

/**
 * One entry of `bd epic status --json`: the epic issue plus bd's own rollup.
 * bd only rolls up *closed vs total* — there is no per-status breakdown here,
 * so the finer open/in-progress split is derived from `bdChildren` on expand.
 */
export interface BdEpicStatus {
	epic: BeadIssue;
	total_children: number;
	closed_children: number;
	eligible_for_close: boolean;
}

/**
 * `bd epic status --json` — every epic with bd's child rollup, in ONE call. bd
 * computes `total_children`/`closed_children`; we never walk the parent-child
 * edges ourselves to re-derive them.
 *
 * CLOSED EPICS ARE INCLUDED. This comment previously claimed the opposite,
 * which sent a search for a missing closed epic looking in the wrong layer —
 * bd returns them, and the filtering that hid one was ours.
 */
export async function bdEpicStatus(opts: BdOptions): Promise<BdEpicStatus[]> {
	const { stdout } = await run(["epic", "status", "--json"], opts);
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) ? (parsed as BdEpicStatus[]) : [];
	} catch (e) {
		throw new BdError(`Could not parse bd epic status JSON: ${String(e)}`);
	}
}

/**
 * `bd children --json -- <id>` — the direct children of a parent bead. bd's
 * own alias for `list --parent <id> --status all`, so closed children are
 * included (that's the point: the drilldown shows the whole epic).
 */
export async function bdChildren(
	opts: BdOptions,
	id: string,
): Promise<BeadIssue[]> {
	const { stdout } = await run(["children", "--json", "--", id], opts);
	return parseIssues(stdout);
}

// --- Code-block reads (cached, clamped, serialized) ----------------------

export async function bdReadyCached(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	return readCached(["ready", "--json", "--limit", String(clampLimit(limit))], opts);
}

export async function bdListCached(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	return readCached(
		["list", "--json", "--no-pager", "--limit", String(clampLimit(limit))],
		opts,
	);
}

export async function bdBlockedCached(opts: BdOptions): Promise<BeadIssue[]> {
	return readCached(["blocked", "--json"], opts);
}

export async function bdQueryCached(
	opts: BdOptions,
	expr: string,
	limit: number,
): Promise<BeadIssue[]> {
	// The whole expression is ONE argv element after `--` — bd parses its own
	// query language; no shell, no flag confusion, no injection.
	return readCached(
		["query", "--json", "--limit", String(clampLimit(limit)), "--", expr],
		opts,
	);
}

// --- Mutations (clear the code-block cache) ------------------------------

/** `bd close --reason <reason> -- <id>`. */
export async function bdClose(
	opts: BdOptions,
	id: string,
	reason: string,
): Promise<void> {
	await run(["close", "--reason", reason, "--", id], opts);
	invalidateReadCache();
}

export interface BdCreateFields {
	title: string;
	type: string;
	priority: number;
	description?: string;
	assignee?: string;
	labels?: string[];
	/** Parent issue id — bd links this as a hierarchical child. */
	parent?: string;
	/** Issue id that must close before this new one is ready — a plain "blocks" dependency, not hierarchy. */
	blockedBy?: string;
}

/**
 * `bd create --title=<t> -t <type> -p <n> [...] --json` → new id.
 * Free-text fields use the `--flag=value` form so a value starting with `-`
 * is taken verbatim and never parsed as a flag.
 */
export async function bdCreate(
	opts: BdOptions,
	f: BdCreateFields,
): Promise<string> {
	const args = [
		"create",
		`--title=${f.title}`,
		`--type=${f.type}`,
		`--priority=${f.priority}`,
	];
	if (f.description) args.push(`--description=${f.description}`);
	if (f.assignee) args.push(`--assignee=${f.assignee}`);
	if (f.labels && f.labels.length) args.push(`--labels=${f.labels.join(",")}`);
	if (f.parent) args.push(`--parent=${f.parent}`);
	if (f.blockedBy) args.push(`--deps=blocks:${f.blockedBy}`);
	args.push("--json");
	const { stdout } = await run(args, opts);
	invalidateReadCache();
	const id = parseIssues(stdout)[0]?.id;
	if (!id) throw new BdError("bd create did not return an issue id.");
	return id;
}

export interface BdUpdateFields {
	title?: string;
	description?: string;
	priority?: number;
	type?: string;
	status?: string;
	/** New assignee; empty string clears it. `undefined` = leave unchanged. */
	assignee?: string;
	/** Labels to add / remove (diff form — `--set-labels=` can't clear). */
	addLabels?: string[];
	removeLabels?: string[];
}

/** `bd update <flags> -- <id>` — change any subset of an issue's fields. */
export async function bdUpdate(
	opts: BdOptions,
	id: string,
	f: BdUpdateFields,
): Promise<void> {
	const args = ["update"];
	// `--flag=value` form keeps every value a single argv token, so a value
	// starting with `-` (or containing spaces/newlines) is taken verbatim.
	if (f.title !== undefined) args.push(`--title=${f.title}`);
	if (f.description !== undefined) args.push(`--description=${f.description}`);
	if (f.priority !== undefined) args.push(`--priority=${f.priority}`);
	if (f.type !== undefined) args.push(`--type=${f.type}`);
	if (f.status !== undefined) args.push(`--status=${f.status}`);
	if (f.assignee !== undefined) args.push(`--assignee=${f.assignee}`);
	for (const l of f.addLabels ?? []) args.push(`--add-label=${l}`);
	for (const l of f.removeLabels ?? []) args.push(`--remove-label=${l}`);
	args.push("--", id);
	await run(args, opts);
	invalidateReadCache();
}

export interface BdComment {
	id?: string;
	issue_id?: string;
	author?: string;
	text?: string;
	created_at?: string;
}

/**
 * `bd comments --json -- <id>` — the comment thread on an issue, oldest first.
 * Read-only: the editor renders each comment's text as markdown.
 */
export async function bdComments(
	opts: BdOptions,
	id: string,
): Promise<BdComment[]> {
	const { stdout } = await run(["comments", "--json", "--", id], opts);
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return Array.isArray(parsed) ? (parsed as BdComment[]) : [];
	} catch (e) {
		throw new BdError(`Could not parse bd comments JSON: ${String(e)}`);
	}
}

/**
 * `bd comments add -- <id> <text>` — append a comment to an issue's thread.
 * `--` covers both positionals (not just `id`), so comment text starting
 * with `-` can't be mistaken for a flag.
 */
export async function bdCommentAdd(
	opts: BdOptions,
	id: string,
	text: string,
): Promise<void> {
	await run(["comments", "add", "--", id, text], opts);
	invalidateReadCache();
}

// The graph view used to shell out to `bd graph --dot`, which walks the
// dependency closure inside bd/Dolt with an N+1-shaped query per node —
// measured on a real ~1226-issue repo: 8s for a single non-epic issue, 49s for
// a 73-node epic, 142s for a 331-node epic, 54s for `--all`. `bd export`
// returns EVERY issue in the repo, dependency edges included, in 1.5s flat on
// the same repo, so the graph is now built client-side from one export (see
// graphBuilder.ts) and this is the only bd call the view makes.
//
// Measured repeatedly at 1.2–1.9s for 1232 issues. 60s is ~30x that, chosen
// rather than something tighter because the failure modes are asymmetric: a
// timeout that fires on a merely-slow repo is a hard, unexplained error for the
// user, while waiting too long costs nothing — the view shows a ticking elapsed
// counter and a Cancel button, so the human, not the clock, decides when to
// give up. `bd export` cost grows with repo size and it is a Dolt read that can
// contend with an in-flight `bd` write elsewhere, so the tail is not bounded by
// the median. Note the global concurrency gate is acquired *before* this timer
// starts, so queueing behind other bd calls never eats the budget.
const EXPORT_TIMEOUT_MS = 60_000;

/**
 * `bd export` — every issue in the repo as JSONL, one object per line, each
 * carrying its labels and its full `dependencies[]` array. Returned raw so the
 * caller can parse it (see `parseExportJsonl`); the payload is a few MB on a
 * large repo (4.5 MB / 1232 issues measured), well inside `MAX_BUFFER`, and
 * exceeding it errors rather than truncating — see `MAX_BUFFER`.
 *
 * Deliberately no flags: bd's default already excludes infrastructure beads
 * (agents/roles/messages) and memories, which is exactly the universe
 * `bd graph` itself draws from — verified by resolving real `bd graph --dot`
 * node sets against a default export with zero unresolved ids.
 *
 * Not cached: a graph render is a deliberate, occasional action, not a hot
 * path, and a stale graph is worse than a 1.5s wait. Pass `opts.signal` to
 * make this cancellable (the caller drives an AbortController off a Cancel
 * button).
 */
export async function bdExport(opts: BdOptions): Promise<string> {
	const { stdout } = await run(["export"], { ...opts, timeoutMs: EXPORT_TIMEOUT_MS });
	return stdout;
}

/** Cheap probe used to validate settings: `bd --version`. */
export async function bdVersion(opts: BdOptions): Promise<string> {
	const { stdout } = await run(["--version"], { ...opts, timeoutMs: 5_000 });
	return stdout.trim();
}

/**
 * The `summary` block of `bd status --json` — per-status counts in one cheap
 * call (keys like `ready_issues`, `blocked_issues`, `closed_issues`, ...).
 */
export async function bdStatusCounts(
	opts: BdOptions,
): Promise<Record<string, number>> {
	const { stdout } = await run(["status", "--json"], opts);
	try {
		const d = JSON.parse(stdout.trim()) as {
			summary?: Record<string, number>;
		};
		return d?.summary ?? {};
	} catch {
		return {};
	}
}
