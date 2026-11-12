import { writable } from 'svelte/store';

// The one sheet behaviour (owner rule): non-modal, no backdrop, the page stays usable; dismissed only by Esc (the
// topmost open sheet) or its close button. A drawer also closes once its user navigates.

/** Open sheets, innermost last; Esc closes only the last. */
export const openSheets: object[] = [];

/** Bumped on every push and pop so a sheet's depth and topmost state stay reactive. */
export const sheetRevision = writable(0);

/** Push a sheet without ever leaving a duplicate in the stack. */
export const pushSheet = (sheet: object): void => {
	const index = openSheets.indexOf(sheet);
	if (index >= 0) openSheets.splice(index, 1);
	openSheets.push(sheet);
	sheetRevision.update((value) => value + 1);
};

/** Remove a sheet by identity; an absent sheet never removes the topmost other one. */
export const popSheet = (sheet: object): void => {
	const index = openSheets.indexOf(sheet);
	if (index < 0) return;
	openSheets.splice(index, 1);
	sheetRevision.update((value) => value + 1);
};

/** Whether this keydown dismisses `sheet`: an unhandled Esc, outside IME composition, while `sheet` is the topmost. */
export const escapes = (
	event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>,
	sheet: object,
	stack: readonly object[] = openSheets
): boolean =>
	event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && stack.at(-1) === sheet;

type Clicked = Pick<
	MouseEvent,
	'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented' | 'target'
>;

/** Whether a click inside a drawer navigates in place (a plain click on a link), so the drawer should close. */
export function navigates(event: Clicked): boolean {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	)
		return false;
	const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
	return !!link && (link.getAttribute('target') ?? '_self') === '_self';
}
