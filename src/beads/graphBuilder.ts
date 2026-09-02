/**
 * Client-side Graphviz-DOT builder for the dependency-graph view.
 *
 * WHY THIS EXISTS: `bd graph --dot` walks the dependency closure inside
 * bd/Dolt with an N+1-shaped query per node. Measured on a real ~1226-issue
 * repo: a single non-epic issue took 8s, a 73-node epic 49s, a 331-node epic
 * 142s, and `--all` 54s. `bd export` — which returns *every* issue with its
 * full dependency list, labels, status and priority — takes 1.5s flat on the
 * same repo. So we fetch the whole repo once and do the closure walk, the
 * layer assignment and the DOT emission here, in JS, then hand the result to
 * the same Graphviz-WASM pipeline (see graph.ts). The WASM layout step was
 * never the bottleneck (35–160ms even for the largest graphs).
 *
 * FIDELITY: this is a deliberate reimplementation of bd 1.1.0's own `--dot`
 * output, reverse-engineered from its output on a real repo and verified
 * structurally against it (same node set, edge set, layer per node, and
 * per-status styling). The rules it reproduces:
 *
 *  - SCOPE, single id: the whole *undirected connected component* containing
 *    the issue, over dependency edges of EVERY type (including `relates-to`,
 *    `discovered-from`, ... which are used for connectivity but never drawn).
 *    Not "direct dependencies" as `bd graph --help` suggests, and not
 *    "children" for an epic — empirically it is the connected component
 *    either way, with no status filter (closed issues are included).
 *  - SCOPE, --all: the same, but the universe is restricted to non-closed,
 *    non-deferred issues (status open / in_progress / blocked), and bd emits
 *    one separate `digraph` per component. We emit ONE digraph holding all
 *    components instead — see ALL_SCOPE_NOTE below.
 *  - Dangling `depends_on_id`s that match no exported issue are dropped, as
 *    bd drops them.
 *  - EDGES: only `parent-child` (dashed, empty arrowhead) and `blocks`
 *    (solid, normal arrowhead) are drawn, directed dependency -> dependent.
 *  - LAYERS: two passes. `blockDepth` is the longest path over `blocks` edges
 *    only. The final layer is `max(blockDepth(x), layer(parent(x)))` — a child
 *    inherits its parent's layer but is NOT pushed one past it. That
 *    two-pass shape is what makes bd's output look locally inconsistent (a
 *    `blocks` edge can join two nodes in the same layer, when the source's
 *    own layer came purely from parent inheritance), and reproducing it
 *    exactly is the only way to match bd node-for-node.
 *
 * TWO DELIBERATE DIVERGENCES from bd's byte-level output, both verified against
 * bd 1.1.0 and both in our favour:
 *
 *  - ESCAPING: bd escapes `"` in a title (as `\"`) but leaves a backslash
 *    UNESCAPED, so a title containing `back\slash` lands in bd's DOT verbatim
 *    and Graphviz reads `\s` as an (undefined) escape — lossy at best, and a
 *    title ending in `\` would escape bd's own closing quote. `dotEscape`
 *    escapes both. Titles are local data but not author-trusted (anything that
 *    files a bead writes them), so matching bd here would be a real injection
 *    surface, not a fidelity win. This is the only reason a label can differ
 *    from bd's, and only for titles containing a backslash.
 *  - `--all` FRAMING: see ALL_SCOPE_NOTE below.
 *
 * CYCLES: bd 1.1.0 refuses to create one on every write path checked —
 * `dep add`, `dep add --no-cycle-check` (a whole-graph check still runs before
 * commit) and `import` (which skips the offending edge) — so a cyclic export is
 * not reachable through bd today and there is no `bd graph --dot` ground truth
 * to match against for one. The layering below is therefore written to be
 * *safe* rather than bd-identical on a cycle: it terminates, and the DOT it
 * emits still renders (covered by tests, self-loops included), so a future bd
 * that loses that invariant degrades to a slightly-odd layout, not a hang.
 *
 * ALL_SCOPE_NOTE: bd's `--all` output is 251 concatenated `digraph beads {…}`
 * blocks, which is not a single valid DOT document — Graphviz parses only the
 * first, so the old `--all` view silently showed one component out of 251.
 * We emit a single digraph containing every component, which Graphviz lays
 * out side by side. Node/edge/layer content is identical; only the framing
 * differs (deliberately, and it fixes a bug).
 */

