/**
 * The composer's "@" model, kept as pure functions so the keyboard flow can be tested without a DOM.
 *
 * The draft stays a plain string — the textarea is not token-aware — and a chip is an `@label`
 * span tracked as a range beside it. Everything structural (finding the live trigger, inserting a
 * chip, deleting one whole, surviving edits around it, and serializing for the wire) happens here
 * against that pair of string plus ranges.
 *
 * The fallback is structural rather than a special case: text only becomes a mention when a picker
 * selection turned it into a tracked range. An `@anything` that never matched, or that the writer
 * edited through, is plain text — it goes to the agent verbatim and nowhere else.
 */
import { Number } from 'effect';
import type { MentionRecordHit } from '#lib/client/ui/agent/mention-sources.js';

/** One chip in the draft: the `@label` span plus the record it stands for. */
export type ComposerMention = MentionRecordHit & {
	/** Index of the `@` in the draft. */
	readonly start: number;
	/** Index just past the label's last character. */
	readonly end: number;
};

/**
 * Longest query still read as a search. Past this the `@` is prose that happens to contain one —
 * an address, a handle — and keeping the menu open would only hide text the writer means literally.
 */
const MENTION_QUERY_LIMIT = 60;

const WHITESPACE = /\s/;

/** Letters and digits — the characters that merge a chip into a longer word when typed beside it. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * A chip stands alone only when nothing word-like touches its end. `@Acme Corp,` is a chip in a
 * sentence; `@Acme Corporation` — a label the writer kept typing — is prose again, and must stop
 * resolving to the record.
 */
// repository-health:allow Q4 -- named helper
function chipDelimited(draft: string, mention: ComposerMention): boolean {
	const next = draft.slice(mention.end, mention.end + 1);
	return next === '' || !WORD_CHAR.test(next);
}

/**
 * The trigger owning the caret, if any.
 *
 * Scanning backwards, the nearest `@` before the caret is the only candidate: a second `@` between
 * a trigger and the caret would make the writer's intent ambiguous, so the nearest one decides. It
 * counts only at a word boundary — start of text or after whitespace — which is what keeps an
 * email address from opening the menu. A caret inside an existing chip is editing the chip, not
 * starting a search, and a caret past a chip's end is prose after it, not a longer query.
 *
 * Two escape hatches keep the key honest: a space directly after the `@` means the writer wants a
 * literal at-sign, and a query that runs past the limit is prose that happens to contain one.
 */
export function findMentionTrigger(
	draft: string,
	caret: number,
	mentions: readonly ComposerMention[]
) {
	const position = Number.clamp({ minimum: 0, maximum: draft.length })(caret);
	let atIndex = -1;
	for (let index = position - 1; index >= 0; index -= 1) {
		if (draft[index] === '@') {
			atIndex = index;
			break;
		}
	}
	if (atIndex === -1) return null;
	for (const mention of mentions) {
		if (position > mention.start && position <= mention.end) return null;
		if (mention.start === atIndex && position > mention.end) return null;
	}
	if (atIndex > 0 && !WHITESPACE.test(draft.charAt(atIndex - 1))) return null;
	const query = draft.slice(atIndex + 1, position);
	if (query.length > MENTION_QUERY_LIMIT || query.includes('\n')) return null;
	if (query.length > 0 && WHITESPACE.test(query.charAt(0))) return null;
	return { start: atIndex, query };
}

/** A live `@` the writer is still typing a search into, inferred from the parser that creates it. */
export type MentionTrigger = NonNullable<ReturnType<typeof findMentionTrigger>>;

/** Shifts one chip's range after an edit that grew or shrank text before it. */
// repository-health:allow Q4 -- named helper
function shiftMention(mention: ComposerMention, delta: number): ComposerMention {
	return { ...mention, start: mention.start + delta, end: mention.end + delta };
}

/** Orders chips left-to-right so later edits can walk them without crossing. */
// repository-health:allow Q4 -- named helper
function mentionsByStart(mentions: readonly ComposerMention[]): ComposerMention[] {
	return [...mentions].sort((left, right) => left.start - right.start);
}

/**
 * Replace the live trigger with a chip.
 *
 * The query the writer typed was the search, not the message, so it is consumed. A space is added
 * after the chip when the next character is not whitespace, so the chip reads as one unit and the
 * following word keeps its boundary. Mentions after the caret shift; anything the replacement
 * crosses is dropped back to plain text.
 */
export function insertMention(
	draft: string,
	mentions: readonly ComposerMention[],
	trigger: MentionTrigger & { readonly caret: number },
	reference: MentionRecordHit
): { draft: string; mentions: ComposerMention[]; caret: number } {
	const label = reference.label.trim();
	const replacedEnd = Number.clamp({ minimum: trigger.start, maximum: draft.length })(
		trigger.caret
	);
	const inserted = `@${label}`;
	const before = draft.slice(0, trigger.start);
	const after = draft.slice(replacedEnd);
	const needsSpace = after.length > 0 && !WHITESPACE.test(after.charAt(0));
	const nextDraft = `${before}${inserted}${needsSpace ? ' ' : ''}${after}`;
	const end = trigger.start + inserted.length;
	const delta = end - replacedEnd + (needsSpace ? 1 : 0);
	const kept = mentions
		.filter((mention) => mention.end <= trigger.start || mention.start >= replacedEnd)
		.map((mention) => (mention.start >= replacedEnd ? shiftMention(mention, delta) : mention));
	kept.push({
		start: trigger.start,
		end,
		collection: reference.collection,
		recordId: reference.recordId,
		label
	});
	return { draft: nextDraft, mentions: mentionsByStart(kept), caret: end + (needsSpace ? 1 : 0) };
}

