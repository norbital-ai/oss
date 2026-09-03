import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { Result } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { uuid } from 'drizzle-orm/pg-core';
import { custom, defineModel, text } from '../src/authoring/models-schema.js';
import { describeModel } from '../src/authoring/model-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { provisioningStatements } from './support/bolt-test-layer.js';
import { compileCollectionPredicate } from '../src/runtime/access/effective-plan.js';

/** A stable UUID for a readable fixture name — records are keyed by `id uuid`. */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const databases: Array<PGlite> = [];

afterEach(async () => {
	await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('PostgreSQL schema and concurrency semantics', () => {
	it('executes the complete schema plan and exposes the expected catalog shape', async () => {
		// The schema plan installs extensions, and PGlite enables none by default — a bare instance
		// cannot execute the plan it is here to verify.
		const database = new PGlite({ extensions: { pg_trgm, btree_gist, vector } });
		databases.push(database);
		const definition = workspace({
			name: 'catalog-proof',
			version: '1',
			collections: [
				collection({
					name: 'people',
					fields: {
						name: field.string({ required: true }),
						active: field.boolean({ indexed: true })
					}
				})
			],
			apps: [],
			policies: [],
			automations: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		// The full provisioning sequence a database actually gets: plan foundation, then the drizzle
		// lineage that owns collection tables and indexes, then the plan's supplements.
		for (const step of await provisioningStatements(definition)) await database.exec(step.sql);
		const columns = await database.query<{ column_name: string; data_type: string }>(
			`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'people' order by ordinal_position`
		);
		expect(columns.rows).toContainEqual({ column_name: 'name', data_type: 'text' });
		expect(columns.rows).toContainEqual({ column_name: 'active', data_type: 'boolean' });
		const runtimeTables = await database.query<{ table_name: string }>(
			`select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'bolt_%' or table_name in ('session', 'user')) order by table_name`
		);
		expect(runtimeTables.rows.map(({ table_name }) => table_name)).toEqual(
			expect.arrayContaining([
				'bolt_approvals',
				'session',
				'user',
				'bolt_collection_history',
				'bolt_browser_mutation'
			])
		);
	});

	/**
	 * The two guarantees #44 and #46 are about, against a real Postgres rather than a string match:
	 * the trigram index exists and is used by the `ilike '%term%'` that free-text search compiles to,
	 * and the effective-dating EXCLUDE actually refuses the overlapping row the application assumes
	 * cannot exist. Both were unreachable until the plan installed `pg_trgm` and `btree_gist`.
	 */
	it('creates a usable trigram index and enforces the effective-dating exclusion', async () => {
		const database = new PGlite({ extensions: { pg_trgm, btree_gist, vector } });
		databases.push(database);
		const definition = workspace({
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
			automations: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		// The full provisioning sequence a database actually gets: plan foundation, then the drizzle
		// lineage that owns collection tables and indexes, then the plan's supplements.
		const provisioning = await provisioningStatements(definition);
		for (const step of provisioning) await database.exec(step.sql);
		// The plan's own steps run on every boot, so each has to survive being replayed. Lineage entries
		// deliberately do not: they run once against a ledger, which is what lets their `CREATE TABLE` be
		// unguarded and a `DROP COLUMN` be expressible at all.
		for (const step of provisioning.filter(({ id }) => !id.startsWith('lineage:'))) {
			await database.exec(step.sql);
		}

		const indexes = await database.query<{ indexdef: string }>(
			`select indexdef from pg_indexes where tablename = 'jurisdictions' and indexname = 'jurisdictions_search_text_trgm_idx'`
		);
		expect(indexes.rows).toHaveLength(1);
		expect(indexes.rows[0]?.indexdef).toContain('gin_trgm_ops');

		// Enough rows that the planner has a reason to prefer the index over reading the table.
		await database.exec(`insert into jurisdictions (code, name, effective_range)
			select 'C' || generate_series, 'Jurisdiction ' || generate_series, '{}'::jsonb from generate_series(1, 2000)`);
		await database.exec('analyze jurisdictions');
		await database.exec('set enable_seqscan = off');
		const explain = await database.query<{ 'QUERY PLAN': string }>(
			`explain (costs off) select * from jurisdictions where (coalesce(name, '')) ilike '%1234%'`
		);
		expect(explain.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
			'jurisdictions_search_text_trgm_idx'
		);

		const period = (start: string, end: string): string => JSON.stringify({ start, end });
		await database.query(
			`insert into jurisdictions (code, name, effective_range) values ('MY', 'Malaysia', $1)`,
			[period('2026-01-01', '2027-01-01')]
		);
		await expect(
			database.query(
				`insert into jurisdictions (code, name, effective_range) values ('MY', 'Malaysia revised', $1)`,
				[period('2026-06-01', '2027-06-01')]
			)
		).rejects.toThrow(/exclusion constraint/i);
		// Abutting, not overlapping: `[)` means the successor starts where the predecessor ends.
		await database.query(
			`insert into jurisdictions (code, name, effective_range) values ('MY', 'Malaysia 2027', $1)`,
			[period('2027-01-01', '2028-01-01')]
		);
		const held = await database.query<{ count: number }>(
			`select count(*)::int as count from jurisdictions where code = 'MY'`
		);
		expect(held.rows[0]?.count).toBe(2);
	});

	/**
	 * The relation filter, against the tables the plan actually builds.
	 *
	 * `id` is `uuid`, and a foreign key that points at it was planned as `text` because
	 * `describeModelColumns` flattened Drizzle's `PgUUID` to `string`. Nothing noticed while filters
	 * only compared a column with a bind parameter — Postgres coerces an untyped parameter — but a
	 * relation filter compiles to `EXISTS (... WHERE "leave_requests"."employment_id" =
	 * "employments"."id")`, a column-to-column comparison with no parameter to coerce, and
	 * Postgres answers `operator does not exist: text = uuid`. That is what took Leave → Overview down:
	 * every seasonality read scoped to a company failed, and only the unscoped one worked.
	 *
	 * The SQL comes from the effective-plan predicate compiler rather than being written here, so
	 * this cannot pass against a join the compiler no longer emits.
	 */
	it('filters through a relation whose foreign key the plan renders as uuid', async () => {
		const database = new PGlite({ extensions: { pg_trgm, btree_gist, vector } });
		databases.push(database);
		const employments = collection({
			name: 'employments',
			fields: describeModel(
				defineModel({ company_id: uuid().notNull(), employee_number: text().notNull() })
			)
		});
		const leaveRequests = collection({
			name: 'leave_requests',
			fields: describeModel(defineModel({ employment_id: uuid().notNull() }))
		});
		const definition = workspace({
			name: 'relation-join',
			version: '1',
			collections: [employments, leaveRequests],
			relations: [
				{
					name: 'leave_request_employment',
					source: 'leave_requests',
					target: 'employments',
					cardinality: 'one',
					from: { collection: 'leave_requests', column: 'employment_id' },
					to: { collection: 'employments', column: 'id' }
				}
			],
			apps: [],
			policies: [],
			automations: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		// The full provisioning sequence a database actually gets: plan foundation, then the drizzle
		// lineage that owns collection tables and indexes, then the plan's supplements.
		for (const step of await provisioningStatements(definition)) await database.exec(step.sql);

		const keyType = await database.query<{ data_type: string }>(
			`select data_type from information_schema.columns where table_name = 'leave_requests' and column_name = 'employment_id'`
		);
		expect(keyType.rows[0]?.data_type).toBe('uuid');
		const foreignKeys = await database.query<{ constraint_name: string }>(
			`select constraint_name from information_schema.table_constraints where table_schema = 'public' and constraint_type = 'FOREIGN KEY' order by constraint_name`
		);
		expect(foreignKeys.rows.map(({ constraint_name }) => constraint_name)).toEqual([
			'leave_requests_employment_id_employments_fk'
		]);

		const employment = rid('employment-1');
		const company = rid('company-1');
		await database.query(
			'insert into employments (id, company_id, employee_number) values ($1, $2, $3)',
			[employment, company, 'E-1']
		);
		await database.query('insert into leave_requests (id, employment_id) values ($1, $2)', [
			rid('leave-1'),
			employment
		]);
		await expect(
			database.query('insert into leave_requests (id, employment_id) values ($1, $2)', [
				rid('leave-dangle'),
				rid('missing-employment')
			])
		).rejects.toThrow(/foreign key|violates/i);
		// The excluded row now points at a real employment in a different company. It used to dangle,
		// which the schema plan permitted because it rendered no foreign keys at all; the lineage does,
		// so a reference to nothing is refused by the database rather than quietly stored.
		const otherEmployment = rid('employment-2');
		await database.query(
			'insert into employments (id, company_id, employee_number) values ($1, $2, $3)',
			[otherEmployment, rid('company-2'), 'E-2']
		);
		await database.query('insert into leave_requests (id, employment_id) values ($1, $2)', [
			rid('leave-2'),
			otherEmployment
		]);

		const compiled = compileCollectionPredicate({
			definition,
			collection: 'leave_requests',
			where: { leave_request_employment: { company_id: { eq: company } } },
			qualifier: 'leave_requests'
		});
		if (Result.isFailure(compiled))
			throw new Error(`compileCollectionPredicate failed: ${compiled.failure.message}`);
		const rendered = compiled.success.sql.toQuery({
			escapeName: (name) => `"${name.replaceAll('"', '""')}"`,
			escapeParam: (index) => `$${index + 1}`,
			escapeString: (value) => `'${value.replaceAll("'", "''")}'`
		});
		const matched = await database.query<{ id: string }>(
			`select id from leave_requests where ${rendered.sql}`,
			[...rendered.params]
		);
		expect(matched.rows.map(({ id }) => id)).toEqual([rid('leave-1')]);
	});

	it('uses the primary-key index and permits only one competing approval decision', async () => {
		// The schema plan installs extensions, and PGlite enables none by default — a bare instance
		// cannot execute the plan it is here to verify.
		const database = new PGlite({ extensions: { pg_trgm, btree_gist, vector } });
		databases.push(database);
		await database.exec(`create table records (id text primary key, value text not null)`);
		await database.exec(`insert into records (id, value) values ('r1', 'ready')`);
		const explain = await database.query<{ 'QUERY PLAN': string }>(
			`explain (costs off) select * from records where id = 'r1'`
		);
		expect(explain.rows.map((row) => row['QUERY PLAN']).join('\n')).toMatch(
			/Index Scan|Bitmap Index Scan/
		);

		await database.exec(
			`create table approvals (request_id text primary key, status text not null, decided_by text)`
		);
		await database.exec(`insert into approvals (request_id, status) values ('a1', 'pending')`);
		const decide = (actor: string) =>
			database.query<{ request_id: string }>(
				`update approvals set status = 'approved', decided_by = $1 where request_id = 'a1' and status = 'pending' returning request_id`,
				[actor]
			);
		const decisions = await Promise.all([decide('u1'), decide('u2')]);
		expect(decisions.reduce((count, decision) => count + decision.rows.length, 0)).toBe(1);
		const final = await database.query<{ status: string; decided_by: string }>(
			`select status, decided_by from approvals where request_id = 'a1'`
		);
		expect(final.rows).toHaveLength(1);
		expect(final.rows[0]).toMatchObject({ status: 'approved' });
	});
});
