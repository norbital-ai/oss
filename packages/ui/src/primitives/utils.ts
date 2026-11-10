import { UI_TEXT, type UiTextKey } from '../i18n.js';
export { uiTextFor, type UiTextKey } from '../i18n.js';
import { type ClassValue, clsx } from 'clsx';
import { getContext, setContext } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { twMerge } from 'tailwind-merge';

/** Joins class names and merges conflicting Tailwind classes (the last wins). */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * The row ArrowDown/ArrowUp moves to: wraps, and steps over rows `enabled` refuses. With none selectable, or an empty
 * list, the active row stays (0 for an empty list).
 */
export function stepActive(
	length: number,
	active: number,
	delta: 1 | -1,
	enabled?: (index: number) => boolean
): number {
	if (length === 0) return 0;
	const start = Math.min(Math.max(active, 0), length - 1);
	let next = start;
	for (let i = 0; i < length; i++) {
		next = (next + delta + length) % length;
		if (enabled === undefined || enabled(next)) return next;
	}
	return start;
}

/** A byte count as short text in binary units (`512.0 B`, `12.0 KB`, `3.4 MB`); `0 B` for none. */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / Math.pow(1024, unit)).toFixed(1)} ${units[unit]}`;
}

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

/** A tick the finger feels where the platform allows it (Android); a no-op elsewhere, never relied on. */
export type HapticKind = 'tap' | 'success' | 'warning';
const PATTERNS: Readonly<Record<HapticKind, readonly number[]>> = {
	tap: [10],
	success: [10, 40, 10],
	warning: [30]
};
export const haptic = (kind: HapticKind = 'tap'): void => {
	if ('navigator' in globalThis && 'vibrate' in navigator) navigator.vibrate([...PATTERNS[kind]]);
};

/** The one width question a component may ask; the same 48rem `base.css` restates. */
export const narrowViewport = new MediaQuery('max-width: 47.999rem');
/** A finger is the main pointer; the same query `base.css` restates. */
export const coarsePointer = new MediaQuery('pointer: coarse');
/** The main input cannot hover; the same query `base.css` restates. */
export const noHover = new MediaQuery('hover: none');

const TEXT = Symbol.for('norbital.ui.text');
/** Sets the kit's chrome strings for everything beneath (the shell passes the workspace locale's text once). */
export const setUiText = (text: Partial<Record<UiTextKey, string>>) => setContext(TEXT, text);
/** Resolve once per component (it reads context); returns `t(key)`. */
export function uiText(): (key: UiTextKey) => string {
	const text = getContext<Partial<Record<UiTextKey, string>> | undefined>(TEXT);
	return (key) => text?.[key] ?? UI_TEXT[key];
}

const FIELD_CONTROL = Symbol.for('norbital.ui.field.control');
/**
 * A `Field` rendering an `editor` snippet: the id its label points at, taken by the first control beneath that has no id
 * of its own, so a snippet's picker is named by the field's label without the snippet wiring it.
 */
export function provideFieldControl(id: () => string): void {
	let taken = false;
	setContext(FIELD_CONTROL, () => (taken ? undefined : ((taken = true), id())));
}
/** The enclosing `Field`'s control id, once; `undefined` outside a snippet field or when a control already took it. */
export const claimFieldControl = (): string | undefined =>
	getContext<(() => string | undefined) | undefined>(FIELD_CONTROL)?.();

/** How the controls beneath render: `readonly` shows each value as copyable text (no field chrome); `disabled` keeps the
 * field, muted and unfocusable. Readonly wins when both hold. */
export type Controls = { readonly readonly: boolean; readonly disabled: boolean };
const CONTROLS = Symbol.for('norbital.ui.controls');
const FREE: Controls = { readonly: false, disabled: false };
/** The enclosing `Form`'s, `Fieldset`'s or `Field`'s control mode; editable outside any. */
export const useControls = (): Controls => getContext<Controls | undefined>(CONTROLS) ?? FREE;
/** Hands a control mode to every control beneath; a member `own` leaves `undefined` inherits the enclosing one. Readonly
 * only adds: a `readonly={false}` beneath a readonly form (a viewed record) stays readonly. Only a form's own boundary
 * (`boundary`: a create sheet opened inside a readonly form) starts afresh. */
export function provideControls(
	own: () => { readonly?: boolean | null | undefined; disabled?: boolean | null | undefined },
	boundary = false
): Controls {
	const parent = useControls();
	return setContext(CONTROLS, {
		get readonly() {
			const mine = own().readonly;
			return boundary ? (mine ?? parent.readonly) : mine === true || parent.readonly;
		},
		get disabled() {
			return own().disabled ?? parent.disabled;
		}
	});
}
