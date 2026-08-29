import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type ClaudeCodeTabsPlugin from './main';
import type { ClaudeCodeTabsSettings, TabLaunchConfig } from './types';
import { buildTerminalTheme } from './TerminalTheme';
import { isBlockedClearingInput } from './AgentActivity';

/**
 * Build a configured xterm instance and attach it to `container`.
 *
 * Extracted verbatim from ClaudeSessionView.onOpen so the tab view and the
 * embedded pane below construct identical terminals (font, theme, unicode,
 * renderer, Escape handling). Deliberately narrow: this owns terminal
 * CONSTRUCTION only — no session wiring, no persistence, no view lifecycle.
 * Everything ClaudeSessionView does around it (scrollback serialization, OSC 52
 * clipboard sync, resume/restore state) stays in ClaudeSessionView, because it
 * is inseparable from the ItemView's getState/setState contract.
 */
export function createTerminalInstance(
	settings: ClaudeCodeTabsSettings,
	container: HTMLElement
): { terminal: Terminal; fitAddon: FitAddon } {
	const terminal = new Terminal({
		fontFamily: settings.terminalFontFamily,
		fontSize: settings.defaultFontSize,
		lineHeight: 1.0,
		letterSpacing: 0,
		customGlyphs: settings.terminalCustomGlyphs,
		rescaleOverlappingGlyphs: !settings.terminalCustomGlyphs,
		scrollback: 1000,
		cursorBlink: true,
		allowProposedApi: true,
		cancelEvents: true,
		macOptionIsMeta: true,
		theme: buildTerminalTheme(settings.terminalThemeName)
	});

	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);

	try {
		const unicodeAddon = new Unicode11Addon();
		terminal.loadAddon(unicodeAddon);
		terminal.unicode.activeVersion = '11';
	} catch (e) {
		console.debug('[TerminalAgentTabs] Unicode11 addon could not be loaded:', e);
	}

	terminal.open(container);

	// Pressing Escape in the terminal appears to blur it and hand focus
	// elsewhere in Obsidian. xterm already stops the Escape keydown from
	// bubbling on its own, but not the keyup — stop that here too, on the
	// chance Obsidian's keymap reacts to it. Returning true keeps xterm's
	// own handling intact so the CLI underneath still receives the Esc
	// byte (its interrupt key).
	terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
		}
		return true;
	});

	try {
		const webglAddon = new WebglAddon();
		webglAddon.onContextLoss(() => {
			// Fall back to canvas renderer if WebGL context is lost
			webglAddon.dispose();
		});
		terminal.loadAddon(webglAddon);
	} catch (e) {
		console.debug('[TerminalAgentTabs] WebGL renderer not available, using canvas fallback:', e);
	}

	return { terminal, fitAddon };
}

/**
 * Snapshot the active bottom screen so TUI cursor movement cannot leave stale
 * raw lines. Shared by both terminal surfaces; feeds OutputMonitor's screen
 * rules.
 */
