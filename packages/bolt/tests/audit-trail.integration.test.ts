import { randomUUID } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Audit, auditFromAbi } from '../src/engine/audit.ts';
import { recoverAudit } from '../src/engine/audit-operation.ts';
import { pruneHistory, readHistory } from '../src/engine/query/history.ts';
import { applyPlan, plan, readApplied } from '../src/engine/schema/plan.ts';
import { Writes } from '../src/engine/services.ts';
import { TestWorkspace, memoryAudit } from '../../bolt-cli/src/test/index.ts';
import type { AuditPort } from '../src/protocol/audit.ts';
import { layered, type EngineManifest } from '../src/engine/manifest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: { items: { description: 'Item', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {},
	exposures: {
		items: {
			read: { items: { fields: 'all' } },
			create: { columns: { items: ['title'] } },
			update: { columns: { items: ['title'] } }
		}
	}
};
const fixture = (port: AuditPort) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				ports: auditFromAbi(port).pipe(Layer.provide(NodeCrypto.layer))
			})
		);
		const t = Context.get(context, TestWorkspace),
			writes = Context.get(context, Writes);
		const act = (
			verb: 'create' | 'update' | 'erase',
			input: import('../src/decl/values.ts').Json
		) => {
			const now = t.clock.now(),
				key = randomUUID();
			return writes.act({
				model: 'items',
				verb,
				input,
				key,
				issuedAt: now,
				invocationId: key,
				authority: t.as(t.admin).authority,
				mode: { _tag: 'Direct' },
				bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
			});
		};
		return { t, context, act };
	});

it.live('durable preparation fails before a governed mutation can write', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const store = memoryAudit();
			const f = yield* fixture({
				...store.port,
				append: async () => {
					throw new Error('audit offline');
				}
			});
			expect(yield* Effect.flip(f.act('create', [{ title: 'Must not exist' }]))).toMatchObject({
				code: 'unavailable'
			});
			expect(
				yield* f.t.db.value(Schema.Number, { text: 'SELECT count(*)::int FROM items', params: [] })
			).toBe(0);
			expect(store.records.size).toBe(0);
		})
	)
);

it.live('governed writes accept an explicitly buffered host audit facility', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const store = memoryAudit();
			const f = yield* fixture({ ...store.port, mode: 'buffered' });
			expect(yield* f.act('create', [{ title: 'Buffered receipt' }])).toMatchObject({
				outcome: { kind: 'committed' }
			});
			expect([...store.records.values()].some((record) => record.status === 'committed')).toBe(
				true
			);
		})
	)
);

