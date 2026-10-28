import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { SyncHealth } from '../src/engine/sync/health-schema.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';
import { json } from './support/route-fixture.ts';
import { manifest as base } from './write-fixture.ts';

const NOW = '2026-10-24T08:00:00.000Z';
const ORIGIN = 'https://workspace.test';
const OWN = '0199a000-0000-7000-8000-000000000001';
const OTHER = '0199a000-0000-7000-8000-000000000002';
const DEAD = '0199a000-0000-7000-8000-000000000011';
const SECOND_DEAD = '0199a000-0000-7000-8000-000000000012';
const QUEUED = '0199a000-0000-7000-8000-000000000013';
const FAILED = '0199a000-0000-7000-8000-000000000014';
const OTHER_DEAD = '0199a000-0000-7000-8000-000000000015';
const manifest: EngineManifest = {
	...base,
	models: {
		contacts: { description: 'A contact', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		contacts: {
			read: { contacts: { fields: 'all' } },
			syncs: { crm: { with: 'crm', read: true, write: true } }
		}
	},
	integrations: {
		crm: { description: 'CRM', driver: 'http', http: { baseUrl: 'https://crm.test' } }
	},
	policies: {
		self: {
			description: 'Manages their own integration instances',
			grants: {
				sys_integration: { read: true, update: { check: true } }
			}
		}
	},
	teams: { owners: ['self'] }
};
/** `self` may update an instance it owns: the update `check`, dry-run on the instance before health or replay. */
const guest = program(`export default { policy: { self: { grants: { sys_integration: { update: {
	check: function* (changes, ctx) { return changes.every(({ before }) => before.owner === ctx.actor.id) ? ctx.allow() : ctx.deny('Only your own instances.'); }
} } } } } };`);

const setup = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({ manifest, guest: yield* guest, now: NOW, host: { publicUrl: ORIGIN } })
	);
	const t = Context.get(context, TestWorkspace);
	const owner = t.member(['self'], { teams: ['owners'] });
	const other = t.member(['self'], { teams: ['owners'] });
	const cookie = yield* t.session(owner.id);
	yield* t.db.write({
		text: `INSERT INTO sys_integration (id, integration, name, owner)
			VALUES ($1, 'crm', 'Mine', $2), ($3, 'crm', 'Other', $4)`,
		params: [OWN, owner.id, OTHER, other.id]
	});
	for (const [id, instance, status] of [
		[DEAD, OWN, 'dead'],
		[SECOND_DEAD, OWN, 'dead'],
		[QUEUED, OWN, 'queued'],
		[FAILED, OWN, 'failed'],
		[OTHER_DEAD, OTHER, 'dead']
	] as const)
		yield* t.db.write({
			text: `INSERT INTO sys_outbox
				(id, sync, instance, model, record, op, record_revision, key, status, attempts, next_attempt_at, error, at)
				VALUES ($1::uuid, 'contacts.sync.crm', $2, 'contacts', $1::text, 'update', 1, $1::text, $3,
					CASE WHEN $3 = 'dead' THEN 8 ELSE 0 END, $4::timestamptz,
					'{"message":"Delivery unavailable"}'::jsonb, $4::timestamptz)`,
			params: [id, instance, status, NOW]
		});
	return {
		t,
		health: (instance: string) =>
			t.handle(
				new Request(`${ORIGIN}/__bolt/shell/instance-sync-health?instance=${instance}`, {
					headers: { cookie }
				})
			),
		replay: (body: Json) =>
			t.handle(
				new Request(`${ORIGIN}/__bolt/shell/instance-sync-replay`, {
					method: 'POST',
					headers: { cookie, 'content-type': 'application/json' },
					body: JSON.stringify(body)
				})
			),
		outbox: () =>
			t.db.rows(
				Schema.Struct({
					id: Schema.String,
					status: Schema.String,
					attempts: Schema.Number,
					error: Schema.NullOr(Schema.Json)
				}),
				{ text: 'SELECT id::text, status, attempts, error FROM sys_outbox ORDER BY id', params: [] }
			)
	};
});

describe('shell integration sync health and replay', () => {
	it.live(
		'reads only an integration instance the caller may update and refuses unknown instances',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup;
					const response = yield* f.health(OWN);
					expect(response.status).toBe(200);
					expect(
						yield* Schema.decodeUnknownEffect(Schema.Struct({ value: SyncHealth }))(
							yield* json(response)
						)
					).toEqual({
						value: {
							pending: 1,
							dead: 2,
							failed: 1,
							last_read_at: null,
							last_change_at: null,
							last_hint_at: null,
							lag_seconds: null,
							webhooks_quiet: false
						}
					});
					for (const response of [yield* f.health(OTHER), yield* f.replay({ instance: OTHER })]) {
						expect(response.status).toBe(403);
						expect(yield* json(response)).toMatchObject({ error: { code: 'forbidden' } });
					}
					for (const response of [
						yield* f.health('missing'),
						yield* f.replay({ instance: 'missing' })
					]) {
						expect(response.status).toBe(404);
						expect(yield* json(response)).toMatchObject({ error: { code: 'notFound' } });
					}
				})
			)
	);

	it.live(
		'validates replay ids and replays only the chosen dead writes of the admitted instance',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup;
					const before = yield* f.outbox();
					for (const ids of ['bad', null, [0], [''], [null]]) {
						const response = yield* f.replay({ instance: OWN, ids });
						expect(response.status).toBe(400);
						expect(yield* json(response)).toMatchObject({ error: { code: 'invalid' } });
					}
					expect(yield* f.outbox()).toEqual(before);
					const selected = yield* f.replay({ instance: OWN, ids: [DEAD, QUEUED, OTHER_DEAD] });
					expect(selected.status).toBe(200);
					expect(yield* json(selected)).toEqual({ value: { replayed: 1 } });
					expect(yield* f.outbox()).toEqual(
						before.map((row) =>
							row.id === DEAD ? { ...row, status: 'sending', attempts: 0, error: null } : row
						)
					);
					const remaining = yield* f.replay({ instance: OWN });
					expect(remaining.status).toBe(200);
					expect(yield* json(remaining)).toEqual({ value: { replayed: 1 } });
					expect(yield* json(yield* f.replay({ instance: OWN }))).toEqual({
						value: { replayed: 0 }
					});
					expect((yield* f.outbox()).find((row) => row.id === OTHER_DEAD)).toEqual(
						before.find((row) => row.id === OTHER_DEAD)
					);
				})
			)
	);
});