/** Shifts every chip that starts at or past `from` by `delta` characters. */
function shiftMentionsAfter(
	mentions: readonly ComposerMention[],
	from: number,
	delta: number
): ComposerMention[] {
	return mentions.map((mention) =>
		mention.start >= from ? shiftMention(mention, delta) : mention
	);
}

/** Keep the `@` and replace only the live query after it. Mentions past the query shift. */
export function rewriteTriggerQuery(
	draft: string,
	mentions: readonly ComposerMention[],
	trigger: MentionTrigger,
	nextQuery: string
): { draft: string; mentions: ComposerMention[]; caret: number } {
	const queryStart = trigger.start + 1;
	const queryEnd = queryStart + trigger.query.length;
	const nextDraft = `${draft.slice(0, queryStart)}${nextQuery}${draft.slice(queryEnd)}`;
	return {
		draft: nextDraft,
		mentions: shiftMentionsAfter(mentions, queryEnd, nextQuery.length - trigger.query.length),
		caret: queryStart + nextQuery.length
	};
}

/** Remove the live `@query` and leave `rest` in its place. */
export function consumeTrigger(
	draft: string,
	mentions: readonly ComposerMention[],
	trigger: MentionTrigger,
	rest: string
): { draft: string; mentions: ComposerMention[]; caret: number } {
	const queryEnd = trigger.start + 1 + trigger.query.length;
	const nextDraft = `${draft.slice(0, trigger.start)}${rest}${draft.slice(queryEnd)}`;
	return {
		draft: nextDraft,
		mentions: shiftMentionsAfter(mentions, queryEnd, rest.length - (1 + trigger.query.length)),
		caret: trigger.start + rest.length
	};
}

/**
 * Reconcile tracked chips with an edit the textarea made on its own.
 *
 * The edit is located by diffing the old and new drafts to a changed region. Chips entirely before
 * it survive, chips entirely after it shift, and a chip the edit crossed becomes plain text — the
 * writer typed inside it, so it is theirs now. Kept chips are re-checked against the text they
 * claim, because an input method that rewrites surrounding characters can move a boundary without
 * the diff pointing at the chip itself.
 */
export function reconcileAfterEdit(
	mentions: readonly ComposerMention[],
	previousDraft: string,
	nextDraft: string
): ComposerMention[] {
	if (previousDraft === nextDraft) return [...mentions];
	let prefix = 0;
	const shared = Math.min(previousDraft.length, nextDraft.length);
	while (prefix < shared && previousDraft[prefix] === nextDraft[prefix]) prefix += 1;
	let suffix = 0;
	const maxSuffix = shared - prefix;
	while (
		suffix < maxSuffix &&
		previousDraft[previousDraft.length - 1 - suffix] === nextDraft[nextDraft.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const oldRegionEnd = previousDraft.length - suffix;
	const delta = nextDraft.length - previousDraft.length;
	const kept: ComposerMention[] = [];
	for (const mention of mentions) {
		if (mention.end <= prefix) {
			if (chipDelimited(nextDraft, mention)) kept.push(mention);
			continue;
		}
		if (mention.start >= oldRegionEnd) {
			const shifted = shiftMention(mention, delta);
			if (
				nextDraft.slice(shifted.start, shifted.end) === `@${shifted.label}` &&
				chipDelimited(nextDraft, shifted)
			) {
				kept.push(shifted);
			}
			continue;
		}
		// The edit crossed this chip: it degrades to plain text.
	}
	return kept;
}

/**
 * Delete one whole chip when backspace or delete lands on it.
 *
 * Returns `null` when nothing applies — a real selection, or a caret beside plain text — so the
 * caller falls back to the textarea's own behaviour. A chip is one unit: the caret anywhere inside
 * it, or at its far edge for backspace (near edge for delete), removes the entire span rather than
 * nibbling the label one character at a time.
 */
export function mentionDeletion(
	draft: string,
	mentions: readonly ComposerMention[],
	selectionStart: number,
	selectionEnd: number,
	direction: 'backward' | 'forward'
): { draft: string; mentions: ComposerMention[]; caret: number } | null {
	if (selectionStart !== selectionEnd) return null;
	const caret = selectionStart;
	const target = mentions.find((mention) =>
		direction === 'backward'
			? caret > mention.start && caret <= mention.end
			: caret >= mention.start && caret < mention.end
	);
	if (!target) return null;
	const width = target.end - target.start;
	return {
		draft: draft.slice(0, target.start) + draft.slice(target.end),
		mentions: mentions
			.filter((mention) => mention !== target)
			.map((mention) => (mention.start >= target.end ? shiftMention(mention, -width) : mention)),
		caret: target.start
	};
}

/**
 * The wire form of the draft: the message exactly as written — chips already read as `@label` in
 * it — plus the structured references the agent should resolve. Only ranges that still match their
 * text count, and a record named twice is referenced once.
 */
export function serializeMentions(
	draft: string,
	mentions: readonly ComposerMention[]
): { message: string; references: MentionRecordHit[] } {
	const seen = new Set<string>();
	const references: MentionRecordHit[] = [];
	for (const mention of mentionsByStart(mentions)) {
		if (draft.slice(mention.start, mention.end) !== `@${mention.label}`) continue;
		if (!chipDelimited(draft, mention)) continue;
		const key = `${mention.collection}:${mention.recordId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		references.push({
			collection: mention.collection,
			recordId: mention.recordId,
			label: mention.label
		});
	}
	return { message: draft.trim(), references };
}