import type { BdDepType } from "./bd";

/** One entry of an issue's `dependencies[]` array in `bd export` JSONL. */
export interface ExportDependency {
	/** The dependent issue (the one that owns this record). */
	issue_id: string;
	/** The issue it depends on — the edge SOURCE in bd's DOT output. */
	depends_on_id: string;
	type: string;
}

/** The subset of a `bd export` record this builder reads. */
export interface ExportIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	dependencies?: ExportDependency[];
}

export interface GraphTarget {
	id?: string;
	all?: boolean;
}

export class GraphBuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphBuildError";
	}
}

/** Dependency types bd actually draws, and how. */
const EDGE_STYLE: Record<string, string> = {
	"parent-child": 'style=dashed, arrowhead=empty, color="#999999"',
	blocks: "style=solid, arrowhead=normal",
};

/** bd's per-status icon + palette. Verified against bd 1.1.0's output. */
const STATUS_STYLE: Record<string, { icon: string; fill: string; font: string }> = {
	open: { icon: "○", fill: "#e8f4fd", font: "#1a1a1a" },
	in_progress: { icon: "◐", fill: "#fff3cd", font: "#664d03" },
	blocked: { icon: "●", fill: "#f8d7da", font: "#842029" },
	closed: { icon: "✓", fill: "#d4edda", font: "#888888" },
	deferred: { icon: "❄", fill: "#e2e3e5", font: "#41464b" },
};
/** Unknown/future statuses land here — same neutral pair bd uses for deferred. */
const FALLBACK_STYLE = { icon: "○", fill: "#e2e3e5", font: "#41464b" };

/** Statuses `bd graph --all` counts as "open". Excludes closed AND deferred. */
const ALL_SCOPE_STATUSES = new Set(["open", "in_progress", "blocked"]);

/** bd truncates the title to 40 runes, the 40th being the ellipsis. */
const TITLE_MAX_RUNES = 40;

/**
 * Parse `bd export` JSONL. Tolerant by design: a line that isn't JSON, isn't
 * an object, or isn't an issue record is skipped rather than failing the whole
 * graph. `bd export` also emits non-issue records (it tags them with `_type`),
 * and we only ever want issues.
 */
export function parseExportJsonl(text: string): ExportIssue[] {
	const out: ExportIssue[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const rec = parsed as Record<string, unknown>;
		if (typeof rec._type === "string" && rec._type !== "issue") continue;
		if (typeof rec.id !== "string" || !rec.id) continue;
		out.push({
			id: rec.id,
			title: typeof rec.title === "string" ? rec.title : "",
			status: typeof rec.status === "string" ? rec.status : "",
			priority: typeof rec.priority === "number" && Number.isFinite(rec.priority) ? rec.priority : 0,
			dependencies: readDependencies(rec.dependencies),
		});
	}
	return out;
}

function readDependencies(raw: unknown): ExportDependency[] {
	if (!Array.isArray(raw)) return [];
	const out: ExportDependency[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const d = entry as Record<string, unknown>;
		if (typeof d.issue_id !== "string" || typeof d.depends_on_id !== "string") continue;
		out.push({
			issue_id: d.issue_id,
			depends_on_id: d.depends_on_id,
			type: typeof d.type === "string" ? d.type : "",
		});
	}
	return out;
}

interface Edge {
	src: string;
	dst: string;
	type: string;
}

