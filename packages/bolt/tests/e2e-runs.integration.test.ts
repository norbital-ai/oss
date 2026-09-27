// End to end through the engine entry and the test kit: a `created` trigger with a delay is queued by the act's own
// statement, announced to the deadlines port, and runs its body when the deadline wakes (rules 49, 52a).
import { describe, expect, it } from 'vitest';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { quotes: { description: 'A quote', label: 'title',
		fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['draft', 'sent'], default: 'draft' } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, update: { input: { columns: ['status'] } } } },
	policies: { ops: { description: 'Ops', grants: { quotes: { read: true, create: true, update: true } } } },
	automations: { remind: { description: 'Send an hour after creation', on: { created: 'quotes', delay: '1h' }, runAs: ['ops'] } },
	integrations: {}, pipelines: {}, teams: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;
const guest = { source: `export default { automation: { remind: { body: async (input, ctx) => {
	for (const id of input.ids) await ctx.act('quotes.update', { target: id, set: { status: 'sent' } });
} } } };` };

describe('an automation on created with a delay', () => {
	it('fires once through the deadlines port, not before its due time', async () => {
		const t = await testWorkspace({ manifest, guest, now: '2026-09-25T10:00:00.000Z' });
		const ops = t.as(t.member(['ops']));
		const id = (await ops.act('quotes.create', { title: 'q1' }) as Extract<Outcome, { kind: 'committed' }>).records[0]!.id;
		expect(t.fakes.deadlines.announced).toContainEqual({ scope: 'test', at: '2026-09-25T11:00:00.000Z' });
		await t.runDue();
		expect(await ops.get('quotes', id)).toMatchObject({ status: 'draft' });
		t.clock.advance('1h');
		await t.runDue();
		expect(await ops.get('quotes', id)).toMatchObject({ status: 'sent' });
		const runs = (await t.db.read([{ text: 'SELECT automation, state FROM sys_run', params: [] }]))[0]!.rows;
		expect(runs).toEqual([{ automation: 'remind', state: 'succeeded' }]);
	});
});