it.live(
	'history erasure waits for complete external audit and recovers an append-before-ack crash window',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const store = memoryAudit();
				let blocked = true;
				let lookupOffline = false;
				let recordedAt: string | undefined;
				const f = yield* fixture({
					...store.port,
					detail: async (id, signal) => {
						if (lookupOffline) throw new Error('audit lookup offline');
						const event = await store.port.detail(id, signal);
						return event !== null && event.status === 'prepared' && recordedAt !== undefined
							? { ...event, recordedAt }
							: event;
					},
					append: async (events, signal) => {
						if (blocked && events.some((event) => event.status !== 'prepared'))
							throw new Error('terminal append offline');
						await store.port.append(events, signal);
					}
				});
				const created = yield* f.act('create', [{ title: 'Synthetic private title' }]);
				if (created.outcome.kind !== 'committed') throw new Error('Expected committed fixture');
				const row = created.outcome.records.find((record) => record.model === 'items');
				if (row === undefined) throw new Error('Missing committed item');
				expect(
					yield* f.act('erase', { target: row.id, set: { title: 'Sanitised' } })
				).toMatchObject({
					outcome: { kind: 'committed' }
				});
				expect(
					yield* f.t.db.value(Schema.String, {
						text: 'SELECT title FROM items WHERE id=$1',
						params: [row.id]
					})
				).toBe('Sanitised');
				const now = f.t.clock.now(),
					bindings = { now, today: now.slice(0, 10), tz: 'UTC' };
				const prior = yield* readHistory(
					f.t.db,
					manifest,
					{
						kind: 'history',
						model: 'items',
						id: row.id,
						at: { _tag: 'Revision', revision: 1 },
						full: true
					},
					{ as: 'workspace' },
					bindings
				);
				expect(JSON.stringify(prior)).not.toContain('Synthetic private title');
				expect(
					yield* readHistory(
						f.t.db,
						manifest,
						{
							kind: 'history',
							model: 'items',
							id: row.id,
							full: true
						},
						{ as: 'workspace' },
						bindings
					)
				).toMatchObject({ id: row.id, revision: 2, title: 'Sanitised' });
				yield* pruneHistory(f.t.db, 1);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_history WHERE collection=$1 AND record=$2::uuid',
						params: ['items', row.id]
					})
				).toBe(2);
				const recover = recoverAudit(f.t.db).pipe(
					Effect.provideService(Audit, Context.get(f.context, Audit))
				);
				blocked = false;
				yield* recover;
				const Change = Schema.Struct({
					change: Schema.Struct({
						old: Schema.NullOr(Schema.Struct({ title: Schema.String })),
						new: Schema.NullOr(Schema.Struct({ title: Schema.String }))
					})
				});
				const change = (revision: number) => {
					const event = [...store.records.values()].find(
						(event) => event.subject?.id === row.id && event.subject.revision === revision
					);
					if (event === undefined) throw new Error('Missing complete external row event');
					return Schema.decodeUnknownSync(Change)(event.payload).change;
				};
				expect(change(2)).toEqual({
					old: { title: 'Synthetic private title' },
					new: { title: 'Sanitised' }
				});
				expect(
					yield* f.t.db.value(Schema.Boolean, {
						text: "SELECT EXISTS (SELECT 1 FROM bolt_history WHERE changes->>'title'=$1)",
						params: ['Synthetic private title']
					})
				).toBe(false);
				expect(
					yield* f.act('update', [{ target: row.id, set: { title: 'Later title' } }])
				).toMatchObject({ outcome: { kind: 'committed' } });
				expect(change(3)).toEqual({ old: { title: 'Sanitised' }, new: { title: 'Later title' } });
				// The append is durable, but the process loses its local acknowledgement before physical purge.
				yield* f.t.db.transaction({
					statements: [
						{
							text: "CREATE FUNCTION audit_ack_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ack offline'; END; $$",
							params: []
						},
						{
							text: 'CREATE TRIGGER audit_ack_outage BEFORE UPDATE ON bolt_audit_receipt FOR EACH ROW EXECUTE FUNCTION audit_ack_outage()',
							params: []
						}
					]
				});
				expect(yield* f.act('erase', { target: row.id })).toMatchObject({
					outcome: { kind: 'committed' }
				});
				expect(change(4)).toEqual({ old: { title: 'Later title' }, new: null });
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_audit_erase',
						params: []
					})
				).toBe(1);
				expect(
					yield* readHistory(
						f.t.db,
						manifest,
						{
							kind: 'history',
							model: 'items',
							id: row.id,
							full: true
						},
						{ as: 'workspace' },
						bindings
					)
				).toBeNull();
				yield* f.t.db.transaction({
					statements: [
						{ text: 'DROP TRIGGER audit_ack_outage ON bolt_audit_receipt', params: [] },
						{ text: 'DROP FUNCTION audit_ack_outage()', params: [] }
					]
				});
				const before = [...store.records.values()];
				yield* recover;
				expect([...store.records.values()]).toEqual(before);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_audit_erase',
						params: []
					})
				).toBe(0);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: "SELECT count(*)::int FROM bolt_history WHERE collection=$1 AND record=$2::uuid AND cause='erased'",
						params: ['items', row.id]
					})
				).toBe(1);
				// Expiry is separate from acknowledgement and requires a healthy host, even after the native deadline.
				blocked = true;
				recordedAt = '2000-01-01T00:00:00.123456Z';
				const expiring = yield* f.act('create', [{ title: 'Private expiry fixture' }]);
				if (expiring.outcome.kind !== 'committed')
					throw new Error('Expected expiring fixture commit');
				const expiringRow = expiring.outcome.records.find((entry) => entry.model === 'items');
				if (expiringRow === undefined) throw new Error('Missing expiring fixture');
				yield* f.act('erase', { target: expiringRow.id });
				const operations = yield* f.t.db.rows(Schema.Struct({ operation: Schema.String }), {
					text: 'SELECT operation FROM bolt_history WHERE collection=$1 AND record=$2::uuid ORDER BY revision',
					params: ['items', expiringRow.id]
				});
				expect(operations).toHaveLength(2);
				const legacy = operations[0];
				if (legacy === undefined) throw new Error('Missing legacy receipt fixture');
				const ids = operations.map((entry) => entry.operation);
				expect(
					yield* f.t.db.value(Schema.String, {
						text: `SELECT to_char(min(expires_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM bolt_audit_receipt WHERE operation IN (SELECT jsonb_array_elements_text($1::jsonb))`,
						params: [JSON.stringify(ids)]
					})
				).toBe('2000-01-31T00:00:00.123456Z');
				yield* f.t.db.write({
					text: 'UPDATE bolt_audit_receipt SET expires_at=NULL WHERE operation=$1',
					params: [legacy.operation]
				});
				const grace = () =>
					f.t.db.value(Schema.String, {
						text: 'SELECT expires_at::text FROM bolt_audit_retention WHERE one',
						params: []
					});
				const epoch = yield* grace();
				yield* applyPlan(f.t.db, yield* plan(yield* readApplied(f.t.db), layered(manifest)));
				expect(yield* grace()).toBe(epoch);
				lookupOffline = true;
				for (const operation of ids) store.records.delete(`${operation}:prepared`);
				const expiredEvents = [...store.records.values()];
				expect(yield* Effect.flip(recover)).toMatchObject({ code: 'unavailable' });
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_audit_receipt WHERE operation IN (SELECT jsonb_array_elements_text($1::jsonb)) AND expired_at IS NOT NULL',
						params: [JSON.stringify(ids)]
					})
				).toBe(0);
				lookupOffline = false;
				expect(yield* recover).toBe(true);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_audit_erase',
						params: []
					})
				).toBe(1);
				yield* f.t.db.write({
					text: "UPDATE bolt_audit_retention SET expires_at=clock_timestamp()-interval '1 second' WHERE one",
					params: []
				});
				expect(yield* recover).toBe(false);
				expect([...store.records.values()]).toEqual(expiredEvents);
				expect(
					yield* f.t.db.rows(
						Schema.Struct({ acknowledged: Schema.Boolean, expired: Schema.Boolean }),
						{
							text: 'SELECT acknowledged_at IS NOT NULL AS acknowledged,expired_at IS NOT NULL AS expired FROM bolt_audit_receipt WHERE operation IN (SELECT jsonb_array_elements_text($1::jsonb))',
							params: [JSON.stringify(ids)]
						}
					)
				).toEqual([
					{ acknowledged: false, expired: true },
					{ acknowledged: false, expired: true }
				]);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM bolt_audit_erase',
						params: []
					})
				).toBe(0);
				expect(
					yield* f.t.db.value(Schema.Boolean, {
						text: "SELECT EXISTS (SELECT 1 FROM bolt_history WHERE changes->>'title'='Private expiry fixture')",
						params: []
					})
				).toBe(false);
			})
		)
);