/**
 * The reverse of the DOT-emission loop below: given a Graphviz-rendered edge
 * (`g.edge`), read back the two bead ids and dependency type it draws. The
 * graph view's edge-click handler uses this to know exactly what a "Remove
 * dependency" click is about to remove.
 *
 * `src`/`dst` come from the `<title>src->dst</title>` Graphviz emits for
 * every `"src" -> "dst"` DOT statement — `src` is the blocker (dependency),
 * `dst` the blocked (dependent), matching `bd dep add`'s own
 * `<issue-id> <depends-on-id>` order reversed. Bead ids never contain the
 * literal substring "->", so splitting on its first occurrence is safe.
 *
 * `type` comes off the edge's own `class` attribute — see the `dep-${e.type}`
 * comment in the emission loop below for why that's there at all. Only
 * "blocks" and "parent-child" are ever drawn (EDGE_STYLE), so anything else
 * (a missing class, a future edge type) falls back to "blocks" rather than
 * mis-parsing — the same default `bdDepAdd` itself uses.
 *
 * Takes a duck-typed subset of `Element` (just `querySelector` + `classList`)
 * rather than the real DOM type, so this stays testable without a DOM.
 */
export function edgeEndpoints(
	g: Pick<Element, "querySelector" | "classList">,
): { src: string; dst: string; type: BdDepType } | undefined {
	const title = g.querySelector("title")?.textContent?.trim();
	if (!title) return undefined;
	const i = title.indexOf("->");
	if (i < 0) return undefined;
	const src = title.slice(0, i);
	const dst = title.slice(i + 2);
	if (!src || !dst) return undefined;
	const type: BdDepType = g.classList.contains("dep-parent-child") ? "parent-child" : "blocks";
	return { src, dst, type };
}

/**
 * Escape a string for use inside a DOT double-quoted literal.
 *
 * Titles are arbitrary user text: a stray `"` would end the literal early and
 * a trailing `\` would escape the closing quote, either of which turns into a
 * parse error (or worse, an attribute injected into the node). Control
 * characters — a real newline especially — also can't survive inside a quoted
 * DOT literal, so they collapse to a space. Order matters: backslashes first,
 * or we'd re-escape the escapes we just added.
 *
 * Note this is deliberately stricter than bd, which escapes `"` but not `\`.
 * See the module header. Applied to ids as well as titles, so a node
 * declaration and the edge lines that reference it always spell the id the
 * same way.
 */
export function dotEscape(s: string): string {
	// eslint-disable-next-line no-control-regex -- matching control characters is the whole point here
	const flattened = s.replace(/[\u0000-\u001f\u007f]/g, " ");
	return flattened.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Truncate to `max` Unicode code points, ellipsis included, like bd's Go does on runes. */
export function truncateTitle(title: string, max: number = TITLE_MAX_RUNES): string {
	const runes = Array.from(title);
	if (runes.length <= max) return title;
	return runes.slice(0, max - 1).join("") + "…";
}

function nodeLine(issue: ExportIssue): string {
	const style = STATUS_STYLE[issue.status] ?? FALLBACK_STYLE;
	// bd's label is "<icon> <id>\nP<priority> | <truncated title>", where the
	// \n is DOT's centred-line escape (a literal backslash-n in the file).
	const label = `${style.icon} ${dotEscape(issue.id)}\\nP${issue.priority} | ${dotEscape(truncateTitle(issue.title))}`;
	return `    "${dotEscape(issue.id)}" [label="${label}", fillcolor="${style.fill}", fontcolor="${style.font}"];`;
}

/**
 * Resolve `value(x) = max(base(x), max over preds p of value(p) + inc)` over a
 * possibly-cyclic pred graph, iteratively (no recursion depth limit). A
 * predecessor that is still on the DFS stack — i.e. a cycle back-edge —
 * contributes its own `base` instead of its unfinished value, which is how
 * bd's own recursion behaves when it re-enters a node.
 */
function resolveDepths(
	ids: string[],
	preds: Map<string, string[]>,
	base: (id: string) => number,
	inc: number,
): Map<string, number> {
	const done = new Map<string, number>();
	const onStack = new Set<string>();
	for (const root of ids) {
		if (done.has(root)) continue;
		// Explicit stack of frames; `i` is how many preds we've folded in.
		const stack: { id: string; i: number; acc: number }[] = [{ id: root, i: 0, acc: base(root) }];
		onStack.add(root);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const list = preds.get(frame.id) ?? [];
			if (frame.i < list.length) {
				const p = list[frame.i++];
				const settled = done.get(p);
				if (settled !== undefined) {
					frame.acc = Math.max(frame.acc, settled + inc);
				} else if (onStack.has(p)) {
					frame.acc = Math.max(frame.acc, base(p) + inc);
				} else {
					stack.push({ id: p, i: 0, acc: base(p) });
					onStack.add(p);
				}
				continue;
			}
			stack.pop();
			onStack.delete(frame.id);
			done.set(frame.id, frame.acc);
			const parent = stack[stack.length - 1];
			if (parent) parent.acc = Math.max(parent.acc, frame.acc + inc);
		}
	}
	return done;
}

