// End to end through the engine entry and the test kit: a live view on the engine's hub receives every commit the
// cell makes as a patch, stamped with the lane sequence the act replied with (rules 64–66).
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/protocol/wire.ts';
import { lowerRead } from '../src/engine/index.ts';
import { testWorkspace } from '../src/test/index.ts';
import { ACME, guest, manifest, seed } from './engine-fixture.ts';

describe('a live subscription on the engine', () => {
	it('receives the committed row, stamped with the act\'s sequence', async () => {
		const t = await testWorkspace({ manifest, guest, transforms: ['orders'], seed });
		const rep = t.engine.authority(t.member(['rep']));
		const frames: Frame[] = [];
		const conn = t.engine.live.connect(rep, (f) => frames.push(f), () => {});
		await t.engine.live.register(conn, 'orders', { read: lowerRead(manifest, 'read', ['orders', { all: true, select: { title: true } }]) });
		const r = await t.engine.act({ collection: 'orders', verb: 'create', input: { title: ' desk ', region: 'north', customer: ACME }, key: 'k1',
			issuedAt: t.clock.now(), authority: rep, bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }, invocationId: 'i1' });
		expect(r.outcome.kind).toBe('committed');
		await t.engine.live.settled();
		// the first answer, then the commit as a patch built from its RETURNING image
		const last = frames.filter((f) => f.t === 'patch').at(-1) as Extract<Frame, { t: 'patch' }>;
		expect(last.v).toBe(r.v);
		expect(last.ops).toMatchObject([{ op: 'upsert', index: 0, row: { title: 'desk' } }]);
	});
});
