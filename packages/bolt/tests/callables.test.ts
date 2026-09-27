// Pure parts of the callables area: typed-input decode (rules 5, 23, 36) and the rule 52a due time.
import { describe, expect, it } from 'vitest';
import { dueAt } from '../src/engine/callables/index.ts';
import { decodeInput } from '../src/engine/callables/decode.ts';

const ID = '0199a000-0000-4000-8000-0000000000c1';

describe('decodeInput', () => {
	it('reports every offender at once, refuses excess keys, and collects refs', () => {
		const spec = {
			title: { kind: 'text', max: 3 }, n: { kind: 'int', min: 1 }, when: { kind: 'date', optional: true },
			tags: { kind: 'list', of: { kind: 'enum', values: ['a', 'b'] } }, who: { kind: 'id', of: 'customers' },
			shape: { kind: 'union', by: 'type', arms: { box: { side: { kind: 'number' } } } },
		} as const;
		expect(decodeInput(spec, { title: 'ok', n: 2, tags: ['a'], who: ID, shape: { type: 'box', side: 2 } })).toEqual({ problems: [], refs: [{ collection: 'customers', id: ID, field: 'who' }] });
		expect(decodeInput(spec, { title: 'long', n: 0, when: '2026-9-1', tags: ['c'], who: 'x', shape: { type: 'ball' }, extra: 1 }).problems.map((p) => p.path))
			.toEqual(['extra', 'title', 'n', 'when', 'tags.0', 'who', 'shape']);
		expect(decodeInput(spec, {}).problems.map((p) => p.message)).toEqual(['is required', 'is required', 'is required', 'is required', 'is required']);
	});
});

describe('dueAt (rule 52a)', () => {
	const now = '2026-09-25T10:01:30.000Z';
	it('is exact under 5 minutes ahead and rounds up to a 5-minute bucket from 5 minutes on', () => {
		expect(dueAt(now)).toBe(now);
		expect(dueAt(now, { now: '+1min' })).toBe('2026-09-25T10:02:30.000Z');
		expect(dueAt(now, { now: '+1h' })).toBe('2026-09-25T11:05:00.000Z');
		expect(dueAt(now, '2026-09-26T00:00:00.000Z')).toBe('2026-09-26T00:00:00.000Z');
	});
});
