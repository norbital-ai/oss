import { Context, Effect, Layer } from 'effect';
// Rule 25a on PGlite: a prune pass that selects rows and deletes none stops `no_progress` and queues nothing.
import { describe, expect, it } from '@effect/vitest';
import { TestWorkspace, type Kit } from '../../bolt-cli/src/test/index.ts';
import { manifest } from './catalogue-fixture.ts';

const NOW = '2026-09-25T10:00:00.000Z';
const OLD = '2026-09-20T10:00:00.000Z';
const sql = (t: Pick<Kit, 'db'>, text: string) =>
	t.db.read([{ text, params: [] }]).pipe(
		Effect.map(([result]) => {
			if (result === undefined) throw new Error('Missing SQL result');
			return result.rows;
		})
	);
/** Rate windows older than a day are what the prune deletes. */
const aged = (n: number) =>
	`INSERT INTO bolt_rate SELECT 'act', 'k' || n, '${OLD}', 1 FROM generate_series(1, ${n}) n`;

describe('engine loops', () => {
	it.live(
		'a prune pass that deletes none of the rows it selected stops no_progress and queues nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const t = Context.get(
						yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW })),
						TestWorkspace
					);
					yield* t.db.write({ text: aged(1), params: [] });
					yield* t.db.write({
						text: `CREATE FUNCTION keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
						params: []
					});
					yield* t.db.write({
						text: `CREATE TRIGGER keep BEFORE DELETE ON bolt_rate FOR EACH ROW EXECUTE FUNCTION keep()`,
						params: []
					});
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('p', 'bolt.prune', '{}', '${NOW}', 'continue', 0)`,
						params: []
					});
					yield* t.run_due();
					expect(
						yield* sql(
							t,
							`SELECT state, error->>'code' AS code FROM sys_run WHERE automation = 'bolt.prune'`
						)
					).toEqual([{ state: 'failed', code: 'no_progress' }]);
					expect(t.fakes.logs.filter((r) => r.event === 'prune.no_progress')).toHaveLength(1); // the daily pass, inline
				})
			)
	);
	it.live(
		'the daily pass prunes a consumed inbox delivery past its month, and nothing unread',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const t = Context.get(
						yield* Layer.build(
							TestWorkspace.layer({
								manifest,
								seed: { sys_integration: [{ id: 'desk', integration: 'whatsapp', name: 'Desk', active: true, configuration: {} }] },
								now: NOW
							})
						),
						TestWorkspace
					);
					const delivery = (name: string, consumed: string | null) =>
						t.db.write({
							text: `INSERT INTO sys_inbox (id, sync, instance, delivery, received_at, consumed_at) VALUES (gen_random_uuid(), 's', 'desk', $1, '2026-01-01T00:00:00.000Z', $2::timestamptz)`,
							params: [name, consumed]
						});
					yield* delivery('old', '2026-02-01T00:00:00.000Z');
					yield* delivery('recent', '2026-09-20T00:00:00.000Z');
					yield* delivery('unread', null);
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('p', 'bolt.prune', '{}', '${NOW}', 'continue', 0)`,
						params: []
					});
					yield* t.run_due();
					expect(yield* sql(t, 'SELECT delivery FROM sys_inbox ORDER BY delivery')).toEqual([
						{ delivery: 'recent' },
						{ delivery: 'unread' }
					]);
				})
			)
	);
	it.live('retention removes expired identity resources and settled outbox rows while preserving live work and references', () =>
		Effect.scoped(Effect.gen(function* () {
			const t = Context.get(yield* Layer.build(TestWorkspace.layer({
				manifest: {
					...manifest,
					relationships: {
						...manifest.relationships,
						'products.invitation': { to: 'sys_invitation', optional: true },
						'products.subject': { to: ['sys_invitation', 'sys_user'], optional: true, on_delete: 'cascade' }
					}
				},
				seed: { sys_integration: [{ id: 'desk', integration: 'whatsapp', name: 'Desk', active: true, configuration: {} }] },
				now: NOW
			})), TestWorkspace);
			for (const text of [
				`INSERT INTO sys_user (id, name, kind) VALUES ('keeper', 'Keeper', 'staff'), ('anonymous-retained', 'Anonymous', 'anonymous')`,
				`INSERT INTO sys_session (id, token_hash, "user", via, created_at, refreshed_at, expires_at)
				SELECT name, name, 'keeper', 'code', '2026-01-01', '2026-01-01', expiry::timestamptz
				FROM (VALUES ('expired', '2026-09-20'), ('live', '2026-10-01')) v(name, expiry)`,
				`INSERT INTO sys_challenge (address_mac, code_mac, expires_at)
				SELECT name, 'code', expiry::timestamptz
				FROM (VALUES ('expired', '2026-09-20'), ('live', '2026-10-01')) v(name, expiry)`,
				`INSERT INTO sys_invitation (id, email, expires_at, accepted_at, revoked_at)
				SELECT name, name || '@example.test', expiry::timestamptz, accepted::timestamptz, revoked::timestamptz
				FROM (VALUES
					('expired_old', '2026-01-01', null, null),
					('expired_recent', '2026-09-20', null, null),
					('open', '2026-10-01', null, null),
					('accepted_old', '2026-01-01', '2026-02-01', null),
					('accepted_recent', '2026-01-01', '2026-09-20', null),
					('revoked_old', '2026-01-01', null, '2026-02-01'),
					('revoked_recent', '2026-01-01', null, '2026-09-20'),
					('poly_referenced', '2026-01-01', null, null),
					('referenced', '2026-01-01', null, null)
				) v(name, expiry, accepted, revoked)`,
				`INSERT INTO products (id, external_code, name, invitation)
				VALUES (gen_random_uuid(), 'retained', 'Retained', 'referenced')`,
				`INSERT INTO products (id, external_code, name, subject__sys_invitation, subject__sys_user)
				VALUES (gen_random_uuid(), 'poly_invite', 'Invitation reference', 'poly_referenced', null),
				(gen_random_uuid(), 'poly_user', 'User reference', null, 'anonymous-retained')`,
				`INSERT INTO sys_outbox (id, sync, instance, model, record, op, record_revision, key, status, next_attempt_at, at, acked_at, claimed_at)
				SELECT gen_random_uuid(), 'products.sync.erp', 'desk', 'products', name, 'update', 1, name, status, '2026-10-01', '2026-01-01', acked::timestamptz, claimed::timestamptz
				FROM (VALUES
					('old_acked', 'acked', '2026-01-02', null),
					('old_failed', 'failed', null, null),
					('old_skipped', 'skipped', null, null),
					('recent_acked', 'acked', '2026-09-20', null),
					('recent_claim', 'failed', null, '2026-09-20'),
					('dead', 'dead', null, null),
					('queued', 'queued', null, null),
					('sending', 'sending', null, '2026-01-02')
				) v(name, status, acked, claimed)`
			]) yield* t.db.write({ text, params: [] });
			yield* t.run_due();
			expect(yield* sql(t, 'SELECT id FROM sys_session ORDER BY id')).toEqual([{ id: 'live' }]);
			expect(yield* sql(t, 'SELECT address_mac FROM sys_challenge ORDER BY address_mac')).toEqual([{ address_mac: 'live' }]);
			expect(yield* sql(t, 'SELECT id FROM sys_invitation ORDER BY id')).toEqual([
				{ id: 'accepted_recent' }, { id: 'expired_recent' }, { id: 'open' }, { id: 'poly_referenced' }, { id: 'referenced' }, { id: 'revoked_recent' }
			]);
			expect(yield* sql(t, `SELECT id FROM sys_user WHERE id = 'anonymous-retained'`)).toEqual([{ id: 'anonymous-retained' }]);
			expect(yield* sql(t, 'SELECT external_code FROM products ORDER BY external_code')).toEqual([
				{ external_code: 'poly_invite' }, { external_code: 'poly_user' }, { external_code: 'retained' }
			]);
			expect(yield* sql(t, 'SELECT key FROM sys_outbox ORDER BY key')).toEqual([
				{ key: 'dead' }, { key: 'queued' }, { key: 'recent_acked' }, { key: 'recent_claim' }, { key: 'sending' }
			]);
		})));
});
