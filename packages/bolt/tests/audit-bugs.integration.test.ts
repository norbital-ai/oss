// Reproductions for Bolt audit bugs 26, 28, 30, 35 (`stopping`), 38 and 45 (seed chunks): one mechanism each.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import type { Json } from '../src/decl/values.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { invite, revokeInvitation } from '../src/engine/identity/members.ts';
import { founder_bootstrap, load_keys, make_identity_host } from '../src/engine/identity/session.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { makeParking } from '../src/engine/parking.ts';
import { makeRunExecutor } from '../src/engine/runs/executor.ts';
import { makePruner } from '../src/engine/runs/prune.ts';
import type { Row } from '../src/engine/runs/rows.ts';
import { RunHandlers, Runs } from '../src/engine/services.ts';
import { restore_source, restorer } from '../src/engine/write/seed.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { admin, NOW, TODAY } from './write-fixture.ts';
import { manifest as written, open } from './write-p2.fixture.ts';
import { memory_audit_layer } from './support/audit.ts';
import { act_one } from './support/act-one.ts';

const empty: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: { ops: { description: 'Ops', grants: {} } },
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};

describe('bug 26: one statement reads the clock once', () => {
	it.effect('a revoked invitation and its history entry carry the same instant', () =>
		Effect.gen(function* () {
			const db = yield* TenantDb;
			yield* TestClock.setTime(Date.parse(NOW));
			// every read of the host clock moves it a second: two reads in one statement would disagree
			let reads = 0;
			const h = yield* make_identity_host({
				db,
				now: Effect.sync(() => new Date(Date.parse(NOW) + 1000 * reads++)),
				windows: new RateWindows(),
				keys: yield* load_keys(db),
				mail: { send: async () => ({ provider_id: 'x' }) },
				public_url: 'https://acme.example'
			});
			const founder = (yield* founder_bootstrap(h, 'boss@acme.example')).user;
			const boss = yield* new Authorities(empty, 'r1').member(db, 'bootstrap', founder);
			if (boss === null) return yield* Effect.die('no founder authority');
			const { id } = yield* invite(h, empty, boss, { email: 'late@acme.example' });
			yield* revokeInvitation(h, boss, id);
			const [rows] = yield* db.read([
				{
					text: `SELECT i.revoked_at = (SELECT at FROM bolt_history WHERE record::text = $1 ORDER BY revision DESC LIMIT 1) AS same
					FROM sys_invitation i WHERE i.id = $1`,
					params: [id]
				}
			]);
			expect(rows?.rows).toEqual([{ same: true }]);
		}).pipe(Effect.provide(Layer.mergeAll(TestDb.layer(empty), NodeCrypto.layer, memory_audit_layer)))
	);
});

const cron: EngineManifest = {
	...empty,
	automations: {
		ingest: { description: 'Stores an ingest', on: [{ cron: '*/15 * * * *' }], policies: ['ops'] },
		idle: { description: 'Reads nothing', output: { kind: 'int' }, policies: ['ops'] }
	}
};
const cronGuest = program(`import { Effect } from 'effect';
export default { automation: {
	ingest: { body: function* (input, ctx) {
		yield* ctx.convert.ingest({ id: '0199a000-0000-7000-8000-0000000000aa', name: 'a.pdf', mime: 'application/pdf' }, { for: 'ingest' })
			.pipe(Effect.catch(() => Effect.succeed(null)));
	} },
	idle: { body: function* () { return 0; } }
} };`);

describe('bug 28: an ingest that stores is an effect', () => {
	it.live('a cron whose only crossing is a storing convert.ingest records its slot', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({ manifest: cron, guest: yield* cronGuest, now: '2026-09-25T10:15:02.000Z' })
				);
				const t = Context.get(context, TestWorkspace);
				expect(yield* Context.get(context, Runs).fire('ingest', '2026-09-25T10:15:00.000Z')).toEqual({ ran: true });
				const [runs] = yield* t.db.read([{ text: `SELECT automation FROM sys_run`, params: [] }]);
				expect(runs?.rows).toEqual([{ automation: 'ingest' }]);
			})
		)
	);
});