export function visibleTerminalText(terminal: Terminal | null): string {
	if (!terminal) return '';
	const buffer = terminal.buffer.active;
	const start = buffer.baseY;
	const end = Math.min(buffer.length, start + terminal.rows);
	const lines: string[] = [];
	for (let index = start; index < end; index++) {
		lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

export interface TerminalPaneRequest {
	cliId: string;
	additionalArgs: string[];
	cwd: string;
}

export interface TerminalPaneOptions {
	/** Called when the CLI retitles itself (OSC 0/2), e.g. to label the pane. */
	onTitle?: (title: string) => void;
	/** Called when the underlying process exits. */
	onExit?: (exitCode: number) => void;
}

/**
 * A live agent terminal mounted inside an ARBITRARY container element, rather
 * than inside a workspace tab of its own. Used by the bead editor to run an
 * agent next to the bead it is about (see BeadEditorView).
 *
 * Scope, stated plainly: this is the always-fresh case. It starts one session
 * in 'new' mode and does not participate in Obsidian's view-state persistence,
 * so there is no resume, no scrollback restore and no cross-restart identity —
 * all of which live in ClaudeSessionView because they are driven by that view's
 * getState/setState. An embedded pane is closed by closing it; nothing about it
 * needs to survive a restart.
 */
export class TerminalPane {
	readonly sessionId: string = crypto.randomUUID();

	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private terminalEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private exited = false;
	private disposed = false;

	constructor(
		private plugin: ClaudeCodeTabsPlugin,
		private container: HTMLElement,
		private options: TerminalPaneOptions = {}
	) {}

	/**
	 * Mount the terminal and spawn the session. Throws if the process could not
	 * be started — the caller owns the error surface (a Notice, usually) and
	 * should dispose() this pane.
	 */
	start(request: TerminalPaneRequest): void {
		// Reuse the tab view's terminal CSS wholesale — same element class, so
		// there is exactly one place that tunes xterm's layout for this plugin.
		this.terminalEl = this.container.createDiv({ cls: 'claude-terminal' });
		const { terminal, fitAddon } = createTerminalInstance(this.plugin.settings, this.terminalEl);
		this.terminal = terminal;
		this.fitAddon = fitAddon;
		fitAddon.fit();

		terminal.onTitleChange((title: string) => this.options.onTitle?.(title));

		terminal.onData((data: string) => {
			if (isBlockedClearingInput(data)) {
				this.plugin.sessionManager.updateSessionActivity(this.sessionId, 'user-input');
			}
			this.plugin.sessionManager.writeToSession(this.sessionId, data);
		});

		terminal.onResize(({ cols, rows }) => {
			this.plugin.sessionManager.resizeSession(this.sessionId, cols, rows);
		});

		this.resizeObserver = new ResizeObserver(() => {
			if (this.fitAddon && this.terminal && !this.exited) {
				this.fitAddon.fit();
			}
		});
		this.resizeObserver.observe(this.terminalEl);

		const launchConfig: Partial<TabLaunchConfig> = {
			cliId: request.cliId,
			additionalArgs: request.additionalArgs
		};

		this.plugin.sessionManager.createSession(
			this.sessionId,
			(data: string) => this.handleData(data),
			(exitCode: number) => {
				this.exited = true;
				this.options.onExit?.(exitCode);
			},
			'new',
			launchConfig,
			request.cwd
		);

		this.plugin.sessionManager.updateSessionTerminal(this.sessionId, terminal, fitAddon);
		fitAddon.fit();
		this.plugin.sessionManager.resizeSession(this.sessionId, terminal.cols, terminal.rows);
	}

	focus(): void {
		this.terminal?.focus();
	}

	fit(): void {
		if (this.fitAddon && this.terminal && !this.exited) {
			this.fitAddon.fit();
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		this.resizeObserver?.disconnect();
		this.resizeObserver = null;

		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.terminalEl?.remove();
		this.terminalEl = null;

		this.plugin.outputMonitor.removeSession(this.sessionId);
		await this.plugin.sessionManager.terminateSession(this.sessionId);
	}

	/**
	 * Feed the output monitor as well as the screen. Not optional: the priming
	 * handshake in main.ts waits on `session.lastOutputLine` to decide the agent
	 * has painted something, and that field is only ever set from here.
	 */
	private handleData(data: string): void {
		if (!this.terminal || this.exited) return;
		this.terminal.write(data);
		this.plugin.outputMonitor.feed(this.sessionId, data, {
			profile: this.plugin.sessionManager.getOutputDetectionProfile(this.sessionId),
			getVisibleText: () => visibleTerminalText(this.terminal)
		});
		const lastLine = this.plugin.outputMonitor.getLastLine(this.sessionId);
		if (lastLine) {
			this.plugin.sessionManager.updateSessionLastOutput(this.sessionId, lastLine);
		}
	}
}
