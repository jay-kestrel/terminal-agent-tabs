import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import { execFile } from "child_process";
import { BeadIssue } from "./types";
import { BdOptions, bdDepList } from "./bd";
import type { PrimedSessionRequest } from "./feature";

/**
 * "Work the bead" — hand one bead to a CLI coding agent.
 *
 * SECURITY / SAFETY POSTURE. This is the only place in the beads half of the
 * plugin that can start a process other than `bd`, so it is deliberately the
 * most conservative surface here:
 *
 *  1. We NEVER submit the agent prompt. There are two routes out of the preview
 *     modal, and neither one presses Enter for the user:
 *
 *     (a) Copy the command — the original route, unchanged. The user pastes it
 *         into their own terminal and runs it themselves.
 *
 *     (b) "Open session tab" — added when beads merged into Terminal Agent
 *         Tabs. This DOES start a process: the chosen CLI agent, inside the
 *         merged plugin's own PTY session tab, in the bead's project
 *         directory. The generated prompt is then TYPED into that session's
 *         stdin WITHOUT a trailing newline, so it lands in the agent's input
 *         box exactly as a paste would. The user still reads it, can still
 *         edit it in the terminal, and must still press Enter for the agent to
 *         act on it.
 *
 *     DELIBERATE POSTURE CHANGE, stated plainly: route (b) means an agent
 *     process can now be started by a click in Obsidian, where before the only
 *     thing a click could start was a terminal emulator. What did NOT change is
 *     that no bead prompt reaches an agent's input handler without the user
 *     pressing Enter on it. Route (b) is never the default, is never reached
 *     without a second explicit click in the preview modal, and is hidden
 *     entirely unless the harness names a session target.
 *  2. The only OTHER thing we can launch is the user's terminal emulator, from
 *     an explicit button click in that preview, via `execFile` with an argument
 *     ARRAY — no shell, exactly like `bd.ts`. The launcher template is split
 *     into argv tokens BEFORE `{dir}` is substituted, so a project path
 *     containing spaces stays one token and cannot inject extra arguments.
 *  3. Bead text (title/description/labels) only ever reaches the clipboard
 *     string, and is POSIX single-quoted there, so a description containing
 *     `; rm -rf ~` pastes as inert text inside one quoted argument. On route
 *     (b) the bead text never becomes argv at all — it is written to the live
 *     session's stdin, so there is no shell and no quoting to get wrong.
 */

/** A user-defined CLI coding-agent harness (Claude Code, Codex, anything). */
export interface HarnessProfile {
	id: string;
	/** Display name shown in the "Work the bead" menu. */
	name: string;
	/**
	 * Command-line template. `{prompt}` is replaced with the shell-quoted
	 * generated prompt (appended if the template omits it) and `{model}` with
	 * this profile's model field. Deliberately free-form: the plugin does not
	 * track any vendor's current CLI flag syntax.
	 *
	 * Used by the COPY route only. The in-Obsidian session route launches the
	 * host plugin's CLI profile named by `sessionCliId` instead, because that is
	 * the executable the host already knows how to drive through a PTY.
	 */
	command: string;
	/** Optional model name substituted for `{model}`. */
	model: string;
	/**
	 * Optional id of a host CLI profile (Terminal Agent Tabs `cliProfiles`).
	 * When set, the preview modal offers "Open session tab". When empty, this
	 * harness is copy-only — exactly the pre-merge behavior.
	 */
	sessionCliId?: string;
	/**
	 * Extra argv appended to that CLI profile's own args for bead sessions
	 * (e.g. `--model opus`). Split on whitespace; never shell-interpreted.
	 * Never carries the prompt — the prompt goes to stdin, not argv.
	 */
	sessionArgs?: string;
}