describe('bug 35: the stopping set is cleared on every exit', () => {
	it.live('a run that returns before settling leaves no stop mark behind', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: cron, guest: yield* cronGuest }));
				const id = randomUUID(),
					stopping = new Set([id]);
				const executed = Effect.gen(function* () {
					const { prune } = yield* makePruner();
					const { execute } = yield* makeRunExecutor(makeParking(), new Map(), stopping, prune);
					const row: Row = {
						id,
						automation: 'idle',
						input: {},
						due_at: NOW,
						run_key: null,
						cause: 'cron',
						depth: 0,
						attempts: 1,
						leases: 0,
						actor: null,
						starter: null,
						trigger: { kind: 'system', cause: 'cron' }
					};
					// an idle cron slot: nothing written, so the executor returns before it settles the run
					return yield* execute([row], { record: Effect.succeed(false), written: () => false });
				});
				yield* executed.pipe(Effect.provide(context));
				expect(stopping.has(id)).toBe(false);
			})
		)
	);
});

const sheet: EngineManifest = {
	...empty,
	models: { documents: { description: 'Documents', record_label: 'record.code', fields: { code: { kind: 'text' } } } },
	exposures: {
		documents: {
			outputs: { default: { documents: { fields: 'all' } } },
			syncs: { sheet: { with: 'file', parser: ['csv'] } }
		}
	}
};

describe('bug 30: a refused export names the format asked for', () => {
	it.live('an export to a format the sync does not write says which', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: sheet }));
				const t = Context.get(context, TestWorkspace);
				const user = randomUUID();
				yield* t.db.write({ text: "INSERT INTO sys_user(id,name,kind,admin) VALUES ($1,'Ada','staff',true)", params: [user] });
				const handler = yield* Context.get(context, RunHandlers).handler('documents.sync.sheet');
				if (Option.isNone(handler)) return yield* Effect.die('missing file sync');
				const starter = {
					actor: {
						kind: 'member' as const,
						id: user,
						email: null,
						phone: null,
						external: false,
						teams: [],
						team_path: [],
						admin: true,
						party: null
					},
					policies: [],
					admin: true
				};
				const refused = yield* Effect.flip(handler.value({ mode: 'export', to: 'xlsx' }, { id: randomUUID(), starter }));
				expect(refused.message).toContain('does not write xlsx');
				expect(refused.message).not.toContain('undefined');
			})
		)
	);
});

describe('bug 38: a write row of the wrong shape is refused, not cast', () => {
	it.effect('update, delete and upsert rows that are null refuse as invalid input', () =>
		Effect.gen(function* () {
			const { db } = yield* open(written);
			let n = 0;
			const run = (verb: 'update' | 'delete' | 'upsert', input: Json) =>
				act_one(
					{ manifest: written, db },
					{
						model: 'orders',
						verb,
						input,
						...(verb === 'upsert' ? { on_conflict: 'update' as const } : {}),
						key: `null-row-${n}`,
						invocationId: `null-row-${n++}`,
						issuedAt: NOW,
						authority: admin,
						bindings: { now: NOW, today: TODAY, tz: 'UTC' }
					}
				);
			for (const verb of ['update', 'delete', 'upsert'] as const)
				expect([verb, (yield* run(verb, [null])).outcome]).toMatchObject([
					verb,
					{ kind: 'refused', code: 'invalid_input' }
				]);
		})
	);
});

describe('bug 45: seed chunks are measured in bytes', () => {
	it.effect('two rows under the budget in characters but over it in UTF-8 bytes take two steps', () =>
		Effect.gen(function* () {
			const notes: EngineManifest = {
				...empty,
				models: { notes: { description: 'A note', record_label: 'record.body', fields: { body: { kind: 'text' } } } },
				exposures: { notes: { outputs: { default: { notes: { fields: 'all' } } } } }
			};
			const { db } = yield* open(notes);
			// 300,000 two-byte characters each: 600 kB of text, 1.2 MB of UTF-8 together, over the 1 MiB chunk
			const wide = 'é'.repeat(300_000);
			const restore = yield* restorer(
				notes,
				db,
				restore_source({
					notes: [
						{ id: '0199a000-0000-7000-8000-0000000000b1', body: wide },
						{ id: '0199a000-0000-7000-8000-0000000000b2', body: wide }
					]
				}),
				NOW
			);
			let steps = 0;
			while (yield* restore.step) steps++;
			expect(steps).toBe(2);
			expect(restore.inserted()).toBe(2);
			expect(
				yield* db.rows(Schema.Struct({ n: Schema.Number }), { text: 'SELECT count(*)::int AS n FROM notes', params: [] })
			).toEqual([{ n: 2 }]);
		})
	);
});
