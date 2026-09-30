// The one sheet behaviour (owner rule): non-modal, no backdrop, the page stays usable; dismissed only by Esc (the
// topmost open sheet) or its close button. A drawer also closes once its user navigates.

/**
 * A sheet's close guard: a form inside registers whether it holds unsaved changes (`register(dirty)` returns the
 * unregister). Closing a sheet with any registered form dirty asks first, so one Esc never drops a draft.
 */
export const SHEET_GUARD = Symbol.for('ui.sheet.guard');
export type SheetGuard = (dirty: () => boolean) => () => void;

/** Open sheets, innermost last; Esc closes only the last. */
export const openSheets: object[] = [];

/** Whether this keydown dismisses `sheet`: an unhandled Esc, outside IME composition, while `sheet` is the topmost. */
export const escapes = (event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>, sheet: object, stack: readonly object[] = openSheets): boolean =>
	event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && stack.at(-1) === sheet;

type Clicked = Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented' | 'target'>;

/** Whether a click inside a drawer navigates in place (a plain click on a link), so the drawer should close. */
export function navigates(event: Clicked): boolean {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
	const link = (event.target as Partial<Element> | null)?.closest?.('a[href]');
	return !!link && (link.getAttribute('target') ?? '_self') === '_self';
}
