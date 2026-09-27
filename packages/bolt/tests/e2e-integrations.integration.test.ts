// End to end through the engine entry and the test kit: a one_way integration fed by a fake inbound channel lands its
// mapped row once, however often the transport redelivers (§3.3.5, rule 23).
import { describe, expect, it } from 'vitest';
import type { TransportEvent, TransportPort } from '../src/engine/contracts.ts';
import { testWorkspace } from '../src/test/index.ts';
import { guestSource, mail, manifest } from './integrations-fixture.ts';

describe('a one_way integration from a channel', () => {
	it('an inbound mail on the subscribed transport queues one run; the run lands it in pcn_notices; a redelivery is no second row', async () => {
		const t = await testWorkspace({ manifest, guest: { source: guestSource } });
		let sink: ((e: TransportEvent) => Promise<void>) | undefined;
		const email: TransportPort = { send: async () => ({ providerId: 'p' }), subscribe: (s) => { sink = s; return () => { sink = undefined; }; } };
		const off = t.engine.integrations.subscribe([email], () => crypto.randomUUID());
		const event: TransportEvent = { kind: 'inbound', channel: 'supplier_inbox', message: mail() };
		await sink!(event);
		await sink!(event);
		off();
		expect(sink).toBeUndefined();
		const queued = (await t.db.read([{ text: `SELECT automation, input->>'mode' AS mode FROM sys_run WHERE cause = 'inbound'`, params: [] }]))[0]!.rows;
		expect(queued).toEqual([{ automation: 'pcn_notices.integration', mode: 'deliver' }]);
		expect(t.fakes.deadlines.announced.at(-1)).toEqual({ scope: 'test', at: t.clock.now() });
		await t.runDue();
		const rows = (await t.as(t.member(['sales'])).read('pcn_notices', { all: true, select: { message_id: true, from_address: true } })).rows;
		expect(rows).toEqual([expect.objectContaining({ message_id: '<pcn-1@onsemi.com>', from_address: 'pcn@onsemi.com' })]);
	});
});
