// Pure parts of the callables area: typed-input decode (rules 5, 23, 36) and the rule 52a due time.
import { describe, expect, it } from '@effect/vitest';
import { dueAt as roundedDueAt, materialize } from '../src/engine/runs/time.ts';
const dueAt = (now: string, at?: string | { var: string }) => {
	const ms = Date.parse(now);
	const when = at === undefined ? now : typeof at === 'string' ? at : materialize(at, { now, today: now.slice(0, 10) });
	return new Date(roundedDueAt(ms, Date.parse(String(when)))).toISOString();
};
import { decodeInput as decode } from '../src/engine/callables/decode.ts';

const decodeInput = (...args: Parameters<typeof decode>) => {
	const { value, ...metadata } = decode(...args);
	return metadata;
};
const ID = '0199a000-0000-4000-8000-0000000000c1';

describe('decodeInput', () => {
	it('reports every offender at once, refuses excess keys, and collects refs', () => {
		const spec = {
			title: { kind: 'text', max: 3 },
			n: { kind: 'int', min: 1 },
			when: { kind: 'date', optional: true },
			tags: { kind: 'list', of: { kind: 'enum', values: ['a', 'b'] } },
			who: { kind: 'id', of: 'customers' },
			shape: { kind: 'union', by: 'type', arms: { box: { side: { kind: 'number' } } } }
		} as const;
		expect(
			decodeInput(spec, {
				title: 'ok',
				n: 2,
				tags: ['a'],
				who: ID,
				shape: { type: 'box', side: 2 }
			})
		).toEqual({ problems: [], refs: [{ model: 'customers', id: ID, field: 'who' }] });
		expect(
			decodeInput(spec, {
				title: 'long',
				n: 0,
				when: '2026-9-1',
				tags: ['c'],
				who: 'x',
				shape: { type: 'ball' },
				extra: 1
			}).problems.map((p) => p.path)
		).toEqual(['extra', 'title', 'n', 'when', 'tags.0', 'who', 'shape']);
		expect(decodeInput(spec, {}).problems.map((p) => p.message)).toEqual([
			'is required',
			'is required',
			'is required',
			'is required',
			'is required'
		]);
	});
	it('admits nullable values inside lists, records and union arms without admitting null required values', () => {
		const optionalId = { kind: 'id', of: 'customers', optional: true } as const;
		const spec = {
			list: { kind: 'list', of: optionalId },
			record: { kind: 'record', of: optionalId },
			union: { kind: 'union', of: [{ kind: 'int' }, optionalId] },
			tagged: { kind: 'union', by: 'type', arms: { ref: { who: optionalId } } },
			taggedList: {
				kind: 'list',
				of: { kind: 'union', by: 'type', optional: true, arms: { ref: { who: optionalId } } }
			},
			required: { kind: 'list', of: { kind: 'text' } }
		} as const;
		expect(
			decodeInput(spec, {
				list: [null, ID],
				record: { absent: null, present: ID },
				union: null,
				tagged: { type: 'ref', who: null },
				taggedList: [null, { type: 'ref', who: ID }],
				required: ['ok']
			})
		).toEqual({
			problems: [{ path: 'union', message: 'is required' }],
			refs: [
				{ model: 'customers', id: ID, field: 'list.1' },
				{ model: 'customers', id: ID, field: 'record.present' },
				{ model: 'customers', id: ID, field: 'taggedList.1.who' }
			]
		});
		expect(
			decodeInput({ list: { kind: 'list', of: spec.union } }, { list: [null, 1, ID] })
		).toEqual({
			problems: [],
			refs: [{ model: 'customers', id: ID, field: 'list.2' }]
		});
		expect(
			decodeInput(
				{ list: spec.required, tagged: spec.tagged },
				{ list: [null], tagged: { type: null, who: null } }
			).problems
		).toEqual([
			{ path: 'list.0', message: 'expected text' },
			{ path: 'tagged', message: 'Expected { readonly "type": "ref", ... }' }
		]);
	});
});

describe('dueAt (rule 52a)', () => {
	const now = '2026-09-25T10:01:30.000Z';
	it('is exact under 5 minutes ahead and rounds up to a 5-minute bucket from 5 minutes on', () => {
		expect(dueAt(now)).toBe(now);
		expect(dueAt(now, { var: 'now + minutes(1)' })).toBe('2026-09-25T10:02:30.000Z');
		expect(dueAt(now, { var: 'now + hours(1)' })).toBe('2026-09-25T11:05:00.000Z');
		expect(dueAt(now, '2026-09-26T00:00:00.000Z')).toBe('2026-09-26T00:00:00.000Z');
	});
});
