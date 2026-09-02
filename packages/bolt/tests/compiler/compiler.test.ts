import { describe, expect, it } from 'vitest';
import { custom, defineModel, text } from '../../src/authoring/index.js';
import { app, collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import { describeModel } from '../../src/authoring/model-introspection.js';
import { discoverWorkspace } from '../../src/compiler/compiler.js';
import { buildSchemaPlan, fingerprintSchemaSteps } from '../../src/runtime/schema/schema-plan.js';

const fixture = workspace({
	name: 'fixture',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [app({ name: 'people', label: 'People' })],
	policies: [],
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: ['database']
});

/**
 * `jurisdictions` as hr-payroll actually declares it — one searchable column, one that is not, and the
 * effective-dating exclusion — built through the real path, so what the plan reads is what
 * `text({ search: true })` and `defineModel` metadata genuinely leave behind.
 */
const effectiveDated = workspace({
	name: 'effective-dated',
	version: '1',
	collections: [
		collection({
			name: 'jurisdictions',
			fields: describeModel(
				defineModel({
					code: text().notNull(),
					name: text({ search: true }).notNull(),
					effective_range: custom('instant_range').notNull()
				})
			),
			exclusions: [
				{
					name: 'jurisdictions_code_effective_range_no_overlap',
					elements: [
						{ expr: 'code', with: '=' },
						{ expr: 'bolt_daterange(effective_range)', with: '&&' }
					]
				}
			]
		})
	],
	apps: [],
	policies: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	requiredFacilities: ['database']
});

describe('Bolt compiler owners', () => {
	it('rejects missing and duplicate workspace roots', () => {
		expect(discoverWorkspace([])).toMatchObject({
			_tag: 'Bolt.Compiler.DiscoveryError',
			message: 'No Bolt workspace declaration was found'
		});
		expect(discoverWorkspace([fixture, fixture])).toMatchObject({
			_tag: 'Bolt.Compiler.DiscoveryError',
			message: 'Multiple Bolt workspace declarations were found'
		});
	});

	it('emits a deterministic, quoted schema plan', () => {
		const first = buildSchemaPlan(fixture);
		const second = buildSchemaPlan(fixture);
		expect(first).toEqual(second);
		// `people` is authored, so the drizzle lineage renders its table and the plan renders nothing.
		expect(first.steps.map(({ id }) => id)).not.toContain('collection:people');
		// Live sync has no durable outbox table; prefix wakes come from in-process SyncChange facts.
		expect(first.steps.map(({ id }) => id)).not.toContain('collection:bolt_sync_outbox');
		expect(first.steps.map(({ id }) => id)).toContain('collection:bolt_collection_history');
		expect(first.steps.find(({ id }) => id === 'collection:approval_request')?.sql).toContain(
			'"approval_request"'
		);
		// `bolt_sync_horizon` is retired: the changelog's truncation backstop replaced the compaction mark.
		expect(first.steps.map(({ id }) => id)).not.toContain('collection:bolt_sync_horizon');
		expect(first.steps.map(({ id }) => id).some((id) => id.startsWith('bolt:drop-'))).toBe(false);
		expect(first.steps.map(({ id }) => id).some((id) => id.includes(':zz-'))).toBe(false);
		expect(first.steps.map(({ id }) => id).some((id) => id.includes(':column:'))).toBe(false);
		for (const collection of [
			'agent_task',
			'agent_plan',
			'agent_message',
			'agent_inbox',
			'agent_run',
			'agent_usage'
		]) {
			expect(first.steps.map(({ id }) => id)).toContain(`collection:${collection}`);
		}
		expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('fingerprints the exact provisioning lineage as well as its identifiers', () => {
		const original = [{ id: 'lineage:baseline:0', sql: 'create table example (id uuid)' }];
		const changed = [{ id: 'lineage:baseline:0', sql: 'create table example (id text)' }];
		expect(fingerprintSchemaSteps(original)).not.toBe(fingerprintSchemaSteps(changed));
	});

	it('installs its extensions before anything that needs them', () => {
		const ids = buildSchemaPlan(fixture).steps.map(({ id }) => id);
		expect(ids.filter((id) => id.startsWith('bolt:extension-'))).toEqual([
			'bolt:extension-btree-gist',
			'bolt:extension-pg-trgm',
			// Unconditional like the other two: the plan runs before the lineage that creates the
			// columns, so it cannot ask the workspace whether it embeds anything.
			'bolt:extension-vector'
		]);
		// Steps execute in id order, so asserting the ordering is the half that actually holds — an
		// index or constraint created before its extension fails outright. Every `bolt:` id sorts before
		// every `collection:` id, and the lineage runs after the whole foundation.
		expect(ids.indexOf('bolt:extension-pg-trgm')).toBeLessThan(
			ids.indexOf('collection:approval_request')
		);
	});

	it('provisions a retryable assertion for optimistic snapshot guards', () => {
		const assertion = buildSchemaPlan(fixture).steps.find(
			({ id }) => id === 'bolt:function-assert'
		);

		expect(assertion?.sql).toContain('function bolt_assert(ok boolean, message text) returns void');
		expect(assertion?.sql).toContain("errcode = '40001'");
		expect(assertion?.sql).toContain('if ok is not true');
	});

	it('gives every collection the system columns the migration lineage defines', () => {
		// Read off a system collection: those are the only tables the plan still renders, and they carry
		// the same system columns an authored collection gets from the lineage.
		const sql = buildSchemaPlan(fixture).steps.find(
			({ id }) => id === 'collection:approval_request'
		)?.sql;
		// Bolt used to invent `id text primary key` with `id` generated from it, so its
		// runtime inserted into a column deployed tables do not have and could not write to a real
		// workspace at all. Local development provisions from this plan, so nothing ever failed.
		expect(sql).toContain('"id" uuid primary key default gen_random_uuid()');
		expect(sql).toMatch(/"sys_period" tstzrange default .* not null/);
		expect(sql).not.toContain('id text primary key');
	});

	it('renders the clean system-table baseline without additive compatibility steps', () => {
		const plan = buildSchemaPlan(fixture);
		const table = plan.steps.find(({ id }) => id === 'collection:bolt_collection_history')?.sql;

		expect(table).toContain('"effect_id" text');
		expect(table).not.toContain('"effect_id" text not null');
		expect(plan.steps.some(({ id }) => id.startsWith('collection:bolt_collection_history:column:')))
			.toBe(false);
	});

	/**
	 * Free-text search compiles to `ilike '%term%'`, which no btree index can answer, so every search
	 * was a sequential scan. The opt-in was recorded on the builder and then read by nobody that emits
	 * DDL, so not one tenant table ever got a trigram index.
	 */
	it('leaves an authored collection trigram index entirely to the lineage', () => {
		const steps = buildSchemaPlan(effectiveDated).steps;

		// The opt-in still decides the index; the lineage is now what renders it, and
		// `tests/authoring/searchable-fields.test.ts` pins that it indexes exactly the opted-in columns.
		expect(steps.map(({ id }) => id)).not.toContain('collection:jurisdictions:search:name');
		expect(steps.map(({ id }) => id)).not.toContain('collection:jurisdictions:search:code');
		expect(
			steps.filter(({ sql }) => sql.includes('gin_trgm_ops') && sql.includes('on "jurisdictions"'))
		).toHaveLength(0);
	});

	/**
	 * `metadata.exclusions` reached no database at all, so the tables held exactly the overlapping
	 * effective-dated rows every payroll calculation assumes cannot exist. Drizzle has no entity for an
	 * EXCLUDE, so the plan is the only thing that can render one.
	 */
	it('renders a declared exclusion as a guarded EXCLUDE USING gist', () => {
		const sql = buildSchemaPlan(effectiveDated).steps.find(
			({ id }) =>
				id === 'collection:jurisdictions:exclusion:jurisdictions_code_effective_range_no_overlap'
		)?.sql;

		expect(sql).toContain(
			'alter table "jurisdictions" add constraint "jurisdictions_code_effective_range_no_overlap" exclude using gist (code with =, bolt_daterange(effective_range) with &&)'
		);
		// The plan runs in full on every provision, and Postgres has no `add constraint if not exists`:
		// unguarded, each boot would rebuild a GiST index over the whole table under an exclusive lock.
		expect(sql).toContain(
			"select 1 from pg_constraint where conname = 'jurisdictions_code_effective_range_no_overlap'"
		);
	});

	/**
	 * Steps execute in id order, so ordering is the whole of the correctness here: `gin_trgm_ops` does
	 * not exist before `pg_trgm`, and an EXCLUDE mixing `=` with `&&` cannot be built before
	 * `btree_gist`. Both would fail outright, mid-transaction, on a fresh database.
	 */
	it('orders the exclusion after the extensions and projections it needs', () => {
		const ids = buildSchemaPlan(effectiveDated).steps.map(({ id }) => id);
		const exclusion = ids.indexOf(
			'collection:jurisdictions:exclusion:jurisdictions_code_effective_range_no_overlap'
		);

		expect(exclusion).toBeGreaterThan(ids.indexOf('bolt:extension-btree-gist'));
		// `bolt_daterange` is one of the exclusion's members, so its projection has to exist too.
		expect(exclusion).toBeGreaterThan(ids.indexOf('bolt:function-daterange'));
		// The table it alters comes from the lineage, which runs after the whole `bolt:` foundation and
		// before the plan's `collection:` supplements — the order `provisioningStatements` applies.
		expect(exclusion).toBeGreaterThan(ids.indexOf('bolt:function-instant'));
	});

	it('refuses an exclusion whose name is not an identifier it can inline', () => {
		expect(() =>
			buildSchemaPlan(
				workspace({
					...effectiveDated,
					collections: [
						collection({
							name: 'jurisdictions',
							fields: { code: field.string({ required: true }) },
							exclusions: [
								{
									name: "x'; drop table jurisdictions; --",
									elements: [{ expr: 'code', with: '=' }]
								}
							]
						})
					]
				})
			)
		).toThrow(TypeError);
	});
});
