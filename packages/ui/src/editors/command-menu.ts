// The command menu's text model, pure so the keyboard flow is testable without a DOM: which trigger owns the caret,
// and what the text becomes when an item is picked. The text stays a plain string; nothing is token-aware.

/** One row of the menu. Picking it replaces the trigger and its query with `insert`, or runs `run`, or both. */
export type CommandItem = {
	id: string;
	label: string;
	description?: string;
	icon?: string;
	group?: string;
	/** The text that replaces `<char><query>`; default `<char><label> `. `run` alone removes the trigger text. */
	insert?: string;
	/** Keep the menu open after inserting: a drill-down (`@employees/` then its records). */
	keep?: boolean;
	run?(): void;
};
/**
 * A character that opens the menu. `start` is where it counts: `text` only as the first character (an agent
 * command), `line` at a line's start, `word` after whitespace or at the start (a mention; never inside an email).
 */
export type CommandTrigger = {
	char: string;
	start: 'text' | 'line' | 'word';
	items(query: string): readonly CommandItem[] | PromiseLike<readonly CommandItem[]>;
};
export type Found = { trigger: CommandTrigger; start: number; query: string };

/** Longest query still read as a search; past it the character is prose. */
const LIMIT = 60;

/** The trigger owning the caret: the nearest trigger character before it whose query has no whitespace. */
export function findTrigger(text: string, caret: number, triggers: readonly CommandTrigger[]): Found | null {
	for (let i = caret - 1; i >= 0 && caret - i <= LIMIT + 1; i -= 1) {
		const c = text[i]!;
		if (/\s/.test(c)) return null;
		const trigger = triggers.find((t) => t.char === c);
		if (trigger === undefined) continue;
		const before = text.slice(0, i);
		const ok = trigger.start === 'text' ? i === 0 : trigger.start === 'line' ? /(^|\n)[ \t]*$/.test(before) : i === 0 || /\s$/.test(before);
		// a trigger character that does not count here is part of the query (`@employees/Ali` under a line-start `/`)
		if (ok) return { trigger, start: i, query: text.slice(i + 1, caret) };
	}
	return null;
}

/** The text after picking `item` for `found` with the caret at `caret`, and where the caret lands. */
export function applyItem(text: string, found: Found, caret: number, item: CommandItem): { text: string; caret: number } {
	const insert = item.insert ?? (item.run === undefined ? `${found.trigger.char}${item.label} ` : '');
	const after = text.slice(caret);
	return { text: text.slice(0, found.start) + insert + after, caret: found.start + insert.length };
}

/** Rows whose label or description contains `query`, case-insensitively. */
export const filterItems = (items: readonly CommandItem[], query: string) => {
	const q = query.toLowerCase();
	return items.filter((i) => `${i.label} ${i.description ?? ''}`.toLowerCase().includes(q));
};

/** The caret's viewport box inside a textarea, measured on a hidden mirror with the same text metrics. */
export function caretRect(ta: HTMLTextAreaElement, position: number): DOMRect {
	const style = getComputedStyle(ta);
	const mirror = document.createElement('div');
	for (const p of ['box-sizing', 'width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'padding-top', 'padding-right',
		'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-transform', 'word-spacing', 'tab-size'])
		mirror.style.setProperty(p, style.getPropertyValue(p));
	Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
	mirror.textContent = ta.value.slice(0, position);
	const mark = document.createElement('span');
	mark.textContent = '​';
	mirror.append(mark);
	document.body.append(mirror);
	const box = ta.getBoundingClientRect();
	const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
	const rect = new DOMRect(box.left + mark.offsetLeft - ta.scrollLeft, box.top + mark.offsetTop - ta.scrollTop, 1, line);
	mirror.remove();
	return rect;
}
