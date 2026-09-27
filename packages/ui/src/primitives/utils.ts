import { type ClassValue, clsx } from 'clsx';
import { getContext, setContext } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { twMerge } from 'tailwind-merge';

/** Joins class names and merges conflicting Tailwind classes (the last wins). */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
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
const PATTERNS: Readonly<Record<HapticKind, readonly number[]>> = { tap: [10], success: [10, 40, 10], warning: [30] };
export const haptic = (kind: HapticKind = 'tap'): void => {
	if ('navigator' in globalThis && 'vibrate' in navigator) navigator.vibrate([...PATTERNS[kind]]);
};

/** The one width question a component may ask; the same 48rem `base.css` restates. */
export const narrowViewport = new MediaQuery('max-width: 47.999rem');

/** The kit's own chrome strings. English by default; the shell sets the workspace locale's text once (`setUiText`). */
export const UI_TEXT = {
	close: 'Close', expand: 'Expand', collapse: 'Collapse', resize: 'Resize', save: 'Save', saving: 'Saving…', cancel: 'Cancel',
	create: 'Create', add: 'Add', remove: 'Remove', none: '—', yes: 'Yes', no: 'No', upload: 'Upload files', uploading: 'Uploading…',
	useMyLocation: 'Use my location', latitude: 'Latitude', longitude: 'Longitude', searchAddress: 'Search address',
	pickOnMap: 'Pick on map', mapUnavailable: 'Map unavailable', addressSearchUnavailable: 'Address search unavailable', locationDenied: 'Location unavailable', from: 'From', to: 'To',
	openEnded: 'Open-ended', pendingApproval: 'Submitted for approval', conflict: 'This record changed since you opened it. Review and save again.',
	unknown: 'The outcome is not known yet. Check again before retrying.', select: 'Select…', search: 'Search…', noResults: 'No results',
	required: 'Required', invalid: 'Invalid value', noAccess: 'No access', notFound: 'Not found or no access', field: 'Field', kind: 'Kind', optional: 'Optional', fields: 'Fields',
	today: 'Today', previous: 'Previous', next: 'Next', more: '+{n} more', day: 'Day', week: 'Week', month: 'Month', notifications: 'Notifications',
	fullScreen: 'Full screen', exitFullScreen: 'Exit full screen', createdAt: 'Created {when} by {who}', updatedAt: 'Updated {when} by {who}',
	unsaved: 'Unsaved changes', discard: 'Discard', copy: 'Copy', copied: 'Copied',
	dropFiles: 'Drop files here or click to browse', dropFile: 'Drop a file here or click to browse', upToFiles: 'Up to {n} files',
	sizeEach: '{size} each', fileCount: '{n} files', download: 'Download', preview: 'Preview', retry: 'Retry', uploadFailed: 'Upload failed',
	countryCode: 'Country code', invalidPhone: 'Enter a valid phone number', currency: 'Currency',
	searchMeaning: 'Search by meaning', searchPick: 'Type / to choose a search', searchClear: 'Back to plain search', searchRun: 'Search',
	searchRaw: '{field} is a raw vector: run this search from a page', searchView: 'This view cannot show ranked rows: open it in a table', searchNone: 'No search indexes here',
	searchFields: 'Searches {fields}', searchCommands: 'Type / for a command'
} as const;
/** A key of the kit's own chrome strings. */
export type UiTextKey = keyof typeof UI_TEXT;
const TEXT = Symbol.for('norbital.ui.text');
/** Sets the kit's chrome strings for everything beneath (the shell passes the workspace locale's text once). */
export const setUiText = (text: Partial<Record<UiTextKey, string>>) => setContext(TEXT, text);
/** Resolve once per component (it reads context); returns `t(key)`. */
export function uiText(): (key: UiTextKey) => string {
	const text = getContext<Partial<Record<UiTextKey, string>> | undefined>(TEXT);
	return (key) => text?.[key] ?? UI_TEXT[key];
}

/** How the controls beneath render: `readonly` shows each value as copyable text (no field chrome); `disabled` keeps the
 * field, muted and unfocusable. Readonly wins when both hold. */
export type Controls = { readonly readonly: boolean; readonly disabled: boolean };
const CONTROLS = Symbol.for('norbital.ui.controls');
const FREE: Controls = { readonly: false, disabled: false };
/** The enclosing `Form`'s, `Fieldset`'s or `Field`'s control mode; editable outside any. */
export const useControls = (): Controls => getContext<Controls | undefined>(CONTROLS) ?? FREE;
/** Hands a control mode to every control beneath; a member `own` leaves `undefined` inherits the enclosing one. */
export function provideControls(own: () => { readonly?: boolean | null | undefined; disabled?: boolean | null | undefined }): Controls {
	const parent = useControls();
	return setContext(CONTROLS, {
		get readonly() { return own().readonly ?? parent.readonly; },
		get disabled() { return own().disabled ?? parent.disabled; }
	});
}