/**
 * Assign bd's layer number to every node in `ids`.
 *
 * Pass 1 — `blockDepth`: longest chain of `blocks` edges ending at the node.
 * Pass 2 — `layer`: that depth, raised to the parent's layer if the parent
 * sits further right. Children share their parent's layer (increment 0), they
 * are not pushed past it.
 */
function assignLayers(ids: string[], edges: Edge[]): Map<string, number> {
	const inSet = new Set(ids);
	const blockPreds = new Map<string, string[]>();
	const parentPreds = new Map<string, string[]>();
	for (const e of edges) {
		if (!inSet.has(e.src) || !inSet.has(e.dst)) continue;
		const bucket = e.type === "blocks" ? blockPreds : e.type === "parent-child" ? parentPreds : undefined;
		if (!bucket) continue;
		const list = bucket.get(e.dst);
		if (list) list.push(e.src);
		else bucket.set(e.dst, [e.src]);
	}
	const blockDepth = resolveDepths(ids, blockPreds, () => 0, 1);
	return resolveDepths(ids, parentPreds, (id) => blockDepth.get(id) ?? 0, 0);
}

/**
 * Collect every dependency edge whose endpoints both exist, de-duplicated.
 *
 * Each edge is carried by exactly one record — the dependent's — so there is
 * no mirrored entry on the target side to double-count. The dedupe is belt
 * and braces (and makes the output stable if bd ever changes that).
 */