export function newHarnessId(): string {
	return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Shipped as editable EXAMPLES, not as a maintained list of correct flags.
 * Both pass the prompt as one positional argument, which is the only shape
 * common enough across CLI agents to be a reasonable starting guess.
 *
 * "Claude Code" links to the host's `sessionCliId: "claude"` profile, which
 * `migrateCliProfiles` (SettingsMigration.ts) guarantees always exists — so
 * "Work the bead" opens an in-app session tab out of the box instead of
 * defaulting every fresh install to the external-terminal fallback button.
 * "Codex CLI" has no such guarantee (the host doesn't ship a default codex
 * profile), so it stays copy-only until the user links one themselves.
 */
export function defaultHarnesses(): HarnessProfile[] {
	return [
		{ id: newHarnessId(), name: "Claude Code", command: "claude {prompt}", model: "", sessionCliId: "claude" },
		{ id: newHarnessId(), name: "Codex CLI", command: "codex {prompt}", model: "" },
	];
}

/**
 * The generated prompt. One configurable string so the user owns the wording;
 * the placeholders are the bead's fields plus its dependency context.
 *
 * bd has no per-issue "dump agent context" flag (checked `bd --help` /
 * `bd show --help`: the closest things are `bd prime`, which emits repo-wide
 * AI workflow context, and `bd show --long`). So the default template carries
 * the bead's own fields and then points the agent at `bd prime` / `bd show`
 * for the live record rather than inventing a competing context format.
 */
export const DEFAULT_PROMPT_TEMPLATE = `Work bead {id} in {project}.

Title: {title}
Type: {type} · Status: {status} · Priority: {priority}
Labels: {labels}
Assignee: {assignee}

Description:
{description}

Blocked by: {blockers}
Blocks: {dependents}

Before you start, run \`bd prime\` for this repo's beads workflow and
\`bd show {id}\` for the live record. Claim the bead, implement it, and only
close it once its acceptance criteria actually hold.`;

/**
 * The generated prompt for a bead-agnostic "planning" session — launched from
 * the graph view (or anywhere else that isn't a single bead) via
 * `showPlanningMenu`. Deliberately short: there's no bead to describe, so this
 * is just enough to orient the agent before it starts poking at `bd` itself.
 */
export const DEFAULT_PLANNING_PROMPT_TEMPLATE = `Planning session for {project}. Run \`bd prime\` for this repo's beads workflow, then \`bd ready\` / \`bd graph\` to see current state before making changes.`;

/** Per-platform default for opening a terminal at a directory. */
export function defaultTerminalCommand(): string {
	switch (process.platform) {
		case "darwin":
			return "open -a Terminal {dir}";
		case "win32":
			return "cmd /c start cmd /k cd /d {dir}";
		default:
			return "x-terminal-emulator --working-directory={dir}";
	}
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replace `{key}` placeholders; unknown keys are left alone (typo stays visible). */
function fill(template: string, values: Record<string, string>): string {
	return template.replace(PLACEHOLDER, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
	);
}

/** POSIX single-quoting: the only escape inside '' is the '\'' dance. */
export function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

export interface PromptContext {
	issue: BeadIssue;
	projectName: string;
	blockers: BeadIssue[];
	dependents: BeadIssue[];
}

function summarize(issues: BeadIssue[]): string {
	if (issues.length === 0) return "(none)";
	return issues.map((i) => `${i.id} (${i.status}) ${i.title}`).join("; ");
}

export function buildPrompt(template: string, ctx: PromptContext): string {
	const i = ctx.issue;
	return fill(template, {
		id: i.id,
		title: i.title ?? "",
		description: i.description?.trim() || "(no description)",
		status: i.status ?? "",
		priority: `P${String(i.priority ?? 2)}`,
		type: i.issue_type ?? "",
		labels: i.labels?.length ? i.labels.join(", ") : "(none)",
		assignee: i.assignee || i.owner || "(unassigned)",
		project: ctx.projectName,
		blockers: summarize(ctx.blockers),
		dependents: summarize(ctx.dependents),
	});
}

/** Same placeholder mechanism as `buildPrompt`, but the only field a planning session has is the project. */
export function buildPlanningPrompt(template: string, projectName: string): string {
	return fill(template, { project: projectName });
}

/**
 * The command line the user will paste. The prompt is shell-quoted so it stays
 * a single argument no matter what the bead's description contains.
 */
export function buildCommand(profile: HarnessProfile, prompt: string): string {
	const quoted = shellQuote(prompt);
	const base = fill(profile.command, { model: profile.model, prompt: quoted });
	// A template that forgot {prompt} would otherwise silently drop it.
	return profile.command.includes("{prompt}") ? base : `${base} ${quoted}`;
}

/**
 * Split a whitespace-separated extra-args string into argv. No shell, no
 * quoting: these are flags the user typed, and they are passed to `spawn` as
 * discrete array elements, so nothing here can inject a second command.
 */
export function splitArgs(value: string | undefined): string[] {
	return (value ?? "").trim().split(/\s+/).filter(Boolean);
}

/** Split a launcher template into argv, substituting `{dir}` per-token. */
export function terminalArgv(template: string, dir: string): string[] {
	return template
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.split("{dir}").join(dir));
}

/**
 * Open the user's terminal emulator at `dir`. Only ever called from an explicit
 * button click in the preview modal — never automatically.
 */
export function openTerminalAt(template: string, dir: string): Promise<void> {
	const argv = terminalArgv(template, dir);
	const [cmd, ...args] = argv;
	if (!cmd) return Promise.reject(new Error("Terminal command is empty."));
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err) => {
			if (err) {
				reject(
					new Error(
						(err as NodeJS.ErrnoException).code === "ENOENT"
							? `Terminal command "${cmd}" not found. Set it in Beads settings.`
							: `Could not open a terminal: ${err.message}`,
					),
				);
				return;
			}
			resolve();
		});
	});
}

