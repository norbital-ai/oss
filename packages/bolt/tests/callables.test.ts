// Pure parts of the callables area: typed-input decode (rules 5, 23, 36) and the rule 52a due time.
import { describe, expect, it } from '@effect/vitest';
import { due_at as roundedDueAt, materialize } from '../src/engine/runs/time.ts';
const due_at = (now: string, at?: string | { var: string }) => {
	const ms = Date.parse(now);
	const when =
		at === undefined
			? now
			: typeof at === 'string'
				? at
				: materialize(at, { now, today: now.slice(0, 10) });
	return new Date(roundedDueAt(ms, Date.parse(String(when)))).toISOString();
};
import { decodeInput as decode } from '../src/engine/callables/decode.ts';

const decodeInput = (...args: Parameters<typeof decode>) => {
	const { value, ...metadata } = decode(...args);
	return metadata;
};
const ID = '0199a000-0000-4000-8000-0000000000c1';

describe('decodeInput', () => {
	it('collects declared references inside shaped JSON', () => {
		expect(
			decodeInput(
				{
					payload: { kind: 'json', shape: { kind: 'ref', to: 'customers', many: true } },
					opaque: { kind: 'json' }
				},
				{ payload: [ID], opaque: { customer: ID } }
			)
		).toEqual({ problems: [], refs: [{ model: 'customers', id: ID, field: 'payload.0' }] });
	});
	it('collects references in the open keys of an object', () => {
		expect(
			decodeInput(
				{
					customers: {
						kind: 'object',
						fields: { label: { kind: 'text' } },
						rest: { kind: 'ref', to: 'customers' }
					}
				},
				{ customers: { label: 'Team', lead: ID } }
			)
		).toEqual({ problems: [], refs: [{ model: 'customers', id: ID, field: 'customers.lead' }] });
	});
	it('reports every offender at once, refuses excess keys, and collects refs', () => {
		const spec = {
			title: { kind: 'text', max: 3 },
			n: { kind: 'int', min: 1 },
			when: { kind: 'date', optional: true },
			tags: { kind: 'enum', values: ['a', 'b'], many: true },
			who: { kind: 'ref', to: 'customers' },
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
				who: 42,
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
		const optionalId = { kind: 'ref', to: 'customers', optional: true } as const;
		const spec = {
			list: { kind: 'json', shape: optionalId, many: true },
			record: { kind: 'record', of: optionalId },
			union: { kind: 'union', of: [{ kind: 'int' }, { kind: 'text', optional: true }] },
			tagged: { kind: 'union', by: 'type', arms: { ref: { who: optionalId } } },
			taggedList: {
				kind: 'json',
				shape: { kind: 'union', by: 'type', optional: true, arms: { ref: { who: optionalId } } },
				many: true
			},
			required: { kind: 'text', many: true }
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
			decodeInput(
				{ list: { kind: 'json', shape: spec.union, many: true } },
				{ list: [null, 1, ID] }
			)
		).toEqual({ problems: [], refs: [] });
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

describe('due_at (rule 52a)', () => {
	const now = '2026-09-25T10:01:30.000Z';
	it('is exact under 5 minutes ahead and rounds up to a 5-minute bucket from 5 minutes on', () => {
		expect(due_at(now)).toBe(now);
		expect(due_at(now, { var: 'now + minutes(1)' })).toBe('2026-09-25T10:02:30.000Z');
		expect(due_at(now, { var: 'now + hours(1)' })).toBe('2026-09-25T11:05:00.000Z');
		expect(due_at(now, '2026-09-26T00:00:00.000Z')).toBe('2026-09-26T00:00:00.000Z');
	});
});
