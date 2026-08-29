import { Plugin, WorkspaceLeaf, Notice, FuzzySuggestModal, App, Editor, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import { ClaudeSessionView, VIEW_TYPE_CLAUDE_SESSION } from './ClaudeSessionView';
import {
	SessionManager,
	SPECIAL_CLI_ID_DEFAULT_SHELL
} from './SessionManager';
import { NotificationStore } from './NotificationStore';
import { OutputMonitor } from './OutputMonitor';
import { HookEventMonitor, resolveHookSessionId } from './HookEventMonitor';
import { DockBadge } from './DockBadge';
import { ensureEmbeddedResources } from './EmbeddedResources';
import { SessionSidebarView, VIEW_TYPE_SESSION_SIDEBAR } from './SessionSidebarView';
import { ClaudeCodeTabsSettingTab } from './settings';
import {
	ClaudeCodeTabsSettings,
	DEFAULT_SETTINGS,
	DEFAULT_TERMINAL_FONT_FAMILY,
	type CliProfile,
	type SessionListDensity,
	type TabLaunchConfig,
} from './types';
import { hookActivityEvent, preToolUseActivityEvent } from './AgentActivity';
import { migrateCliProfiles, type LegacySettingsShape } from './SettingsMigration';
import { trimLogFileIfOversized } from './HookLogMaintenance';
import { BeadsFeature, type BeadsHost, type InlineAgentSession, type PrimedSessionRequest } from './beads/feature';
import { TerminalPane } from './TerminalPane';
import type { BeadsSettings } from './beads/settings';

/** Electron shell/beep API exposed via window.require('electron') in Obsidian desktop */
interface ElectronShellModule {
	shell?: { beep(): void };
}
interface ElectronRequireWindow extends Window {
	require?: (module: 'electron') => ElectronShellModule;
	AudioContext?: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
}

function sanitizeTerminalFontFamily(value: unknown): string {
	if (typeof value !== 'string') return DEFAULT_TERMINAL_FONT_FAMILY;
	const trimmed = value.trim();
	if (!trimmed) return DEFAULT_TERMINAL_FONT_FAMILY;
	if (trimmed.includes('var(')) return DEFAULT_TERMINAL_FONT_FAMILY;
	return trimmed;
}

function sanitizeTerminalCustomGlyphs(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	return DEFAULT_SETTINGS.terminalCustomGlyphs;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default class ClaudeCodeTabsPlugin extends Plugin {
	settings: ClaudeCodeTabsSettings;
	sessionManager: SessionManager;
	notificationStore: NotificationStore;
	outputMonitor: OutputMonitor;
	private hookEventMonitor: HookEventMonitor;
	private dockBadge: DockBadge;
	private pendingLaunchConfig: Partial<TabLaunchConfig> | null = null;
	/** The beads half of the merged plugin. */
	beads: BeadsFeature;
	/** Raw persisted beads settings, folded back into data.json on save. */
	private beadsPersisted: Partial<BeadsSettings> | null = null;
	/**
	 * cwd for the next tab opened by openPrimedAgentSession, consumed by the
	 * view alongside pendingLaunchConfig. Mirrors that field's one-shot handoff.
	 */
	private pendingSessionCwd: string | null = null;

	async onload() {
		await this.loadSettings();

		this.sessionManager = new SessionManager(this);
		ensureEmbeddedResources(this.sessionManager.getPluginDir());
		// Phase 4: drop scrollback files from tabs closed long ago (recent ones survive for restore).
		this.sessionManager.pruneScrollback(14 * 24 * 60 * 60 * 1000);
		this.notificationStore = new NotificationStore();
		this.outputMonitor = new OutputMonitor();
		this.dockBadge = new DockBadge();

		// Dock badge counts sessions currently blocked on the user — an
		// actionable number, unlike an unread-notification total. Activity
		// transitions fire sessionManager's notifyChange, so this stays live.
		this.sessionManager.onChange(() => {
			this.dockBadge.update(this.sessionManager.getBlockedSessionCount());
		});
		this.hookEventMonitor = new HookEventMonitor({
			pollIntervalMs: this.settings.hookEventsPollIntervalMs,
			debugLogging: this.settings.enableDebugLogging,
			maxSizeBytes: this.getHookLogMaxSizeBytes(),
			maxGenerations: this.settings.hookLogMaxGenerations,
			callback: (event) => this.handleHookEvent(event)
		});
		// Safety valve (D): a pre-existing oversized log (e.g. from before rotation shipped)
		// won't shrink on its own via rotation, since that only triggers on new growth.
		try {
			await trimLogFileIfOversized(this.getEffectiveHookEventsFilePath(), this.getHookLogMaxSizeBytes());
		} catch (error) {
			if (this.settings.enableDebugLogging) {
				console.debug('[TerminalAgentTabs] startup hook log trim failed:', error);
			}
		}

		// Auto-generate notifications from terminal output patterns
		this.outputMonitor.onEvent((sessionId, event) => {
			if (event.kind === 'activity_update') {
				this.sessionManager.updateSessionActivity(sessionId, 'screen-unblocked');
			} else if (event.kind === 'action_needed') {
				if (event.agentActivity === 'blocked') {
					this.sessionManager.updateSessionActivity(sessionId, 'screen-blocked');
				}
				this.notificationStore.addNotification(
					sessionId, 'action_needed', 'Action Needed', event.message, 'terminal'
				);
				this.playHookNotificationSound('action');
			} else if (event.kind === 'task_complete') {
				this.notificationStore.addNotification(
					sessionId, 'task_complete', 'Task Complete', event.message, 'terminal'
				);
				this.playHookNotificationSound('complete');
			}
		});

		// Register custom view
		this.registerView(
			VIEW_TYPE_CLAUDE_SESSION,
			(leaf: WorkspaceLeaf) => new ClaudeSessionView(leaf, this)
		);

		// Register sidebar view
		this.registerView(
			VIEW_TYPE_SESSION_SIDEBAR,
			(leaf: WorkspaceLeaf) => new SessionSidebarView(leaf, this)
		);

		// Ribbon icon to toggle sidebar
		this.addRibbonIcon('terminal', 'Agent sessions', () => {
			void this.toggleSidebar();
		});

		// Command: New Session Tab
		this.addCommand({
			id: 'new-session-tab',
			name: 'New session tab',
			callback: () => { void this.openNewSession({ cliId: this.settings.defaultCliId }); }
		});

		// Command: New Session Tab (Choose Target)
		this.addCommand({
			id: 'new-session-tab-choose-target',
			name: 'New session tab (choose target)',
			callback: () => { void this.openNewSessionWithPicker(); }
		});

		// Command: Send Selection to Current Session
		this.addCommand({
			id: 'send-selection',
			name: 'Send selection to current session',
			editorCallback: (editor) => this.sendSelection(editor)
		});

		// Command: Increase Font Size (this tab)
		this.addCommand({
			id: 'increase-font-size',
			name: 'Increase font size (this tab)',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveClaudeSessionView();
				if (view) {
					if (!checking) {
						view.increaseFontSize();
					}
					return true;
				}
				return false;
			}
		});

		// Command: Decrease Font Size (this tab)
		this.addCommand({
			id: 'decrease-font-size',
			name: 'Decrease font size (this tab)',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveClaudeSessionView();
				if (view) {
					if (!checking) {
						view.decreaseFontSize();
					}
					return true;
				}
				return false;
			}
		});

		// Command: Reset Font Size (this tab)
		this.addCommand({
			id: 'reset-font-size',
			name: 'Reset font size (this tab)',
			checkCallback: (checking: boolean) => {
				const view = this.getActiveClaudeSessionView();
				if (view) {
					if (!checking) {
						view.resetFontSize();
					}
					return true;
				}
				return false;
			}
		});

		// Command: Toggle Session Sidebar
		this.addCommand({
			id: 'toggle-session-sidebar',
			name: 'Toggle session sidebar',
			callback: () => { void this.toggleSidebar(); }
		});

		// Command: Focus Active Session
		this.addCommand({
			id: 'focus-active-session',
			name: 'Focus active session',
			callback: () => this.focusActiveSession()
		});

		// Command: Focus Next Session
		this.addCommand({
			id: 'focus-next-session',
			name: 'Focus next session',
			callback: () => this.focusSessionByOffset(1)
		});

		// Command: Focus Previous Session
		this.addCommand({
			id: 'focus-previous-session',
			name: 'Focus previous session',
			callback: () => this.focusSessionByOffset(-1)
		});

		// Command: Split Session Horizontal
		this.addCommand({
			id: 'split-session-horizontal',
			name: 'Split session (horizontal)',
			callback: () => { void this.splitSession('horizontal'); }
		});

		// Command: Split Session Vertical
		this.addCommand({
			id: 'split-session-vertical',
			name: 'Split session (vertical)',
			callback: () => { void this.splitSession('vertical'); }
		});

		// Track active session for Send Selection + mark notifications as read.
		// Also focus the terminal itself: switching to a session tab (by clicking
		// its header, cycling panes, etc.) should let the user type immediately
		// rather than leaving focus wherever it was on the previously active leaf.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof ClaudeSessionView) {
					const view = leaf.view;
					this.sessionManager.setActiveSession(view.sessionId);
					this.notificationStore.dismissAllForSession(view.sessionId);
					view.focusTerminal();
				}
			})
		);

		// Beads merge: bring up the beads half before the shared settings tab, so
		// the tab can render both sections. Registrations it makes go through the
		// host, which means this plugin's own unload still tears them down.
		this.beads = new BeadsFeature(this.beadsHost(), this.beadsPersisted);
		this.beads.load();

		// Add settings tab (both halves, two sections)
		this.addSettingTab(new ClaudeCodeTabsSettingTab(this.app, this));
		this.restartHookEventMonitor();

		// Window unload handler for emergency cleanup
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				void this.sessionManager.terminateAllSessions();
			})
		);
	}

	onunload(): void {
		this.beads?.unload();
		this.hookEventMonitor.stop();
		this.dockBadge.clear();
		this.outputMonitor.destroy();
		void this.sessionManager.terminateAllSessions();
	}

	async loadSettings() {
		const loaded = ((await this.loadData()) || {}) as LegacySettingsShape & {
			beads?: Partial<BeadsSettings>;
		};
		// Beads merge: the two halves share one data.json. Beads settings live
		// under a `beads` key so neither half's field names can shadow the
		// other's, and so a future rename on one side cannot corrupt the other.
		this.beadsPersisted = loaded.beads ?? null;
		const cliProfiles = migrateCliProfiles(loaded);
		const legacyDefault = loaded.defaultCliId;
		const isSpecialDefault = legacyDefault === SPECIAL_CLI_ID_DEFAULT_SHELL;
		const resolvedDefaultCliId = cliProfiles.some((profile) => profile.id === legacyDefault) || isSpecialDefault
			? (legacyDefault as string)
			: (cliProfiles.find((profile) => profile.id === 'claude')?.id || cliProfiles[0].id);

		// 'detailed' was removed; migrate persisted values to 'normal'. Anything
		// else unrecognized falls back to the default.
		let sessionListDensity: SessionListDensity = DEFAULT_SETTINGS.sessionListDensity;
		if (loaded.sessionListDensity === 'compact' || loaded.sessionListDensity === 'normal') {
			sessionListDensity = loaded.sessionListDensity;
		} else if (loaded.sessionListDensity === 'detailed') {
			sessionListDensity = 'normal';
		}

		this.settings = {
			defaultFontSize: loaded.defaultFontSize ?? DEFAULT_SETTINGS.defaultFontSize,
			terminalFontFamily: sanitizeTerminalFontFamily(loaded.terminalFontFamily),
			terminalCustomGlyphs: sanitizeTerminalCustomGlyphs(loaded.terminalCustomGlyphs),
			enableOsc52ClipboardSync:
				loaded.enableOsc52ClipboardSync ?? DEFAULT_SETTINGS.enableOsc52ClipboardSync,
			enableShellCwdTracking:
				loaded.enableShellCwdTracking ?? DEFAULT_SETTINGS.enableShellCwdTracking,
			enableHookNotifications:
				loaded.enableHookNotifications ?? DEFAULT_SETTINGS.enableHookNotifications,
			enableHookNotificationSound:
				loaded.enableHookNotificationSound ?? DEFAULT_SETTINGS.enableHookNotificationSound,
			hookEventsFilePath:
				typeof loaded.hookEventsFilePath === 'string'
					? loaded.hookEventsFilePath
					: DEFAULT_SETTINGS.hookEventsFilePath,
			hookEventsPollIntervalMs:
				typeof loaded.hookEventsPollIntervalMs === 'number' && Number.isFinite(loaded.hookEventsPollIntervalMs)
					? Math.max(250, Math.min(10000, Math.floor(loaded.hookEventsPollIntervalMs)))
					: DEFAULT_SETTINGS.hookEventsPollIntervalMs,
			hookLogNotificationEnabled:
				loaded.hookLogNotificationEnabled ?? DEFAULT_SETTINGS.hookLogNotificationEnabled,
			hookLogStopEnabled:
				loaded.hookLogStopEnabled ?? DEFAULT_SETTINGS.hookLogStopEnabled,
			hookLogPreToolUseEnabled:
				loaded.hookLogPreToolUseEnabled ?? DEFAULT_SETTINGS.hookLogPreToolUseEnabled,
			hookLogMaxSizeMb:
				typeof loaded.hookLogMaxSizeMb === 'number' && Number.isFinite(loaded.hookLogMaxSizeMb) && loaded.hookLogMaxSizeMb > 0
					? loaded.hookLogMaxSizeMb
					: DEFAULT_SETTINGS.hookLogMaxSizeMb,
			hookLogMaxGenerations:
				typeof loaded.hookLogMaxGenerations === 'number' && Number.isFinite(loaded.hookLogMaxGenerations) && loaded.hookLogMaxGenerations >= 1
					? Math.floor(loaded.hookLogMaxGenerations)
					: DEFAULT_SETTINGS.hookLogMaxGenerations,
			wrapSelectionInCodeBlock:
				loaded.wrapSelectionInCodeBlock ?? DEFAULT_SETTINGS.wrapSelectionInCodeBlock,
			includeNotePathInSelectionSend:
				loaded.includeNotePathInSelectionSend ?? DEFAULT_SETTINGS.includeNotePathInSelectionSend,
			enableDebugLogging: loaded.enableDebugLogging ?? DEFAULT_SETTINGS.enableDebugLogging,
			defaultCliId: resolvedDefaultCliId,
			terminalThemeName:
				typeof loaded.terminalThemeName === 'string'
					? loaded.terminalThemeName
					: DEFAULT_SETTINGS.terminalThemeName,
			sessionListDensity,
			cliProfiles
		};
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			beads: this.beads ? this.beads.settings : this.beadsPersisted
		});
	}

	getDefaultHookEventsFilePath(): string {
		const adapter = this.app.vault.adapter;
		const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
		const configDir = this.app.vault.configDir;
		return path.join(vaultPath, configDir, 'plugins', this.manifest.id, 'agent-events.jsonl');
	}

	getEffectiveHookEventsFilePath(): string {
		const configured = this.settings.hookEventsFilePath?.trim();
		return configured || this.getDefaultHookEventsFilePath();
	}

	getHookLogMaxSizeBytes(): number {
		return Math.max(1, Math.floor(this.settings.hookLogMaxSizeMb * 1024 * 1024));
	}

	restartHookEventMonitor(): void {
		this.hookEventMonitor.updateConfig({
			pollIntervalMs: this.settings.hookEventsPollIntervalMs,
			debugLogging: this.settings.enableDebugLogging,
			maxSizeBytes: this.getHookLogMaxSizeBytes(),
			maxGenerations: this.settings.hookLogMaxGenerations
		});
		this.hookEventMonitor.start(this.getEffectiveHookEventsFilePath());
	}

	private handleHookEvent(event: import('./HookEventMonitor').HookEvent): void {
		// AskUserQuestion shows its picker without firing any Notification
		// hook, so its PreToolUse line is the only "waiting on the user"
		// signal. Flip the activity dot only — like every agent_event it
		// stays silent (no notification, no sound).
		const preToolUseEvent = preToolUseActivityEvent(event.toolName);
		if (preToolUseEvent) {
			const target = this.resolveHookTargetSessionId(event);
			if (target) {
				this.sessionManager.updateSessionActivity(target, preToolUseEvent);
			}
		}

		// Skip agent_event notifications (e.g. pre-tool-use) as they are
		// high-frequency informational events that don't require user attention.
		if (event.notificationType === 'agent_event') {
			return;
		}

		const targetSessionId = this.resolveHookTargetSessionId(event);

		// Drive the agent activity state from the hook stream. The heuristic
		// fallback can still mis-attribute the event when several sessions
		// run at once; that is self-repairing: if 'blocked' lands on a
		// session that is actually mid-turn, its next braille spinner title
		// flips it straight back to 'working'.
		if (targetSessionId) {
			const activityEvent = hookActivityEvent(event.notificationType, event.rawNotificationType);
			if (activityEvent) {
				this.sessionManager.updateSessionActivity(targetSessionId, activityEvent);
			}
		}

		this.notificationStore.addNotification(
			targetSessionId,
			event.notificationType,
			event.notificationTitle,
			event.message,
			event.source
		);

		if (this.settings.enableHookNotifications) {
			const noticeTimeout = event.notificationType === 'action_needed' ? 10000 : 5000;
			new Notice(`[${event.notificationTitle}] ${event.message}`, noticeTimeout);
		}
		this.playHookNotificationSound(event.soundKind);
	}

	/** See resolveHookSessionId() for the resolution order and rationale. */
	private resolveHookTargetSessionId(event: import('./HookEventMonitor').HookEvent): string {
		return resolveHookSessionId(event, {
			hasSession: (sessionId) => !!this.sessionManager.getSession(sessionId),
			findByAgentSessionId: (agentSessionId) =>
				this.sessionManager.findSessionIdByAgentSessionId(agentSessionId),
			fallback: () => this.sessionManager.resolveNotificationSessionId()
		});
	}

	private playHookNotificationSound(kind: 'action' | 'complete' | 'event'): void {
		if (!this.settings.enableHookNotificationSound) return;

		try {
			const electron = (window as ElectronRequireWindow).require?.('electron');
			if (electron?.shell?.beep) {
				electron.shell.beep();
				if (kind === 'action') {
					window.setTimeout(() => {
						try {
							electron.shell.beep();
						} catch {
							// ignore
						}
					}, 120);
				}
				return;
			}
		} catch {
			// fallback to web audio below
		}

		try {
			const w = window as ElectronRequireWindow;
			const AudioCtx = w.AudioContext ?? w.webkitAudioContext;
			if (!AudioCtx) return;
			const ctx = new AudioCtx();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = 'sine';
			osc.frequency.value = kind === 'action' ? 920 : kind === 'complete' ? 740 : 620;
			gain.gain.value = 0.03;
			osc.connect(gain);
			gain.connect(ctx.destination);
			const now = ctx.currentTime;
			osc.start(now);
			osc.stop(now + 0.08);
			osc.onended = () => {
				void ctx.close();
			};
		} catch {
			// no-op if audio APIs are unavailable
		}
	}

	private async toggleSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_SIDEBAR);
		if (existing.length > 0) {
			existing[0].detach();
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE_SESSION_SIDEBAR,
				active: true
			});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	private async splitSession(direction: 'horizontal' | 'vertical'): Promise<void> {
		const launchConfig: Partial<TabLaunchConfig> = { cliId: this.settings.defaultCliId };
		this.pendingLaunchConfig = launchConfig;
		const leaf = this.app.workspace.getLeaf('split', direction);
		await leaf.setViewState({
			type: VIEW_TYPE_CLAUDE_SESSION,
			state: { initialLaunchConfig: launchConfig },
			active: true
		});
		void this.app.workspace.revealLeaf(leaf);
	}

	async openNewSession(initialLaunchConfig?: Partial<TabLaunchConfig>) {
		this.pendingLaunchConfig = initialLaunchConfig ?? null;
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_CLAUDE_SESSION,
			state: initialLaunchConfig ? { initialLaunchConfig } : {},
			active: true
		});
		void this.app.workspace.revealLeaf(leaf);
	}

	consumePendingLaunchConfig(): Partial<TabLaunchConfig> | null {
		const pending = this.pendingLaunchConfig;
		this.pendingLaunchConfig = null;
		return pending;
	}

	consumePendingSessionCwd(): string | null {
		const pending = this.pendingSessionCwd;
		this.pendingSessionCwd = null;
		return pending;
	}

	/**
	 * BEADS MERGE — the in-process "Work the bead" path.
	 *
	 * Opens a session tab running `request.cliId` in `request.cwd`, then TYPES
	 * `request.prompt` into that session's stdin. Deliberately WITHOUT a
	 * trailing newline: the prompt lands in the agent's input box the way a
	 * paste would, and the user reads it, edits it if they want, and presses
	 * Enter themselves. Nothing here submits a prompt to an agent.
	 *
	 * The prompt goes to stdin, never to argv, so bead text is never shell- or
	 * argument-parsed by anything.
	 */
	async openPrimedAgentSession(request: PrimedSessionRequest): Promise<void> {
		this.pendingSessionCwd = request.cwd;
		await this.openNewSession({
			cliId: request.cliId,
			additionalArgs: request.additionalArgs
		});
		const view = this.app.workspace.getActiveViewOfType(ClaudeSessionView);
		if (!view) {
			this.pendingSessionCwd = null;
			throw new Error('Could not open a session tab.');
		}
		await this.primeSession(view.sessionId, request.prompt);
	}

	/**
	 * BEADS MERGE — the EMBEDDED variant of the same flow.
	 *
	 * Identical in every respect that matters to the tab flow above (fresh
	 * session, bead's project directory, prompt TYPED into stdin with no
	 * trailing newline, user presses Enter) except that the terminal is mounted
	 * into `container` — an element owned by the bead editor — instead of into a
	 * workspace tab of its own. `openPrimedAgentSession` is untouched and is
	 * still what the "Open session tab" button calls.
	 *
	 * Throws synchronously if the session could not be spawned; the returned
	 * `primed` promise rejects if the prompt could not be typed.
	 */
	mountInlineAgentSession(container: HTMLElement, request: PrimedSessionRequest): InlineAgentSession {
		const pane = new TerminalPane(this, container, {
			onTitle: (title) => this.sessionManager.updateSessionHeader(pane.sessionId, title)
		});
		try {
			pane.start({
				cliId: request.cliId,
				additionalArgs: request.additionalArgs,
				cwd: request.cwd
			});
		} catch (error) {
			void pane.dispose();
			throw error instanceof Error ? error : new Error(String(error));
		}
		return {
			focus: () => pane.focus(),
			fit: () => pane.fit(),
			dispose: () => pane.dispose(),
			primed: this.primeSession(pane.sessionId, request.prompt)
		};
	}

	/**
	 * Type `prompt` into a just-started session once its agent has painted
	 * something, so the text lands in a ready input box rather than being eaten
	 * by a TUI that is still initializing.
	 *
	 * Best-effort by nature: there is no portable "the agent is ready" signal
	 * across arbitrary CLIs, so this waits for first output plus a short settle,
	 * then writes. If the agent never produces output within the window the
	 * write is skipped and the user is told, rather than blind-typing into an
	 * unknown state.
	 */
	private async primeSession(sessionId: string, prompt: string): Promise<void> {
		const READY_TIMEOUT_MS = 20_000;
		const SETTLE_MS = 700;
		const POLL_MS = 150;

		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			const session = this.sessionManager.getSession(sessionId);
			if (!session || session.status === 'exited' || session.status === 'error') {
				throw new Error('The session exited before the prompt could be sent.');
			}
			if (session.lastOutputLine) break;
			if (Date.now() > deadline) {
				new Notice(
					'Beads: the session did not finish starting, so the prompt was not typed into it. It is still on your clipboard route — reopen the preview to copy it.'
				);
				return;
			}
			await sleep(POLL_MS);
		}
		await sleep(SETTLE_MS);
		// No trailing newline. This types; it does not submit.
		this.sessionManager.writeToSession(sessionId, prompt);
		new Notice('Beads: prompt typed into the session — review it, then press Enter.');
	}

	/** CLI profiles offered as "Work the bead" session targets. */
	listSessionTargets(): { id: string; displayName: string }[] {
		return this.settings.cliProfiles.map((p) => ({
			id: p.id,
			displayName: p.displayName
		}));
	}

	/** This plugin, viewed through the narrow surface BeadsFeature needs. */
	private beadsHost(): BeadsHost {
		return {
			app: this.app,
			saveSettings: () => this.saveSettings(),
			registerView: (type, factory) => this.registerView(type, factory),
			addRibbonIcon: (icon, title, cb) => this.addRibbonIcon(icon, title, cb),
			addCommand: (command) => { this.addCommand(command); },
			addStatusBarItem: () => this.addStatusBarItem(),
			registerInterval: (id) => this.registerInterval(id),
			registerMarkdownCodeBlockProcessor: (language, handler) =>
				this.registerMarkdownCodeBlockProcessor(language, handler),
			openPrimedAgentSession: (request) => this.openPrimedAgentSession(request),
			mountInlineAgentSession: (container, request) =>
				this.mountInlineAgentSession(container, request),
			listSessionTargets: () => this.listSessionTargets()
		};
	}

	applyTerminalAppearanceToOpenSessions(options?: { resetFontSize?: boolean }): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_SESSION);
		for (const leaf of leaves) {
			if (leaf.view instanceof ClaudeSessionView) {
				leaf.view.applyTerminalAppearanceSettings(options);
			}
		}
	}

	refreshSessionSidebars(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SESSION_SIDEBAR);
		for (const leaf of leaves) {
			if (leaf.view instanceof SessionSidebarView) {
				leaf.view.render();
			}
		}
	}

	private focusActiveSession(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_SESSION);
		if (leaves.length === 0) return;

		// Try last active session first (regardless of running status)
		const lastActiveId = this.sessionManager.getLastActiveSessionId();
		if (lastActiveId) {
			const leaf = leaves.find((l) =>
				l.view instanceof ClaudeSessionView && l.view.sessionId === lastActiveId
			);
			if (leaf) {
				void this.app.workspace.revealLeaf(leaf);
				(leaf.view as ClaudeSessionView).focusTerminal();
				return;
			}
		}
		// Fallback to first session tab
		void this.app.workspace.revealLeaf(leaves[0]);
		if (leaves[0].view instanceof ClaudeSessionView) {
			leaves[0].view.focusTerminal();
		}
	}

	private focusSessionByOffset(offset: number): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_SESSION);
		if (leaves.length === 0) return;

		const currentLeaf = this.app.workspace.getMostRecentLeaf();
		const currentIndex = leaves.findIndex((l) => l === currentLeaf);
		let nextIndex: number;
		if (currentIndex < 0) {
			nextIndex = 0;
		} else {
			nextIndex = (currentIndex + offset + leaves.length) % leaves.length;
		}
		void this.app.workspace.revealLeaf(leaves[nextIndex]);
		if (leaves[nextIndex].view instanceof ClaudeSessionView) {
			(leaves[nextIndex].view as ClaudeSessionView).focusTerminal();
		}
	}

	private async openNewSessionWithPicker(): Promise<void> {
		const cliProfiles = this.sessionManager.getCliProfiles();
		if (cliProfiles.length === 0) {
			new Notice('No session targets available. Configure at least one CLI profile.');
			return;
		}

		const selected = await this.pickSessionTarget(cliProfiles);
		if (!selected) {
			return;
		}
		if (this.settings.enableDebugLogging) {
			console.debug('[TerminalAgentTabs] Choose Target selected:', selected.id, selected.displayName);
		}

		await this.openNewSession({ cliId: selected.id });
	}

	private async pickSessionTarget(targets: CliProfile[]): Promise<CliProfile | null> {
		return new Promise((resolve) => {
			const modal = new SessionTargetSuggestModal(this.app, targets, resolve);
			modal.open();
		});
	}

	getActiveClaudeSessionView(): ClaudeSessionView | null {
		return this.app.workspace.getActiveViewOfType(ClaudeSessionView);
	}

	sendSelection(editor: Editor) {
		const selection = editor.getSelection();
		if (!selection) {
			return;
		}

		const session = this.sessionManager.getActiveSession();
		if (!session || !session.process) {
			new Notice('No active coding session');
			return;
		}

		let text = selection;

		if (this.settings.includeNotePathInSelectionSend) {
			const file = this.app.workspace.getActiveFile();
			if (file) {
				text = `File: ${file.path}\n\n${text}`;
			}
		}

		if (this.settings.wrapSelectionInCodeBlock) {
			text = '```\n' + text + '\n```';
		}

		this.sessionManager.writeToSession(session.sessionId, text);
	}
}

class SessionTargetSuggestModal extends FuzzySuggestModal<CliProfile> {
	private targets: CliProfile[];
	private resolver: (value: CliProfile | null) => void;
	private resolved: boolean = false;

	constructor(app: App, targets: CliProfile[], resolver: (value: CliProfile | null) => void) {
		super(app);
		this.targets = targets;
		this.resolver = resolver;
		this.setPlaceholder('Select session target');
	}

	getItems(): CliProfile[] {
		return this.targets;
	}

	getItemText(item: CliProfile): string {
		if (item.id === SPECIAL_CLI_ID_DEFAULT_SHELL) {
			return 'Default Shell';
		}
		return `${item.displayName} (${item.id})`;
	}

	onChooseItem(item: CliProfile): void {
		this.resolve(item);
	}

	onClose(): void {
		super.onClose();
		window.setTimeout(() => {
			if (!this.resolved) {
				this.resolve(null);
			}
		}, 0);
	}

	private resolve(value: CliProfile | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolver(value);
	}
}
