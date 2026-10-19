import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Decimal, dec } from '../src/decimal.ts';
import { encodeWire, reviveWire } from '../src/wire.ts';

describe('std/wire', () => {
	it('revives `{ $dec }` and nothing else', () => {
		const text =
			'{"a":{"$dec":"1.20"},"d":"2026-01-01","t":"2026-01-02T03:04:05.000Z","x":{"$dec":"1","y":2},"$d":{"$d":"2026-01-01"},"l":[{"$dec":"-0.5"}]}';
		const v = JSON.parse(text, reviveWire) as { [k: string]: unknown };
		assert.ok(v['a'] instanceof Decimal);
		assert.equal(String(v['a']), '1.20');
		assert.equal(v['d'], '2026-01-01');
		assert.equal(v['t'], '2026-01-02T03:04:05.000Z');
		assert.deepEqual(v['x'], { $dec: '1', y: 2 });
		assert.deepEqual(v['$d'], { $d: '2026-01-01' });
		assert.equal(String((v['l'] as unknown[])[0]), '-0.5');
	});
	it('runs from its own source text, as the guest prelude evaluates it', () => {
		const revive = new Function(`return (${reviveWire.toString()})`)() as typeof reviveWire;
		const v = JSON.parse('{"a":{"$dec":"2.50"}}', revive) as { a: unknown };
		assert.ok(v.a instanceof Decimal);
		assert.equal(String(v.a), '2.50');
	});
	it('encodes decimals at any depth and round-trips through JSON both ways', () => {
		const value = {
			a: dec('1.20'),
			b: [dec('-3'), null, undefined],
			c: { d: '2026-01-01', e: undefined },
			f: 2
		};
		const wire = encodeWire(value);
		assert.deepEqual(wire, {
			a: { $dec: '1.20' },
			b: [{ $dec: '-3' }, null, null],
			c: { d: '2026-01-01' },
			f: 2
		});
		assert.equal(JSON.stringify(wire), JSON.stringify(value));
		const back = JSON.parse(JSON.stringify(wire), reviveWire) as { a: Decimal };
		assert.ok(back.a instanceof Decimal && back.a.eq('1.2') && back.a.scale === 2);
	});
});
