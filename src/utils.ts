/**
 * Shared utility functions.
 */

/** Normalize a CLI profile ID to lowercase alphanumeric with dashes/underscores. */
export function normalizeCliId(value: string): string {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-');
	return normalized || 'cli';
}

/**
 * Strip terminal private-mode toggles (CSI ? … h/l) from a string — e.g. alt-screen
 * (`?1049h`), cursor visibility (`?25l`), mouse tracking (`?1000h`), bracketed paste
 * (`?2004h`). Used to sanitize persisted scrollback before repainting it on restore so a
 * replayed dump can never leave the terminal stuck in a broken mode (Phase 4 hardening).
 * Visible content (text, colors/SGR, cursor moves) is preserved.
 */
export function stripPrivateModeSequences(value: string): string {
	// eslint-disable-next-line no-control-regex -- matching the ESC control byte is required
	return value.replace(/\x1b\[\?[0-9;]*[hl]/g, '');
}

/**
 * Prepend a full-width drag handle to `pane` that resizes it vertically.
 * `pane` already has `resize: vertical` in CSS, but that only exposes a
 * ~13px native grip in the bottom-right corner — an awkward target for a
 * panel pinned to the bottom edge of the view. This gives the whole top
 * border a draggable strip instead. Height is written as an inline style,
 * so it persists across re-renders of the pane's own contents (but not
 * across close/reopen — same as the native resize grip it replaces).
 */
export function makePaneResizable(pane: HTMLElement): void {
	const handle = pane.createDiv({ cls: 'beads-agent-resize-handle' });
	pane.prepend(handle);
	let startY = 0;
	let startHeight = 0;
	const onMove = (e: PointerEvent) => {
		pane.style.height = `${Math.max(80, startHeight - (e.clientY - startY))}px`;
	};
	const onUp = (e: PointerEvent) => {
		handle.removeEventListener('pointermove', onMove);
		handle.releasePointerCapture(e.pointerId);
	};
	handle.addEventListener('pointerdown', (e: PointerEvent) => {
		startY = e.clientY;
		startHeight = pane.getBoundingClientRect().height;
		handle.setPointerCapture(e.pointerId);
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp, { once: true });
	});
}