it.live('committed writes recover complete external payloads after terminal append failure', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const store = memoryAudit();
			let blocked = true;
			const f = yield* fixture({
				...store.port,
				append: async (events, signal) => {
					if (blocked && events.some((event) => event.status !== 'prepared'))
						throw new Error('terminal append offline');
					await store.port.append(events, signal);
				}
			});
			const original = 'full payload '.repeat(2000);
			const created = yield* f.act('create', [{ title: original }]);
			if (created.outcome.kind !== 'committed') throw new Error('Expected committed fixture');
			const row = created.outcome.records.find((record) => record.model === 'items');
			if (row === undefined) throw new Error('Missing committed item');
			expect([...store.records.values()].every((event) => event.status === 'prepared')).toBe(true);
			expect(
				yield* f.t.db.value(Schema.String, {
					text: 'SELECT title FROM items WHERE id=$1',
					params: [row.id]
				})
			).toBe(original);
			blocked = false;
			const recover = recoverAudit(f.t.db).pipe(
				Effect.provideService(Audit, Context.get(f.context, Audit))
			);
			yield* recover;
			const before = [...store.records.values()];
			expect(
				before.some((event) => event.id.endsWith(':terminal') && event.status === 'committed')
			).toBe(true);
			const full = before.find((event) => event.subject?.id === row.id);
			if (full === undefined) throw new Error('Missing recovered row event');
			if (f.t.admin.actor.kind !== 'member') throw new Error('Expected member actor');
			expect(full.actor.id).toBe(f.t.admin.actor.id);
			expect(full.payloadBytes).toBeGreaterThan(16 * 1024);
			expect(JSON.stringify(full.payload)).toContain(original);
			yield* recover;
			expect([...store.records.values()]).toEqual(before);
			expect(yield* f.act('update', [{ target: row.id, set: { title: 'Updated' } }])).toMatchObject(
				{
					outcome: { kind: 'committed' }
				}
			);
			const updated = [...store.records.values()].find(
				(event) => event.subject?.id === row.id && event.subject.revision === 2
			);
			if (updated === undefined) throw new Error('Missing update event');
			const image = Schema.decodeUnknownSync(
				Schema.Struct({
					change: Schema.Struct({
						old: Schema.Struct({ title: Schema.String, revision: Schema.Number }),
						new: Schema.Struct({ title: Schema.String, revision: Schema.Number })
					})
				})
			)(updated.payload);
			expect(image.change.old).toEqual({ title: original, revision: 1 });
			expect(image.change.new).toEqual({ title: 'Updated', revision: 2 });
		})
	)
);

it.live("a bulk write's request rides on its terminal event, not on each row event", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const store = memoryAudit();
			const f = yield* fixture(store.port);
			const has = (payload: unknown) =>
				typeof payload === 'object' && payload !== null && 'request' in payload;
			const rowEvents = () =>
				[...store.records.values()].filter((event) => event.id.includes(':row:'));
			expect(yield* f.act('create', [{ title: 'One' }])).toMatchObject({
				outcome: { kind: 'committed' }
			});
			expect(rowEvents().map((event) => has(event.payload))).toEqual([true]);
			store.records.clear();
			expect(
				yield* f.act('create', [{ title: 'A' }, { title: 'B' }, { title: 'C' }])
			).toMatchObject({ outcome: { kind: 'committed' } });
			expect(rowEvents().map((event) => has(event.payload))).toEqual([false, false, false]);
			const terminal = [...store.records.values()].find((event) => event.id.endsWith(':terminal'));
			expect(has(terminal?.payload)).toBe(true);
		})
	)
);
