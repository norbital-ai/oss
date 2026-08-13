import { describe, expect, it } from 'vitest';
import {
	MENTION_QUERY_LIMIT,
	consumeTrigger,
	findMentionTrigger,
	insertMention,
	mentionDeletion,
	reconcileAfterEdit,
	rewriteTriggerQuery,
	serializeMentions,
	type ComposerMention
} from '$lib/ui/agent/composer-mentions.js';

const acme = {
	collection: 'companies',
	recordId: '0197f2a4-0000-7000-8000-000000000001',
	label: 'Acme Corp'
};

function chip(start: number, reference: typeof acme = acme): ComposerMention {
	return { start, end: start + 1 + reference.label.length, ...reference };
}

describe('finding the live trigger', () => {
	it('opens on an "@" at the start of the draft or after whitespace', () => {
		expect(findMentionTrigger('@', 1, [])).toEqual({ start: 0, query: '' });
		expect(findMentionTrigger('summarize @acm', 14, [])).toEqual({ start: 10, query: 'acm' });
		expect(findMentionTrigger('a\n@b', 4, [])).toEqual({ start: 2, query: 'b' });
	});

	it('stays closed mid-word, so an email address is prose', () => {
		expect(findMentionTrigger('write to a@b.com', 16, [])).toBeNull();
	});

	it('the nearest "@" owns the caret', () => {
		expect(findMentionTrigger('@team and @fi', 13, [])).toEqual({ start: 10, query: 'fi' });
	});

	it('a space directly after the "@" is a literal at-sign, not a search', () => {
		expect(findMentionTrigger('@ ', 2, [])).toBeNull();
		expect(findMentionTrigger('@ x', 3, [])).toBeNull();
	});

	it('queries may contain spaces but not newlines, and only up to the limit', () => {
		expect(findMentionTrigger('@acme corp', 10, [])).toEqual({ start: 0, query: 'acme corp' });
		expect(findMentionTrigger('@one\ntwo', 8, [])).toBeNull();
		const long = `@${'x'.repeat(MENTION_QUERY_LIMIT + 1)}`;
		expect(findMentionTrigger(long, long.length, [])).toBeNull();
	});

	it('a caret inside a chip edits the chip, and past its end is prose after it', () => {
		const mention = chip(10);
		const draft = 'summarize @Acme Corp for Q3';
		expect(findMentionTrigger(draft, 15, [mention])).toBeNull();
		expect(findMentionTrigger(draft, 20, [mention])).toBeNull();
		// Past the chip's end — even right after it — the search is over.
		expect(findMentionTrigger(draft, 21, [mention])).toBeNull();
		// A fresh "@" later in the text is a fresh trigger.
		expect(findMentionTrigger(`${draft} @q`, draft.length + 3, [mention])).toEqual({
			start: draft.length + 1,
			query: 'q'
		});
	});
});

describe('inserting a chip', () => {
	it('consumes the query and leaves a space before the following word', () => {
		const result = insertMention(
			'summarize @acm for Q3',
			[],
			{ start: 10, query: 'acm', caret: 14 },
			acme
		);
		expect(result.draft).toBe('summarize @Acme Corp for Q3');
		// The existing space is kept, so the caret lands on it rather than adding a second.
		expect(result.caret).toBe('summarize @Acme Corp'.length);
		expect(result.mentions).toEqual([chip(10)]);
	});

	it('adds no trailing space at the end of the draft', () => {
		const result = insertMention('@acm', [], { start: 0, query: 'acm', caret: 4 }, acme);
		expect(result.draft).toBe('@Acme Corp');
		expect(result.caret).toBe('@Acme Corp'.length);
	});

	it('shifts chips after the caret and keeps both in order', () => {
		const first = chip(0);
		const draft = '@Acme Corp meets @acm';
		const result = insertMention(draft, [first], { start: 17, query: 'acm', caret: 21 }, acme);
		expect(result.draft).toBe('@Acme Corp meets @Acme Corp');
		expect(result.mentions.map((mention) => mention.start)).toEqual([0, 17]);
	});
});