export interface WorkTheBeadDeps {
	opts: BdOptions;
	projectName: string;
	promptTemplate: string;
	terminalCommand: string;
	harnesses: HarnessProfile[];
	/** Host CLI profiles a harness may target, for validating `sessionCliId`. */
	sessionTargets: { id: string; displayName: string }[];
	/**
	 * Start a PTY session tab in the host plugin and type `prompt` into it
	 * WITHOUT submitting. Only ever called from an explicit button click.
	 */
	openPrimedSession: (request: PrimedSessionRequest) => Promise<void>;
	/**
	 * The same contract as `openPrimedSession`, except the caller mounts the
	 * terminal in a pane it owns (the bead editor) instead of in a new tab.
	 * Supplied only by callers that have such a pane; when absent the modal
	 * simply does not offer the route.
	 */
	openInlineSession?: (request: PrimedSessionRequest) => Promise<void>;
}

/**
 * Step 1: the harness menu, anchored on the clicked button. Picking a harness
 * gathers dependency context and opens the preview modal.
 */
export function showHarnessMenu(
	app: App,
	event: MouseEvent,
	issue: BeadIssue,
	deps: WorkTheBeadDeps,
): void {
	const menu = new Menu();
	if (deps.harnesses.length === 0) {
		menu.addItem((item) =>
			item.setTitle("No harnesses configured — add one in Beads settings").setDisabled(true),
		);
	}
	for (const harness of deps.harnesses) {
		menu.addItem((item) =>
			item
				.setTitle(harness.model ? `${harness.name} · ${harness.model}` : harness.name)
				.setIcon("terminal")
				.onClick(() => void openWorkPreview(app, issue, harness, deps)),
		);
	}
	menu.showAtMouseEvent(event);
}

async function openWorkPreview(
	app: App,
	issue: BeadIssue,
	harness: HarnessProfile,
	deps: WorkTheBeadDeps,
): Promise<void> {
	// Dependency context is best-effort: a bd hiccup must not block the flow.
	let blockers: BeadIssue[] = [];
	let dependents: BeadIssue[] = [];
	try {
		[blockers, dependents] = await Promise.all([
			bdDepList(deps.opts, issue.id, "down"),
			bdDepList(deps.opts, issue.id, "up"),
		]);
	} catch {
		blockers = [];
		dependents = [];
	}
	const prompt = buildPrompt(deps.promptTemplate, {
		issue,
		projectName: deps.projectName,
		blockers,
		dependents,
	});
	new AgentSessionModal(app, `Work ${issue.id}`, issue.id, harness, prompt, deps).open();
}

/**
 * A bead-agnostic counterpart to "Work the bead", for launching a planning
 * session while looking at the graph (or anything else that isn't one
 * specific bead) — same harness menu, same preview-before-anything-runs
 * modal, but a short, project-scoped prompt instead of a bead's fields.
 */
export function showPlanningMenu(app: App, event: MouseEvent, deps: WorkTheBeadDeps): void {
	const menu = new Menu();
	if (deps.harnesses.length === 0) {
		menu.addItem((item) =>
			item.setTitle("No harnesses configured — add one in Beads settings").setDisabled(true),
		);
	}
	for (const harness of deps.harnesses) {
		menu.addItem((item) =>
			item
				.setTitle(harness.model ? `${harness.name} · ${harness.model}` : harness.name)
				.setIcon("terminal")
				.onClick(() => {
					const prompt = buildPlanningPrompt(deps.promptTemplate, deps.projectName);
					new AgentSessionModal(app, "Plan", deps.projectName, harness, prompt, deps).open();
				}),
		);
	}
	menu.showAtMouseEvent(event);
}

/**
 * Step 2: show exactly what would run. Nothing here executes the agent — the
 * user copies the command and presses Enter in their own terminal.
 *
 * Shared by "Work the bead" and the bead-agnostic planning-session launcher —
 * `subjectLabel` names the session tab ("kestrel-3gy.42" or a project name);
 * `titlePrefix` is just the modal's heading ("Work kestrel-3gy.42" / "Plan").
 */
