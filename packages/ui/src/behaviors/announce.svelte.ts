// Shared polite and assertive live regions per document so screen readers announce dynamic UI
// changes (drag/reorder, selection ranges, calendar jumps, toasts, async status) reliably.
// Regions carry `data-norbital-announcer` so `inert_outside` never hides them while a modal is open.

/** Urgency of a screen-reader announcement (`'polite'` waits for idle, `'assertive'` interrupts). */
export type AnnouncePriority = 'polite' | 'assertive';

/** Options for `announce`. */
export type AnnounceOptions = {
	/** Announcement urgency (default `'polite'`). */
	readonly priority?: AnnouncePriority;
	/** Target document (defaults to global `document`). */
	readonly doc?: Document;
};

type CustomAnnouncer = (text: string, priority: AnnouncePriority) => void;

const regions = new WeakMap<Document, Partial<Record<AnnouncePriority, HTMLElement>>>();
const timers: Partial<Record<AnnouncePriority, ReturnType<typeof setTimeout>>> = {};
let customAnnouncer: CustomAnnouncer | undefined;

/** Replaces live-region output (useful in headless unit tests); pass `undefined` to restore. */
export function set_announcer(fn: CustomAnnouncer | undefined): void {
	customAnnouncer = fn;
}

function getRegion(doc: Document, priority: AnnouncePriority): HTMLElement {
	let entry = regions.get(doc);
	if (entry === undefined) {
		entry = {};
		regions.set(doc, entry);
	}
	const existing = entry[priority];
	if (existing !== undefined && existing.isConnected) return existing;

	const el = doc.createElement('div');
	el.setAttribute('role', priority === 'assertive' ? 'alert' : 'status');
	el.setAttribute('aria-live', priority);
	el.setAttribute('aria-atomic', 'true');
	el.setAttribute('data-norbital-announcer', priority);
	el.style.cssText =
		'position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none;';
	doc.body.appendChild(el);
	entry[priority] = el;
	return el;
}

/** Pre-creates polite and assertive live regions so the very first announcement is never dropped. */
export function prepare_announcements(
	doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): void {
	if (customAnnouncer !== undefined || doc?.body === undefined || doc.body === null) return;
	getRegion(doc, 'polite');
	getRegion(doc, 'assertive');
}

/**
 * Announces `text` to assistive technologies. Repeating identical text still triggers a fresh
 * reading by clearing the region before writing.
 */
export function announce(text: string, options: AnnounceOptions = {}): void {
	const trimmed = text.trim();
	if (trimmed === '') return;
	const priority = options.priority ?? 'polite';
	if (customAnnouncer !== undefined) {
		customAnnouncer(trimmed, priority);
		return;
	}
	const doc = options.doc ?? (typeof document === 'undefined' ? undefined : document);
	if (doc?.body === undefined || doc.body === null) return;

	const region = getRegion(doc, priority);
	const prev = timers[priority];
	if (prev !== undefined) clearTimeout(prev);

	region.textContent = '';
	timers[priority] = setTimeout(() => {
		timers[priority] = undefined;
		if (region.isConnected) region.textContent = trimmed;
	}, 16);
}
