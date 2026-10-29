// Crons on the host's clock (rule 52): `Runs.crons` lists what the manifest declares, and `Runs.fire` runs one slot once.
// A fired run writes its `sys_run` row only with its first effect, so a run that only reads leaves nothing behind.
import { expect, layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Runs } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
		products: {
			description: 'An ERP product',
			label: 'name',
			key: ['source', 'code'],
			fields: { code: { kind: 'text' }, name: { kind: 'text' } }
		}
	},
	relationships: {
		'products.source': { to: 'sys_integration', where: { integration: { eq: 'erp' } } }
	},
	exposures: {
		quotes: { read: { quotes: { fields: 'all' } }, create: { columns: { quotes: ['title'] } } },
		products: {
			read: { products: { fields: 'all' } },
			syncs: { erp: { with: 'erp', read: true, every: '30min' } }
		}
	},
	integrations: {
		erp: {
			description: 'An ERP database',
			driver: 'sqlserver',
			credential: { connection: { kind: 'text' } }
		}
	},
	policies: {
		ops: { description: 'Ops', grants: { quotes: { read: true, create: true } } }
	},
	automations: {
		tidy: { description: 'Files a quote', on: { cron: '*/15 * * * *' }, policies: ['ops'] },
		peek: {
			description: 'Counts the quotes',
			on: { cron: '@daily', tz: 'Asia/Singapore' },
			policies: ['ops']
		}
	},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default {
	automation: {
		tidy: { body: function* (input, ctx) {
			yield* ctx.act('quotes.create', [{ title: ctx.run.trigger.kind === 'system' ? ctx.run.trigger.cause : 'requested' }]); } },
		peek: { body: function* (input, ctx) {
			const n = (yield* ctx.query({ quotes: {} })).quotes.rows.length;
			if (n > 1) throw new Error('too many quotes');
			return n;
		} }
	},
	model: { products: { bodies: { syncs: { erp: { read: function* ({cursor}, ctx) {
		return (yield* ctx.request({ op: 'values', values: {cursor} })).rows[0].page; } } } } } }
};`;
const SLOT = '2026-09-25T10:15:00.000Z',
	NEXT = '2026-09-25T10:30:00.000Z';

// One workspace, its tests in order: each slot it fires stays fired for the tests after it.
const Fixture = Layer.unwrap(
	Effect.map(program(guestSource), (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			now: '2026-09-25T10:15:02.000Z',
			seed: { sys_integration: [{ id: 'erp1', integration: 'erp', name: 'ERP one' }] }
		})
	)
);
const setup = Effect.gen(function* () {
	const t = yield* TestWorkspace,
		runs = yield* Runs,
		context = yield* Effect.context<TestWorkspace | Runs>();
	const sql = (text: string, params: Json[] = []) =>
		t.db.read([{ text, params }]).pipe(Effect.map(([result]) => result?.rows ?? []));
	return {
		t,
		sql,
		fire: (id: string, slot: string) => runs.fire(id, slot).pipe(Effect.provide(context)),
		crons: runs.crons
	};
});

layer(Fixture, { excludeTestServices: true })('crons on the host clock', (it) => {
	it.effect("lists each automation's cron in its zone and a model sync's declared cadence", () =>
		Effect.gen(function* () {
			const { crons } = yield* setup;
			expect(yield* crons).toEqual([
				{ id: 'tidy', cron: '*/15 * * * *', zone: 'UTC' },
				{ id: 'peek', cron: '0 0 * * *', zone: 'Asia/Singapore' },
				{ id: 'products.sync.erp', cron: '*/30 * * * *', zone: 'UTC' }
			]);
		})
	);

	it.effect(
		'a run that only reads writes no row; a run that writes has its row, with no starter and the cron as its trigger; each slot runs once',
		() =>
			Effect.gen(function* () {
				const { fire, sql } = yield* setup;
				expect(yield* fire('peek', '2026-09-24T16:00:00.000Z')).toEqual({ ran: false });
				expect(yield* sql(`SELECT count(*)::int AS n FROM sys_run`)).toEqual([{ n: 0 }]);
				expect(yield* fire('tidy', SLOT)).toEqual({ ran: true });
				expect(yield* fire('tidy', SLOT)).toEqual({ ran: false });
				expect(
					yield* sql(
						`SELECT automation, cause, state, attempts, due_at = $1::timestamptz AS at_slot, starter, trigger FROM sys_run`,
						[SLOT]
					)
				).toEqual([
					{
						automation: 'tidy',
						cause: 'cron',
						state: 'succeeded',
						attempts: 1,
						at_slot: true,
						starter: null,
						trigger: { kind: 'system', cause: 'cron' }
					}
				]);
				// the run held `ops` as the system; its body read the cron as its trigger
				expect(yield* sql(`SELECT title FROM quotes`)).toEqual([{ title: 'cron' }]);
				expect(yield* fire('tidy', NEXT)).toEqual({ ran: true });
				// the read-only run that fails keeps its row
				expect(yield* fire('peek', '2026-09-25T16:00:00.000Z')).toEqual({ ran: true });
				expect(yield* sql(`SELECT state FROM sys_run WHERE automation = 'peek'`)).toEqual([
					{ state: 'failed' }
				]);
			})
	);

	it.effect(
		'a sync cron claims its lease before I/O, retries a failed attempt without refiring its slot, and persists its cursor',
		() =>
			Effect.gen(function* () {
				const { t, fire, sql } = yield* setup;
				let requests = 0;
				t.fakes.links.answer = () =>
					Effect.gen(function* () {
						requests++;
						expect(
							yield* sql(
								"SELECT state, attempts FROM sys_run WHERE automation = 'products.sync.erp'"
							).pipe(Effect.orDie)
						).toEqual([{ state: 'running', attempts: requests }]);
						if (requests === 1)
							return yield* Effect.fail(
								new FacilityFailure({ kind: 'upstream', message: 'ERP unavailable' })
							);
						return {
							rows: [
								{ page: { rows: [{ $id: 'A', code: 'A', name: 'Alpha' }], cursor: 1, more: false } }
							]
						};
					});
				expect(yield* fire('products.sync.erp', NEXT)).toEqual({ ran: true });
				expect(
					yield* sql("SELECT state, attempts FROM sys_run WHERE automation = 'products.sync.erp'")
				).toEqual([{ state: 'queued', attempts: 1 }]);
				expect(yield* fire('products.sync.erp', NEXT)).toEqual({ ran: false });
				expect(requests).toBe(1);
				t.clock.advance('30s');
				yield* t.runDue();
				expect(requests).toBe(2);
				expect(
					yield* sql(
						"SELECT cause, state, attempts FROM sys_run WHERE automation = 'products.sync.erp'"
					)
				).toEqual([{ cause: 'cron', state: 'succeeded', attempts: 2 }]);
				expect(yield* sql('SELECT code, name FROM products')).toEqual([
					{ code: 'A', name: 'Alpha' }
				]);
				expect(yield* sql(`SELECT sync, cursor FROM sys_sync WHERE instance = 'erp1'`)).toEqual([
					{ sync: 'products.sync.erp', cursor: 1 }
				]);
			})
	);

	it.effect("the kit's clock fires a slot it lands on exactly, once", () =>
		Effect.gen(function* () {
			const { t, sql } = yield* setup;
			const ticks = `SELECT count(*)::int AS n FROM quotes`;
			const [before] = yield* sql(ticks);
			t.clock.set('2026-09-25T10:45:00.000Z');
			yield* t.runDue();
			yield* t.runDue();
			const [after] = yield* sql(ticks);
			expect(Number(after?.['n'])).toBe(Number(before?.['n']) + 1);
		})
	);
});
