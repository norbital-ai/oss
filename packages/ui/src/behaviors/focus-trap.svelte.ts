// Focus containment, restoration, modal `inert` background isolation and ref-counted scroll locking
// for dialogs, drawers, command palettes and popovers.
import type { Attachment } from 'svelte/attachments';
import { inert_outside, lock_scroll } from './modal.svelte.js';

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
		(el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && !el.hidden && !el.inert
	);
}

/** Options for `create_focus_trap`. */
export type FocusTrapOptions = {
	/** Whether focus trapping is active. */
	readonly active: () => boolean;
	/** Automatically move focus into the container when activated (default `true`). */
	readonly auto_focus?: boolean | (() => boolean);
	/** Restore focus to the previously active element on close (default `true`). */
	readonly restore_focus?: boolean | (() => boolean);
	/** Keep Tab / focusin strictly contained inside the container (default `true`). */
	readonly trap?: boolean | (() => boolean);
	/** Mark background siblings `inert` while active (default `false`; set `true` on modal dialogs). */
	readonly modal?: boolean | (() => boolean);
	/** Apply ref-counted document scroll lock while active (default `false`). */
	readonly prevent_scroll?: boolean | (() => boolean);
	/** Optional predicate gating focus-trap listeners to only the topmost stacked layer. */
	readonly topmost?: () => boolean;
	/** Cancelable hook invoked before initial autofocus runs. */
	readonly on_open_auto_focus?: (event: Event) => void;
	/** Cancelable hook invoked before focus returns to the previous element on close. */
	readonly on_close_auto_focus?: (event: Event) => void;
	/** Called when focus escapes outside the container while active. */
	readonly on_focus_outside?: (event: FocusEvent) => void;
};

/** Return value of `create_focus_trap`. */
export type FocusTrap = ReturnType<typeof create_focus_trap>;

const resolveFlag = (value: boolean | (() => boolean) | undefined, fallback: boolean): boolean =>
	typeof value === 'function' ? value() : (value ?? fallback);

/**
 * Headless focus trap + focus restoration + optional modal `inert_outside` & ref-counted `lock_scroll`
 * attachment (`{@attach trap.container}`).
 */
export function create_focus_trap(options: FocusTrapOptions) {
	let containerEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (!options.active() || containerEl === null) return;
		const root = containerEl;
		const previous =
			typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;

		const trapFocus = resolveFlag(options.trap, true);
		const useModal = resolveFlag(options.modal, false);
		const useScrollLock = resolveFlag(options.prevent_scroll, false);
		const releaseScroll = useScrollLock ? lock_scroll(root.ownerDocument) : null;
		const releaseInert = useModal ? inert_outside(root) : null;

		if (resolveFlag(options.auto_focus, true)) {
			const openEvent = new CustomEvent('focusTrap.openAutoFocus', { cancelable: true });
			options.on_open_auto_focus?.(openEvent);
			if (!openEvent.defaultPrevented && !root.contains(document.activeElement)) {
				const first = tabbable_elements(root)[0] ?? root;
				if (first === root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
				first.focus({ preventScroll: true });
			}
		}

		const isTop = () => options.topmost?.() ?? true;

		const onKeydown = (event: KeyboardEvent) => {
			if (!trapFocus || event.key !== 'Tab' || !isTop()) return;
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

		const onFocusin = (event: FocusEvent) => {
			if (!isTop()) return;
			const target = event.target;
			if (target instanceof Node && root.contains(target)) return;
			options.on_focus_outside?.(event);
			if (trapFocus && !event.defaultPrevented) {
				const first = tabbable_elements(root)[0] ?? root;
				first.focus({ preventScroll: true });
			}
		};

		document.addEventListener('keydown', onKeydown);
		document.addEventListener('focusin', onFocusin, true);

		return () => {
			document.removeEventListener('keydown', onKeydown);
			document.removeEventListener('focusin', onFocusin, true);
			releaseInert?.();
			releaseScroll?.();
			if (resolveFlag(options.restore_focus, true)) {
				const closeEvent = new CustomEvent('focusTrap.closeAutoFocus', { cancelable: true });
				options.on_close_auto_focus?.(closeEvent);
				if (!closeEvent.defaultPrevented && previous !== null && previous.isConnected) {
					previous.focus({ preventScroll: true });
				}
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
