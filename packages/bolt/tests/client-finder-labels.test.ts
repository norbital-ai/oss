import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { createMentionSources } from '../src/client/ui/agent/mention-sources.js';

const page = (rows: Record<string, unknown>[]) => {
	const ready = Promise.resolve(rows);
	return {
		current: rows,
		loading: false,
		error: undefined,
		nextCursor: null,
		extend: () => undefined,
		then: ready.then.bind(ready)
	};
};

it('finder results use declared labels outside the conventional name and title fields', async () => {
	const sources = createMentionSources({
		findRecords: () => page([{ id: 'notice-1', subject: 'Part 2N3904 discontinued' }]),
		getRecordLabel: () => 'subject'
	});
	expect(await Effect.runPromise(sources.search('2N3904', 'notices'))).toEqual([
		{ collection: 'notices', recordId: 'notice-1', label: 'Part 2N3904 discontinued' }
	]);
});

it('finder results retain declared multi-field labels and conventional fallbacks', async () => {
	const sources = createMentionSources({
		findRecords: () => page([{ id: 'category-1', name: 'Fasteners', version: 2 }]),
		getRecordLabel: () => "name + ' · ' + version"
	});
	expect((await Effect.runPromise(sources.search('Fasteners', 'categories')))[0]?.label).toBe(
		'Fasteners · 2'
	);
	const fallback = createMentionSources({
		findRecords: () => page([{ id: 'category-1', name: 'Fasteners' }])
	});
	expect((await Effect.runPromise(fallback.search('Fasteners', 'categories')))[0]?.label).toBe(
		'Fasteners'
	);
});