describe('rewriting and consuming a live trigger', () => {
	it('keeps the @ and replaces only the query', () => {
		const result = rewriteTriggerQuery(
			'ask @acm later',
			[],
			{ start: 4, query: 'acm' },
			'#companies '
		);
		expect(result.draft).toBe('ask @#companies  later');
		expect(result.caret).toBe('ask @#companies '.length);
	});

	it('removes the @query and leaves the rest of the request', () => {
		const result = consumeTrigger(
			'please @!rewrite leave',
			[],
			{ start: 7, query: '!rewrite leave' },
			'rewrite leave'
		);
		expect(result.draft).toBe('please rewrite leave');
		expect(result.caret).toBe('please rewrite leave'.length);
	});
});

describe('surviving edits around chips', () => {
	it('typing before a chip shifts it; typing after leaves it', () => {
		const mention = chip(0);
		const shifted = reconcileAfterEdit([mention], '@Acme Corp', 'well @Acme Corp');
		expect(shifted).toEqual([chip(5)]);
		const same = reconcileAfterEdit([mention], '@Acme Corp', '@Acme Corp indeed');
		expect(same).toEqual([chip(0)]);
	});

	it('an edit through the chip degrades it to plain text', () => {
		const mention = chip(0);
		expect(reconcileAfterEdit([mention], '@Acme Corp', '@Acme Corporation')).toEqual([]);
		expect(reconcileAfterEdit([mention], '@Acme Corp', '@Acme')).toEqual([]);
	});

	it('a deletion before the chip shifts it back', () => {
		const mention = chip(5);
		const kept = reconcileAfterEdit([mention], 'well @Acme Corp', '@Acme Corp');
		expect(kept).toEqual([chip(0)]);
	});

	it('a word typed against the chip merges it into prose; punctuation and space do not', () => {
		const mention = chip(0);
		expect(reconcileAfterEdit([mention], '@Acme Corp', '@Acme Corpx')).toEqual([]);
		expect(reconcileAfterEdit([mention], '@Acme Corp', '@Acme Corp,')).toEqual([mention]);
		expect(reconcileAfterEdit([mention], '@Acme Corp', '@Acme Corp is fine')).toEqual([mention]);
	});
});

describe('deleting a chip whole', () => {
	const draft = 'ask @Acme Corp now';
	const mention = chip(4);

	it('backspace at the far edge removes the entire chip', () => {
		const result = mentionDeletion(draft, [mention], 14, 14, 'backward');
		expect(result).toEqual({ draft: 'ask  now', mentions: [], caret: 4 });
	});

	it('backspace mid-chip removes it whole rather than nibbling the label', () => {
		const result = mentionDeletion(draft, [mention], 8, 8, 'backward');
		expect(result?.draft).toBe('ask  now');
	});

	it('delete at the near edge removes it; beside plain text nothing applies', () => {
		expect(mentionDeletion(draft, [mention], 4, 4, 'forward')?.draft).toBe('ask  now');
		expect(mentionDeletion(draft, [mention], 0, 0, 'backward')).toBeNull();
		expect(mentionDeletion(draft, [mention], draft.length, draft.length, 'backward')).toBeNull();
	});

	it('a real selection takes the default path', () => {
		expect(mentionDeletion(draft, [mention], 4, 10, 'backward')).toBeNull();
	});

	it('chips after the deleted one shift back', () => {
		const two = 'ask @Acme Corp and @Acme Corp';
		const mentions = [chip(4), chip(19)];
		const result = mentionDeletion(two, mentions, 14, 14, 'backward');
		expect(result?.draft).toBe('ask  and @Acme Corp');
		expect(result?.mentions).toEqual([chip(9)]);
	});
});

describe('serializing for the wire', () => {
	it('keeps the message as written and lists each referenced record once', () => {
		const draft = 'Compare @Acme Corp with @Acme Corp';
		const mentions = [chip(8), chip(24)];
		const { message, references } = serializeMentions(draft, mentions);
		expect(message).toBe('Compare @Acme Corp with @Acme Corp');
		expect(references).toEqual([acme]);
	});

	it('a range whose text no longer matches is plain text, not a reference', () => {
		const draft = 'Compare @Acme Corporat with the rest';
		const stale = chip(8);
		const { message, references } = serializeMentions(draft, [stale]);
		expect(message).toBe('Compare @Acme Corporat with the rest');
		expect(references).toEqual([]);
	});

	it('punctuation after a chip does not break the reference', () => {
		const draft = 'Ask @Acme Corp, quickly';
		const { references } = serializeMentions(draft, [chip(4)]);
		expect(references).toEqual([acme]);
	});
});