function collectEdges(issues: ExportIssue[], known: Set<string>): Edge[] {
	const seen = new Set<string>();
	const edges: Edge[] = [];
	for (const issue of issues) {
		for (const dep of issue.dependencies ?? []) {
			const src = dep.depends_on_id;
			const dst = dep.issue_id;
			if (!known.has(src) || !known.has(dst)) continue;
			const key = `${src}\u0000${dst}\u0000${dep.type}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ src, dst, type: dep.type });
		}
	}
	return edges;
}

/** Undirected adjacency over ALL dependency types — bd's connectivity notion. */
function adjacency(edges: Edge[]): Map<string, string[]> {
	const adj = new Map<string, string[]>();
	const push = (a: string, b: string): void => {
		const list = adj.get(a);
		if (list) list.push(b);
		else adj.set(a, [b]);
	};
	for (const e of edges) {
		push(e.src, e.dst);
		push(e.dst, e.src);
	}
	return adj;
}

function componentOf(start: string, adj: Map<string, string[]>): Set<string> {
	const seen = new Set<string>([start]);
	const stack = [start];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		for (const next of adj.get(id) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return seen;
}

/**
 * Build the DOT source for one graph scope out of a whole-repo `bd export`.
 *
 * `target.id` scopes to that issue's connected component; `target.all` covers
 * every non-closed, non-deferred issue. With neither, `--all` semantics apply
 * (matching `bd graph` with no argument being a usage error we'd rather not
 * reproduce as a crash).
 */
export function buildGraphDot(issues: ExportIssue[], target: GraphTarget): string {
	const byId = new Map<string, ExportIssue>();
	for (const issue of issues) byId.set(issue.id, issue);

	// Universe: every issue for a single-id scope; only "open" ones for --all.
	const scopeAll = !target.id;
	const universe = new Set<string>();
	for (const issue of issues) {
		if (!scopeAll || ALL_SCOPE_STATUSES.has(issue.status)) universe.add(issue.id);
	}

	if (target.id && !byId.has(target.id)) {
		throw new GraphBuildError(`Issue ${target.id} not found in bd export output.`);
	}

	const edges = collectEdges(issues, universe);
	const adj = adjacency(edges);

	// Node set, and the component partition we assign layers within. Layers are
	// component-local (that's what bd's one-digraph-per-component output gives),
	// so we compute them per component and then merge by layer index.
	let components: Set<string>[];
	if (target.id) {
		components = [componentOf(target.id, adj)];
	} else {
		components = [];
		const claimed = new Set<string>();
		for (const id of Array.from(universe).sort()) {
			if (claimed.has(id)) continue;
			const comp = componentOf(id, adj);
			for (const member of comp) claimed.add(member);
			components.push(comp);
		}
	}

	const nodes = new Set<string>();
	const layerOf = new Map<string, number>();
	for (const comp of components) {
		const ids = Array.from(comp).sort();
		const compEdges = edges.filter((e) => comp.has(e.src) && comp.has(e.dst));
		for (const [id, layer] of assignLayers(ids, compEdges)) layerOf.set(id, layer);
		for (const id of ids) nodes.add(id);
	}

	// Group by layer, each layer's nodes sorted by id (as bd emits them).
	const byLayer = new Map<number, string[]>();
	for (const id of Array.from(nodes).sort()) {
		const layer = layerOf.get(id) ?? 0;
		const list = byLayer.get(layer);
		if (list) list.push(id);
		else byLayer.set(layer, [id]);
	}

	const lines: string[] = [
		"digraph beads {",
		"  rankdir=LR;",
		'  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11];',
		'  edge [color="#666666"];',
		"",
	];
	for (const layer of Array.from(byLayer.keys()).sort((a, b) => a - b)) {
		lines.push(`  subgraph cluster_layer_${layer} {`, "    style=invis;", "    rank=same;");
		for (const id of byLayer.get(layer) as string[]) {
			const issue = byId.get(id);
			if (issue) lines.push(nodeLine(issue));
		}
		lines.push("  }");
	}
	lines.push("");
	for (const e of edges) {
		if (!nodes.has(e.src) || !nodes.has(e.dst)) continue;
		const style = EDGE_STYLE[e.type];
		if (!style) continue; // relates-to & friends connect components but aren't drawn
		// A THIRD deliberate divergence from bd's own `--dot` output (see the
		// module doc comment): `class` isn't one of the attributes bd emits, but
		// Graphviz supports it and carries it straight into the rendered SVG's
		// `<g class="edge dep-...">`, which is how the graph view tells a
		// `blocks` edge from a `parent-child` one when a click on it needs to
		// know which kind it's about to remove (see graph.ts's `edgeEndpoints`).
		// `e.type` is one of EDGE_STYLE's own keys, never issue-authored text,
		// so it needs no DOT-literal escaping.
		lines.push(`  "${dotEscape(e.src)}" -> "${dotEscape(e.dst)}" [${style}, class="dep-${e.type}"];`);
	}
	lines.push("}", "");
	return lines.join("\n");
}