class AgentSessionModal extends Modal {
	constructor(
		app: App,
		private titlePrefix: string,
		private subjectLabel: string,
		private harness: HarnessProfile,
		private prompt: string,
		private deps: WorkTheBeadDeps,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("beads-work");
		this.modalEl.addClass("beads-work-modal"); // wider dialog — the default width crowds two editable textareas
		this.titleEl.setText(`${this.titlePrefix} with ${this.harness.name}`);

		const command = buildCommand(this.harness, this.prompt);
		const target = this.resolveSessionTarget();

		const canInline = !!target && !!this.deps.openInlineSession;
		contentEl.createDiv({
			cls: "beads-work-note",
			text: target
				? `Nothing is submitted from Obsidian. Copy the command and run it yourself, or start a ${target.displayName} session${canInline ? " — here in this bead, or in its own tab" : " tab"}. Either session starts the agent in ${this.deps.projectName} and types the prompt into its input box, but you still press Enter.`
				: "Nothing runs from Obsidian. Copy the command, open a terminal in the project, paste it, and press Enter yourself.",
		});

		contentEl.createDiv({ cls: "beads-work-section", text: "Command" });
		const cmdBox = contentEl.createEl("textarea", { cls: "beads-work-command" });
		cmdBox.value = command;
		cmdBox.rows = 6;

		contentEl.createDiv({ cls: "beads-work-section", text: "Prompt" });
		const promptBox = contentEl.createEl("textarea", { cls: "beads-work-prompt" });
		promptBox.value = this.prompt;
		promptBox.rows = 18;

		const actions = contentEl.createDiv({ cls: "beads-work-actions" });

		if (target) {
			// The in-Obsidian routes. Both start the same session in the same
			// directory with the same never-submitted prompt; they differ only in
			// where the terminal is mounted. `mod-cta` sits on whichever is the
			// more contextual one, but either way this is a second, explicit
			// click on a modal the user had to open by picking a harness.
			const request = (): PrimedSessionRequest => ({
				cliId: target.id,
				cwd: this.deps.opts.cwd,
				additionalArgs: splitArgs(this.harness.sessionArgs),
				// No trailing newline: this types, it does not submit. Reads the
				// box's current text, so an edit the user made here is what
				// actually gets typed — not the originally generated prompt.
				prompt: promptBox.value,
				title: `${this.subjectLabel} · ${this.harness.name}`,
			});

			const inline = this.deps.openInlineSession;
			if (inline) {
				this.sessionButton(
					actions,
					"beads-work-inline mod-cta",
					"panel-bottom",
					`Run ${target.displayName} in this bead`,
					() => inline(request()),
				);
			}
			this.sessionButton(
				actions,
				inline ? "beads-work-session" : "beads-work-session mod-cta",
				"terminal-square",
				`Open ${target.displayName} session tab`,
				() => this.deps.openPrimedSession(request()),
			);
		}

		this.copyButton(actions, "Copy command", () => cmdBox.value, !target);
		this.copyButton(actions, "Copy prompt only", () => promptBox.value, false);

		const termBtn = actions.createEl("button", { cls: "beads-work-term" });
		setIcon(termBtn.createSpan(), "terminal");
		termBtn.createSpan({ text: `Open terminal in ${this.deps.projectName}` });
		termBtn.onclick = () => {
			openTerminalAt(this.deps.terminalCommand, this.deps.opts.cwd).catch(
				(e: Error) => new Notice(`Beads: ${e.message}`),
			);
		};
	}

	/**
	 * The host CLI profile this harness targets, or null when the harness is
	 * copy-only or names a profile the user has since deleted. A dangling id
	 * degrades to the pre-merge copy-only modal rather than guessing a profile.
	 */
	private resolveSessionTarget(): { id: string; displayName: string } | null {
		const id = this.harness.sessionCliId?.trim();
		if (!id) return null;
		return this.deps.sessionTargets.find((t) => t.id === id) ?? null;
	}

	/**
	 * One of the two session routes. Disabled while its promise is in flight so
	 * a double-click cannot start two agents, and re-enabled on failure so the
	 * user can retry or fall back to copying.
	 */
	private sessionButton(
		parent: HTMLElement,
		cls: string,
		icon: string,
		label: string,
		run: () => Promise<void>,
	): void {
		const btn = parent.createEl("button", { cls });
		setIcon(btn.createSpan(), icon);
		btn.createSpan({ text: label });
		btn.onclick = () => {
			btn.disabled = true;
			run().then(
				() => this.close(),
				(e: Error) => {
					btn.disabled = false;
					new Notice(`Beads: ${e.message}`);
				},
			);
		};
	}

	/** `getText` reads live at click time, so an edit to the box is what's copied. */
	private copyButton(
		parent: HTMLElement,
		label: string,
		getText: () => string,
		cta: boolean,
	): void {
		const btn = parent.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
		btn.onclick = () => {
			navigator.clipboard.writeText(getText()).then(
				() => new Notice(`Beads: ${label.toLowerCase()} — copied.`),
				() => new Notice("Beads: could not write to the clipboard."),
			);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
