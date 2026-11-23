// Focus containment and restoration for dialogs, drawers, command palettes and popovers.
// Cycles Tab / Shift+Tab within the attached container and restores focus to the previously
// focused element on deactivation.
import type { Attachment } from 'svelte/attachments';

const TABBABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
	'[contenteditable="true"]'
].join(', ');

/** Returns all visible, enabled tabbable descendants inside `root`. */
export function tabbable_elements(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(
		(el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && !el.hidden
	);
}

/** Options for `create_focus_trap`. */
export type FocusTrapOptions = {
	/** Whether focus trapping is active. */
	active: () => boolean;
	/** Automatically move focus into the container when activated (default `true`). */
	auto_focus?: boolean;
	/** Restore focus to the previously active element on close (default `true`). */
	restore_focus?: boolean;
};

/** Return value of `create_focus_trap`. */
export type FocusTrap = ReturnType<typeof create_focus_trap>;

/**
 * Headless focus trap + focus recovery attachment (`{@attach trap.container}`).
 */
export function create_focus_trap(options: FocusTrapOptions) {
	let containerEl: HTMLElement | null = null;

	$effect(() => {
		if (!options.active() || containerEl === null) return;
		const root = containerEl;
		const previous =
			typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;

		if (options.auto_focus !== false && !root.contains(document.activeElement)) {
			const first = tabbable_elements(root)[0] ?? root;
			if (first === root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
			first.focus({ preventScroll: true });
		}

		const onKeydown = (event: KeyboardEvent) => {
			if (event.key !== 'Tab') return;
			const items = tabbable_elements(root);
			if (items.length === 0) {
				event.preventDefault();
				root.focus({ preventScroll: true });
				return;
			}
			const first = items[0];
			const last = items.at(-1);
			if (first === undefined || last === undefined) return;
			const current = document.activeElement;
			if (event.shiftKey) {
				if (current === first || !root.contains(current)) {
					event.preventDefault();
					last.focus({ preventScroll: true });
				}
			} else if (current === last || !root.contains(current)) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			}
		};

		root.addEventListener('keydown', onKeydown);
		return () => {
			root.removeEventListener('keydown', onKeydown);
			if (options.restore_focus !== false && previous !== null && previous.isConnected) {
				previous.focus({ preventScroll: true });
			}
		};
	});

	const container: Attachment<HTMLElement> = (el) => {
		containerEl = el;
		return () => {
			if (containerEl === el) containerEl = null;
		};
	};

	return { container };
}
