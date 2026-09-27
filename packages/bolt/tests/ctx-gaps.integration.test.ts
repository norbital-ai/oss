// Gaps found migrating real templates (CTX-TYPES): `ctx.refuse` in a query, `ctx.act` upsert with `onConflict` from an
// action, and an untagged scalar union input decoded by kind.
import { beforeEach, expect, it } from 'vitest';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { rates: { description: 'A rate', label: 'code', key: ['code'], fields: { code: { kind: 'text' }, value: { kind: 'text' } } } },
	relationships: {},
	collections: {
		rates: {
			read: { fields: 'all' },
			create: { input: { columns: ['code', 'value'] } },
			update: { input: { columns: ['value'] } },
			queries: { check: { description: 'Refuses', input: {}, output: { kind: 'int' } } },
			actions: {
				put: { description: 'Upsert one rate', input: { code: { kind: 'text' }, v: { kind: 'union', of: [{ kind: 'bool' }, { kind: 'number' }, { kind: 'text' }] } },
					output: { kind: 'text' } },
			},
		},
	},
	integrations: {}, pipelines: {},
	policies: { rep: { description: 'Rep', grants: { rates: { read: true, create: true, update: true, queries: ['check'], actions: ['put'] } } } },
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}, agent: { skills: {} }, apps: {},
} as unknown as EngineManifest;

const guest = { source: `export default { collection: { rates: { bodies: {
	queries: { check: async (input, ctx) => ctx.refuse('not today') },
	actions: {
		put: async (input, ctx) => {
			await ctx.act('rates.upsert', { code: input.code, value: String(input.v) }, { onConflict: 'update' });
			return typeof input.v;
		},
	},
} } } };` };

let t: TestWorkspace;
beforeEach(async () => { t = await testWorkspace({ manifest, guest }); });
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };

it('a query refuses with ctx.refuse', async () => {
	await expect(t.as(t.member(['rep'])).query('rates.check')).rejects.toMatchObject({ code: 'refused', message: 'not today' });
});

it('an action upserts through ctx.act with onConflict', async () => {
	const rep = t.as(t.member(['rep']));
	expect(ok(await rep.act('rates.put', { code: 'a', v: 1 })).output).toBe('number');
	expect(ok(await rep.act('rates.put', { code: 'a', v: true })).output).toBe('boolean');
	expect((await rep.read('rates', { all: true })).rows.map((r) => [r['code'], r['value']])).toEqual([['a', 'true']]);
});

it('an untagged union input decodes by kind', async () => {
	const rep = t.as(t.member(['rep']));
	expect(ok(await rep.act('rates.put', { code: 'b', v: 'x' })).output).toBe('string');
	expect(await rep.act('rates.put', { code: 'b', v: [1] })).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'v' });
});
