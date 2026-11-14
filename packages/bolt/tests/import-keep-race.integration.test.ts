// Two `keep` imports of one key at once: the one whose insert loses the race replays, finds the row, and keeps it.
import { Context, Deferred, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import { manifest as base, NOW } from './write-fixture.ts';

/** An act map over this file's model, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;

const manifest: EngineManifest = {
	...base,
	models: {
		customers: {
			description: 'Customers',
			record_label: 'record.name',
			key: ['name'],
			unique: [{ fields: ['name'], name: 'customers_name_key', import_key: true }],
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		customers: {
			outputs: { default: { customers: { fields: 'all' } } },
			create: { columns: { customers: ['name', 'note'] } },
			update: { columns: { customers: ['name', 'note'] } }
		}
	}
};

describe('a keep import', () => {
	it.live('keeps the row a concurrent import of its key created first', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
				// both imports plan before either commits: the first two inserts wait for each other
				const both = yield* Deferred.make<void>();
				let arrived = 0;
				const raced = TenantDb.typed({
					...db,
					transaction: (batch) =>
						Effect.gen(function* () {
							if (batch.statements.some((s) => s.text.includes('INSERT INTO "customers"')) && arrived < 2) {
								if (++arrived === 2) yield* Deferred.succeed(both, undefined);
								yield* Deferred.await(both);
							}
							return yield* db.transaction(batch);
						})
				});
				const context = yield* Layer.build(
					TestWorkspace.layer({ manifest, now: NOW, db: Layer.succeed(TenantDb, raced) })
				);
				const t = Context.get(context, TestWorkspace);
				const admin = yield* t.as(t.admin);
				const keep = (note: string) =>
					admin.act(untyped({ 'customers.import': { rows: [{ name: 'Same', note }], on_conflict: 'keep' } }));
				const [a, b] = yield* Effect.all([keep('first'), keep('second')], { concurrency: 'unbounded' });
				expect(arrived).toBe(2);
				expect([a.kind, b.kind]).toEqual(['committed', 'committed']);
				expect(
					yield* t.db.value(Schema.Number, {
						text: "SELECT count(*)::int FROM customers WHERE name = 'Same'",
						params: []
					})
				).toBe(1);
			})
		)
	);
});
