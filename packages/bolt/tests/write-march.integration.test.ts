// A payroll-shaped act: its callback reads every earlier period (large json rows), writes payslips with large json
// breakdowns and carries a ledger. A 0.25 CU compute ran such an act out of memory when the reads' re-digests, the
// writes and every row image aggregated as jsonb shared one statement: each re-digest is now a statement of its own,
// ahead of bounded write statements whose images aggregate as json text.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PARTS } from '../src/engine/runs/queue.ts';
import { manifest as base, NOW } from './write-fixture.ts';

const EARLIER = 300,
	SLIPS = 100,
	ENTRIES = 1_500;
/** A payslip's breakdown: some 4 KiB of lines. */
const breakdown = (n: number) => ({
	lines: Array.from({ length: 40 }, (_, i) => ({ code: `LINE_${i}`, amount: `${n}.${i}`, note: 'x'.repeat(60) }))
});
const manifest: EngineManifest = {
	...base,
	models: {
		earlier: {
			description: 'An earlier period',
			record_label: 'record.period',
			fields: { period: { kind: 'text' }, breakdown: { kind: 'json' } }
		},
		runs: { description: 'A run', record_label: 'record.period', fields: { period: { kind: 'text' } } },
		slips: {
			description: 'A payslip',
			record_label: 'record.period',
			fields: { period: { kind: 'text' }, breakdown: { kind: 'json' } }
		},
		entries: {
			description: 'A ledger entry',
			record_label: 'record.account',
			fields: { account: { kind: 'text' }, amount: { kind: 'int' } }
		}
	},
	relationships: {},
	exposures: {
		earlier: { outputs: { default: { earlier: { fields: 'all' } } } },
		runs: { outputs: { default: { runs: { fields: 'all' } } }, create: { columns: { runs: ['period'] }, transform: true } },
		slips: { outputs: { default: { slips: { fields: 'all' } } }, create: { columns: { slips: ['period', 'breakdown'] } } },
		entries: { outputs: { default: { entries: { fields: 'all' } } }, create: { columns: { entries: ['account', 'amount'] } } }
	},
	policies: {},
	apps: {},
	automations: {},
	integrations: {},
	teams: {},
	custom_fields: {},
	mcp: {},
	agent: { skills: {} }
};
const guest = program(`export default {
 model:{runs:{bodies:{
  create:function*(changes,ctx){
   const {earlier}=yield* ctx.query({earlier:{fields:['period','breakdown'],limit:10000}});
   const lines=earlier.rows[0].breakdown.lines;
   return {
    sets:changes.map(({set})=>set),
    with:{
     slips:{create:Array.from({length:${SLIPS}},(_,i)=>({period:'2026-03',breakdown:{carried:earlier.rows.length,lines:[...lines,...lines,...lines]}}))},
     entries:{create:Array.from({length:${ENTRIES}},(_,i)=>({account:'leave',amount:i}))}
    }
   };
  }
 }}}
};`);

/** An act map over this file's models, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;

describe('a March-shaped act', () => {
	it.live('re-digests its reads in statements of their own, then writes in bounded statements', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
				const batches: (readonly string[])[] = [];
				let move = false,
					reads = 0;
				const counted = TenantDb.typed({
					...db,
					read: (statements) =>
						Effect.gen(function* () {
							const rows = yield* db.read(statements);
							if (statements.some((s) => /FROM\s+"?earlier"?/i.test(s.text))) {
								reads++;
								// a write lands between the plan's read and its commit, once
								if (move) {
									move = false;
									yield* db.write({ text: "UPDATE earlier SET period = '2025-12', revision = revision + 1 WHERE period = '2025-01'", params: [] });
								}
							}
							return rows;
						}),
					transaction: (batch) =>
						Effect.suspend(() => {
							batches.push(batch.statements.map((s) => s.text));
							return db.transaction(batch);
						})
				});
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* guest,
						transforms: ['runs.create'],
						now: NOW,
						db: Layer.succeed(TenantDb, counted),
						seed: {
							earlier: Array.from({ length: EARLIER }, (_, i) => ({
								id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
								period: `2025-${String((i % 12) + 1).padStart(2, '0')}`,
								breakdown: breakdown(i)
							}))
						}
					})
				);
				const t = Context.get(context, TestWorkspace);
				const admin = yield* t.as(t.admin);
				const count = (table: string) => t.db.value(Schema.Number, { text: `SELECT count(*)::int FROM ${table}`, params: [] });
				const act = (period: string) => admin.act(untyped({ 'runs.create': [{ period }] }));

				batches.length = 0;
				const done = yield* act('2026-03');
				expect(done.records).toHaveLength(1 + SLIPS + ENTRIES);
				expect([yield* count('slips'), yield* count('entries')]).toEqual([SLIPS, ENTRIES]);
				const commit = batches.find((statements) => statements.some((text) => text.includes(PARTS)));
				if (commit === undefined) throw new Error('The act committed in one statement.');
				const digest = (text: string) => text.includes('md5(coalesce(string_agg');
				const first = commit.findIndex((text) => !digest(text));
				// the re-digests lead, each alone and writing nothing; no write statement digests a read
				expect(first).toBeGreaterThan(0);
				expect(commit.slice(0, first).every((text) => text.startsWith('SELECT bolt_assert') && !text.includes('INSERT'))).toBe(true);
				expect(commit.slice(first).some(digest)).toBe(false);
				// 1,601 rows, 1.2 MiB of them slips: bounded by rows and by bytes
				expect(commit.slice(first).filter((text) => text.startsWith('WITH')).length).toBeGreaterThanOrEqual(3);
				// no statement aggregates its row images as a jsonb tree
				expect(commit.some((text) => /jsonb_agg\(jsonb_build_object\('model', c, 'id', id, 'op'/.test(text))).toBe(false);

				// an earlier period moved after the plan read it: its own statement catches it, the act replans once
				move = true;
				reads = 0;
				yield* act('2026-04');
				expect(reads).toBe(2);
				expect(yield* count('slips')).toBe(2 * SLIPS);
			})
		)
	);
});
