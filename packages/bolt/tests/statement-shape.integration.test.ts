// A write's statement text is its shape: the values it carries, its rows and the reads its transform made (which the
// commit re-checks under its lock) travel as parameters, so every act of one shape sends the same text and the
// database parses and plans it once per session. Shaped like a payroll run: a transform reads a wide-jsonb catalogue
// row and creates the run with a 40-row child batch.
import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Writes } from '../src/engine/services.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import { admin, manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		catalog: {
			description: 'A wide catalogue row',
			record_label: 'record.code',
			fields: { code: { kind: 'text' }, lookup: { kind: 'json' } }
		},
		runs: {
			description: 'A run',
			record_label: 'record.period',
			fields: { period: { kind: 'text' } }
		},
		entries: {
			description: 'A run entry',
			record_label: 'record.code',
			fields: { code: { kind: 'text' }, amount: { kind: 'int' } }
		}
	},
	relationships: { 'entries.run': { to: 'runs', inverse: 'entries', owned: true } },
	exposures: {
		catalog: { outputs: { default: { catalog: { fields: 'all' } } } },
		runs: {
			outputs: { default: { runs: { fields: 'all' } } },
			create: { columns: { runs: ['period'], 'runs.entries': ['code', 'amount'] }, transform: true }
		}
	},
	policies: {},
	teams: {}
};
const guest =
	program(`export default { model: { runs: { bodies: { create: function* (changes, ctx) {
	const sets = [];
	for (const { set } of changes) {
		const { catalog } = yield* ctx.query({ catalog: { where: { code: { eq: set.period } } } });
		const rates = catalog.rows[0].lookup.rates;
		sets.push({ ...set, entries: rates.map((rate, i) => ({ code: set.period + ':' + i, amount: rate })) });
	}
	return sets;
} } } } };`);

const periods = ['2026-01', '2026-02', '2026-03'];
const lookup = (seed: number) => ({
	rates: Array.from({ length: 40 }, (_, i) => seed * 100 + i),
	bands: Array.from({ length: 200 }, (_, i) => ({
		from: i * 1000,
		to: i * 1000 + 999,
		rate: i / 1000
	}))
});

it.live(
	'every act of one shape sends the same statement text, its values and read checks as parameters',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
				const texts: string[] = [];
				const recorded = TenantDb.typed({
					read: db.read,
					write: (statement, lock) => {
						texts.push(statement.text);
						return db.write(statement, lock);
					},
					transaction: (batch) => {
						for (const statement of batch.statements) texts.push(statement.text);
						return db.transaction(batch);
					}
				});
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* guest,
						transforms: ['runs.create'],
						db: Layer.succeed(TenantDb, recorded),
						seed: {
							catalog: periods.map((code, i) => ({ id: randomUUID(), code, lookup: lookup(i + 1) }))
						}
					})
				);
				const t = Context.get(context, TestWorkspace),
					writes = Context.get(context, Writes);
				const commits: string[] = [];
				for (const period of periods) {
					texts.length = 0;
					const key = randomUUID(),
						now = t.clock.now();
					const { outcome } = yield* writes.act({
						model: 'runs',
						verb: 'create',
						input: [{ period }],
						authority: admin,
						key,
						issuedAt: now,
						invocationId: key,
						mode: { _tag: 'Direct' },
						bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
					});
					expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'committed' });
					const commit = texts.find((text) => text.includes('bolt_idem'));
					if (commit === undefined) throw new Error('no commit statement');
					// the transform's read is re-checked in the commit, by parameter
					expect(commit).toContain('"catalog"');
					expect(commit).not.toContain(period);
					commits.push(commit);
				}
				// the first act acknowledges no earlier audit receipt; from the second on, one shape
				expect(new Set(commits.slice(1)).size).toBe(1);
				expect(
					yield* t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM entries',
						params: []
					})
				).toBe(40 * periods.length);
			})
		)
);

// A label naming a related record's fields several times reads each of them once: the planner never copies a related
// lookup into every place the label's operators name it (which grew the plan 12-fold per nested `+`).
const labelled: EngineManifest = {
	...base,
	models: {
		contract: {
			description: 'A contract',
			record_label: 'record.number',
			fields: { number: { kind: 'text' }, name: { kind: 'text' } }
		},
		entry: {
			description: 'An entry',
			record_label:
				"record.contract.name + ' · ' + record.contract.number + ' · ' + record.code + ' · ' + record.contract.name",
			fields: { code: { kind: 'text' } }
		}
	},
	relationships: { 'entry.contract': { to: 'contract' } },
	exposures: {
		contract: { outputs: { default: { contract: { fields: 'all' } } } },
		entry: {
			outputs: { default: { entry: { fields: 'all' }, 'entry.contract': { fields: 'all' } } }
		}
	},
	policies: {},
	teams: {}
};
const PlanNode: Schema.Codec<{
	readonly 'Relation Name'?: string;
	readonly Plans?: readonly PlanNodeType[];
}> = Schema.Struct({
	'Relation Name': Schema.optionalKey(Schema.String),
	Plans: Schema.optionalKey(
		Schema.Array(Schema.suspend((): Schema.Codec<PlanNodeType> => PlanNode))
	)
});
type PlanNodeType = { readonly 'Relation Name'?: string; readonly Plans?: readonly PlanNodeType[] };
const scans = (node: PlanNodeType, relation: string): number =>
	(node['Relation Name'] === relation ? 1 : 0) +
	(node.Plans ?? []).reduce((n, child) => n + scans(child, relation), 0);

it.live('a label reads each related field once, however often it names it', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const db = Context.get(yield* Layer.build(TestDb.layer(labelled)), TenantDb);
			const reads: { text: string; params: readonly Json[] }[] = [];
			const recorded = TenantDb.typed({
				read: (statements) => {
					reads.push(...statements);
					return db.read(statements);
				},
				write: db.write,
				transaction: db.transaction
			});
			const contract = randomUUID();
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest: labelled,
					db: Layer.succeed(TenantDb, recorded),
					seed: {
						contract: [{ id: contract, number: 'C-1', name: 'Ada' }],
						entry: [{ id: randomUUID(), code: 'E-1', contract }]
					}
				})
			);
			const t = Context.get(context, TestWorkspace);
			reads.length = 0;
			const { entry } = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					entry: Schema.Struct({ rows: Schema.Array(Schema.Struct({ $label: Schema.String })) })
				})
			)(yield* (yield* t.as(t.admin)).query(dynamic_read({ entry: {} })));
			expect(entry.rows.map((row) => row.$label)).toEqual(['Ada · C-1 · E-1 · Ada']);
			const read = reads.find((statement) => statement.text.includes('"entry"'));
			if (read === undefined) throw new Error('no entry read');
			const [plan] = yield* t.db.value(Schema.Array(Schema.Struct({ Plan: PlanNode })), {
				text: `EXPLAIN (FORMAT JSON) ${read.text}`,
				params: read.params
			});
			if (plan === undefined) throw new Error('no plan');
			// one lookup per related path, one existence check per relation, and the related layer's own read
			expect(scans(plan.Plan, 'contract')).toBeLessThanOrEqual(4);
		})
	)
);
