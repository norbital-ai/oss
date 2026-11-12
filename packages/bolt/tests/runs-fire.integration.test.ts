// Crons on the host's clock (rule 52): `Runs.crons` lists what the manifest declares, and `Runs.fire` runs one slot once.
// A fired run writes its `sys_run` row only with its first effect, so a run that only reads leaves nothing behind.
import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Cause, Effect, Exit, Layer, Schema } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import { id_of } from '../src/decl/id.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Callables, Runs } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		quotes: {
			description: 'A quote',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		},
		products: {
			description: 'An ERP product',
			record_label: 'record.name',
			key: ['code'],
			unique: [{ fields: ['code'], import_key: true }],
			fields: { code: { kind: 'text' }, name: { kind: 'text' } }
		},
		chats: {
			description: 'A chat line',
			record_label: 'record.text',
			fields: { text: { kind: 'text' } }
		},
		entries: {
			description: 'An entry',
			record_label: 'record.text',
			fields: { text: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		quotes: {
			outputs: { default: { quotes: { fields: 'all' } } },
			create: { columns: { quotes: ['title'] } }
		},
		products: {
			outputs: { default: { products: { fields: 'all' } } },
			syncs: { erp: { with: 'erp', read: true, every: '30min' } }
		},
		chats: {
			outputs: { default: { chats: { fields: 'all' } } },
			syncs: { desk: { with: 'desk', read: true } }
		},
		entries: {
			outputs: { default: { entries: { fields: 'all' } } },
			syncs: { cal: { with: 'cal', read: true } }
		}
	},
	integrations: {
		erp: {
			description: 'An ERP database',
			driver: 'sqlserver',
			// a fake remote is never paced: a test's clock would not wake the wait, and the test would hang
			rate: '1/h',
			credential: { connection: { kind: 'text' } }
		},
		desk: { description: 'The desk', driver: 'whatsapp' },
		cal: { description: 'Calendars', driver: 'calendar' }
	},
	policies: {
		ops: { description: 'Ops', grants: { quotes: { outputs: { default: {} }, create: {} } } }
	},
	automations: {
		tidy: { description: 'Files a quote', on: [{ cron: '*/15 * * * *' }], policies: ['ops'] },
		nothing: {
			description: 'Has nothing to read',
			on: [{ cron: '*/5 * * * *' }],
			output: { kind: 'int' },
			policies: ['ops']
		},
		watch: {
			description: 'A safety net over the quotes',
			on: [{ cron: '* * * * *', rest: '1d' }],
			policies: ['ops']
		},
		peek: {
			description: 'Counts the quotes',
			on: [{ cron: '@daily', tz: 'Asia/Singapore' }],
			output: { kind: 'int' },
			policies: ['ops']
		}
	},
	teams: {},

	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default {
	automation: {
		tidy: { body: function* (input, ctx) {
			yield* ctx.act({ 'quotes.create': [{ title: ctx.run.trigger.kind === 'system' ? ctx.run.trigger.cause : 'requested' }] }); } },
		nothing: { body: function* () { return 0; } },
		watch: { body: function* (input, ctx) { yield* ctx.query({ quotes: {} }); } },
		peek: { body: function* (input, ctx) {
			const n = (yield* ctx.query({ quotes: {} })).quotes.rows.length;
			if (n > 1) throw new Error('too many quotes');
			return n;
		} }
	},
	model: {
		products: { bodies: { syncs: { erp: { read: function* ({cursor}, ctx) {
			return (yield* ctx.request({ op: 'values', values: {cursor} })).rows[0].page; } } } } },
		chats: { bodies: { syncs: { desk: { read: function* () { return { rows: [] }; } } } } },
		entries: { bodies: { syncs: { cal: { read: function* () { return { rows: [] }; } } } } }
	}
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
			seed: {
				sys_integration: [
					{ id: 'erp1', integration: 'erp', name: 'ERP one' },
					{ id: 'desk1', integration: 'desk', name: 'Desk one' },
					{ id: 'cal1', integration: 'cal', name: 'Cal one' }
				]
			}
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
	it.effect('refuses a sync identity through automation start without queuing it', () =>
		Effect.gen(function* () {
			const { t, sql } = yield* setup;
			const id = randomUUID();
			expect(yield* (yield* Callables).start({
				automation: 'products.sync.erp', runs: [{ id, input: {} }],
				authority: (yield* t.as(t.admin)).authority,
				bindings: { now: t.clock.now(), today: '2026-09-25', tz: 'UTC' }
			})).toMatchObject({ kind: 'refused', code: 'not_found' });
			expect(yield* sql('SELECT id FROM sys_run WHERE id=$1', [id])).toEqual([]);
		})
	);
	it.effect("lists each automation's cron in its zone and a model sync's declared cadence", () =>
		Effect.gen(function* () {
			const { crons } = yield* setup;
			expect(yield* crons).toEqual([
				{ id: 'tidy', cron: '*/15 * * * *', zone: 'UTC' },
				{ id: 'nothing', cron: '*/5 * * * *', zone: 'UTC' },
				{ id: 'watch', cron: '* * * * *', zone: 'UTC' },
				{ id: 'peek', cron: '0 0 * * *', zone: 'Asia/Singapore' },
				{ id: 'products.sync.erp', cron: '*/30 * * * *', zone: 'UTC' },
				{ id: 'chats.sync.desk', cron: '*/15 * * * *', zone: 'UTC' },
				{ id: 'entries.sync.cal', cron: '*/15 * * * *', zone: 'UTC' }
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
				expect(yield* fire('products.sync.erp', NEXT)).toMatchObject({ ran: false });
				expect(requests).toBe(1);
				t.clock.advance('30s');
				yield* t.run_due();
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

	const noRows = { rows: [{ page: { rows: [], cursor: 1, more: false } }] };
	const atMinutes = (minutes: number) =>
		new Date(Date.parse(NEXT) + minutes * 60_000).toISOString();
	const restOf = (
		sql: (text: string) => Effect.Effect<readonly { readonly [key: string]: unknown }[], unknown>
	) =>
		sql(
			`SELECT health ->> 'state' AS state, health ->> 'failures' AS failures, health ->> 'retry_at' AS retry FROM sys_sync WHERE instance = 'erp1'`
		).pipe(Effect.orDie);
	it.effect('a SQL sync with a rejected request rests and skips slots while the rest lasts', () =>
		Effect.gen(function* () {
			const { t, fire, sql } = yield* setup;
			let requests = 0;
			t.fakes.links.answer = () =>
				Effect.suspend(() => {
					requests++;
					return Effect.fail(
						new FacilityFailure({ kind: 'invalid', message: 'ERP request refused' })
					);
				});
			expect(yield* fire('products.sync.erp', atMinutes(100))).toEqual({ ran: true });
			expect(requests).toBe(1);
			expect(yield* restOf(sql)).toMatchObject([{ state: 'attention', failures: '1' }]);
			const [integration] = yield* sql(
				`SELECT revision, status FROM sys_integration WHERE id = 'erp1'`
			);
			t.clock.advance('2min');
			expect(yield* fire('products.sync.erp', atMinutes(110))).toEqual({ ran: true });
			expect(requests).toBe(2);
			const [rest] = yield* restOf(sql);
			expect(rest).toMatchObject({ failures: '2' });
			// the rest stays on the sync: the integration's health did not move, so nobody is notified again
			expect(yield* sql(`SELECT revision, status FROM sys_integration WHERE id = 'erp1'`)).toEqual([
				integration
			]);
			expect(JSON.stringify(integration)).not.toContain('retry_at');
			const before = yield* sql(
				`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'products.sync.erp'`
			);
			expect(yield* fire('products.sync.erp', atMinutes(120))).toMatchObject({ ran: false });
			expect(requests).toBe(2);
			expect(
				yield* sql(`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'products.sync.erp'`)
			).toEqual(before);
		})
	);
	it.effect('a person starting a resting sync reads at once, and its success ends the rest', () =>
		Effect.gen(function* () {
			const { t, fire, sql } = yield* setup;
			const callables = yield* Callables;
			let requests = 0;
			t.fakes.links.answer = () =>
				Effect.sync(() => {
					requests++;
					return noRows;
				});
			yield* t.db.write({
				text: `UPDATE sys_sync SET health = $1::jsonb WHERE instance = 'erp1'`,
				params: [
					JSON.stringify({
						state: 'attention',
						failures: 4,
						retry_at: new Date(Date.parse(t.clock.now()) + 3_600_000).toISOString()
					})
				]
			});
			expect(yield* fire('products.sync.erp', atMinutes(130))).toMatchObject({ ran: false });
			expect(requests).toBe(0);
			yield* callables.sync_control({
				model: 'products', sync: 'erp',
				id: randomUUID(), input: {},
				authority: (yield* t.as(t.admin)).authority,
				bindings: { now: t.clock.now(), today: '2026-09-25', tz: 'UTC' }
			});
			yield* t.run_due();
			expect(requests).toBe(1);
			expect(yield* restOf(sql)).toEqual([{ state: 'ready', failures: null, retry: null }]);
			expect(yield* fire('products.sync.erp', atMinutes(140))).toEqual({ ran: true });
			expect(requests).toBe(2);
		})
	);
	it.effect("turning a connection off and on again ends its syncs' rest", () =>
		Effect.gen(function* () {
			const { t, fire, sql } = yield* setup;
			let requests = 0;
			t.fakes.links.answer = () =>
				Effect.sync(() => {
					requests++;
					return noRows;
				});
			yield* t.db.write({
				text: `UPDATE sys_sync SET health = $1::jsonb WHERE instance = 'erp1'`,
				params: [
					JSON.stringify({
						state: 'attention',
						failures: 4,
						retry_at: new Date(Date.parse(t.clock.now()) + 3_600_000).toISOString()
					})
				]
			});
			const AccountPage = Schema.Struct({ sys_integration: Schema.Struct({ rows: Schema.Array(
				Schema.Struct({ id: id_of('sys_integration'), revision: Schema.Int })
			) }) });
			const active = (value: boolean) => Effect.gen(function* () {
				const { sys_integration: instances } = yield* (yield* t.as(t.admin)).query({ sys_integration: { fields: ['revision'] } })
					.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccountPage)));
				const target = instances.rows.find((row) => row.id === 'erp1');
				if (target === undefined) return yield* Effect.die('no erp1');
				return yield* (yield* t.as(t.admin)).act({ 'sys_integration.update': [{ target, set: { active: value } }] });
			});
			yield* active(false);
			yield* active(true);
			expect(yield* restOf(sql)).toMatchObject([
				{ state: 'attention', failures: null, retry: null }
			]);
			expect(yield* fire('products.sync.erp', atMinutes(150))).toEqual({ ran: true });
			expect(requests).toBe(1);
		})
	);
	it.effect('a resting connection does not hold back a healthy one', () =>
		Effect.gen(function* () {
			const { t, fire, sql } = yield* setup;
			const read: string[] = [];
			t.fakes.links.answer = (instance) =>
				Effect.sync(() => {
					read.push(instance);
					return noRows;
				});
			yield* t.db.write({
				text: `INSERT INTO sys_integration (id, integration, name, active) VALUES ('erp2', 'erp', 'ERP two', true)`,
				params: []
			});
			yield* t.db.write({
				text: `UPDATE sys_sync SET health = $1::jsonb WHERE instance = 'erp1'`,
				params: [
					JSON.stringify({
						state: 'attention',
						failures: 4,
						retry_at: new Date(Date.parse(t.clock.now()) + 3_600_000).toISOString()
					})
				]
			});
			expect(yield* fire('products.sync.erp', atMinutes(160))).toEqual({ ran: true });
			expect(read).toEqual(['erp2']);
			yield* t.db.write({ text: `DELETE FROM sys_sync WHERE instance = 'erp2'`, params: [] });
			yield* t.db.write({ text: `DELETE FROM sys_integration WHERE id = 'erp2'`, params: [] });
			yield* t.db.write({
				text: `UPDATE sys_sync SET health = NULL WHERE instance = 'erp1'`,
				params: []
			});
		})
	);
	it.effect("the kit's clock fires a slot it lands on exactly, once", () =>
		Effect.gen(function* () {
			const { t, sql } = yield* setup;
			const ticks = `SELECT count(*)::int AS n FROM quotes`;
			const [before] = yield* sql(ticks);
			t.clock.set('2026-09-25T10:45:00.000Z');
			yield* t.run_due();
			yield* t.run_due();
			const [after] = yield* sql(ticks);
			expect(Number(after?.['n'])).toBe(Number(before?.['n']) + 1);
		})
	);

	it.effect("the kit's clock set back to a slot that wrote says so, rather than run nothing", () =>
		Effect.gen(function* () {
			const { t } = yield* setup;
			t.clock.set('2026-09-25T10:45:00.000Z');
			const exit = yield* Effect.exit(t.run_due());
			expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain(
				'tidy at 2026-09-25T10:45:00.000Z already ran'
			);
		})
	);
});

// A database billed by the second stays asleep until a slot needs its data.
const Sleeping = Layer.unwrap(
	Effect.map(program(guestSource), (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			now: '2026-09-25T10:15:02.000Z',
			seed: {
				sys_integration: [
					{ id: 'desk1', integration: 'desk', name: 'Desk one' },
					{ id: 'cal1', integration: 'cal', name: 'Cal one' }
				]
			}
		})
	)
);
layer(Sleeping, { excludeTestServices: true })('a sleeping database', (it) => {
	it.effect('a cold start and a slot that reads nothing make no trip to it', () =>
		Effect.gen(function* () {
			const { t, fire } = yield* setup;
			expect(t.count).toMatchObject({ reads: 0, writes: 0 });
			expect(yield* fire('nothing', SLOT)).toEqual({ ran: false });
			expect(t.count).toMatchObject({ reads: 0, writes: 0 });
		})
	);
	it.effect('a cron that rests reads once, and again only once the workspace was used', () =>
		Effect.gen(function* () {
			const { t, fire, sql } = yield* setup;
			// a generation's own start-up work lies behind it
			yield* sql('SELECT 1');
			t.clock.advance('6min');
			yield* t.settled();
			const first = yield* fire('watch', '2026-09-25T10:20:00.000Z');
			expect(first).toMatchObject({ ran: false, until: '2026-09-26T00:00:00.000Z' });
			expect(t.count.reads).toBeGreaterThan(0);
			t.count.reset();
			// a read that found nothing still stands: nothing touched the database since
			expect(yield* fire('watch', '2026-09-25T10:21:00.000Z')).toEqual(first);
			expect(t.count).toMatchObject({ reads: 0, writes: 0 });
			// someone used the workspace, so the read is worth making again
			yield* t.db.write({
				text: `INSERT INTO sys_config (key, value) VALUES ('a person', 'was here')`,
				params: []
			});
			t.count.reset();
			expect(yield* fire('watch', '2026-09-25T10:22:00.000Z')).toEqual(first);
			expect(t.count.reads).toBeGreaterThan(0);
		})
	);

	it.effect(
		'a healthy sync over a driver that pushes rests until tomorrow, on no trip; a quiet read commits nothing; a failing one keeps its own rest',
		() =>
			Effect.gen(function* () {
				const { t, fire, sql } = yield* setup;
				let pages = 0;
				t.fakes.links.page = () =>
					Effect.sync(() => {
						pages++;
						return { items: [], cursor: 'token', more: false };
					});
				const SYNC = 'entries.sync.cal';
				const slotAt = () => t.clock.now();
				const asleep = Effect.gen(function* () {
					t.clock.advance('6min');
					yield* t.settled();
					t.count.reset();
				});
				const version = () =>
					sql(`SELECT version FROM sys_sync WHERE instance = 'cal1'`).pipe(
						Effect.map((rows) => rows[0]?.['version'])
					);
				yield* fire(SYNC, slotAt());
				expect(pages).toBe(1);
				const midnight = new Date((Math.floor(Date.parse(slotAt()) / 86_400_000) + 1) * 86_400_000);
				const until = midnight.toISOString();
				yield* asleep;
				expect(yield* fire(SYNC, slotAt())).toEqual({ ran: false, until });
				expect(pages).toBe(1);
				expect(t.count).toMatchObject({ reads: 0, writes: 0 });
				// tomorrow's first slot reads; nothing arrived, so its page commits nothing, and the rest holds on no trip
				const stored = yield* version();
				t.clock.set(new Date(Date.parse(until) + 60_000).toISOString());
				yield* t.settled();
				t.count.reset();
				yield* fire(SYNC, slotAt());
				expect(pages).toBe(2);
				expect(yield* version()).toEqual(stored);
				yield* asleep;
				expect(yield* fire(SYNC, slotAt())).toEqual({
					ran: false,
					until: new Date(Date.parse(until) + 86_400_000).toISOString()
				});
				expect(pages).toBe(2);
				expect(t.count).toMatchObject({ reads: 0, writes: 0 });
				// a conversation's sync rests the same way
				yield* fire('chats.sync.desk', slotAt());
				yield* asleep;
				expect(yield* fire('chats.sync.desk', slotAt())).toMatchObject({ ran: false });
				expect(t.count).toMatchObject({ reads: 0, writes: 0 });
				// a hint's read that fails is a sync in trouble: its slots come back after its own rest, not tomorrow
				t.fakes.links.page = () =>
					Effect.suspend(() => {
						pages++;
						return Effect.fail(new FacilityFailure({ kind: 'upstream', message: 'no calendar' }));
					});
				yield* t.syncs.read(SYNC).pipe(Effect.flip);
				expect(pages).toBe(3);
				yield* asleep;
				yield* fire(SYNC, slotAt());
				expect(pages).toBe(4);
			})
	);
});
