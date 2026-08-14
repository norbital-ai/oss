import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { defineRelations, operators } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { createHostTenantDb } from '../support/host-tenant-db.js';
import { dateRange } from '$lib/authoring/builtin/columns.js';
import { buildSelect, setLocalSchema, type LocalCollectionSchema } from '$lib/ui/sync/local-sql.js';
import { DRIZZLE_FIELD_OPERATORS } from '$lib/server/collection/collection_operators.server.js';
import { createWorkspaceContext } from '$lib/server/bootstrap/workspace_store.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { directFindMany } from '$lib/server/collection/collection_direct.js';
import type { CollectionQuery } from '$lib/authoring/workspace/db-api.js';

/**
 * `where` filtering on `dateRange()` columns, across the two evaluators that must agree.
 *
 * `contains_date` and `overlaps` are Pod's operators, not Drizzle's. Drizzle's
 * `relationsFieldFilterToSQL` ends in `operators[key](column, value)`, so before the server learned
 * to compile them a raw `where` carrying one reached Drizzle and threw
 * `operators[target] is not a function` — while the local replica, which does implement them,
 * happily rendered the optimistic rows. Two evaluators disagreeing was the actual defect, so every
 * filter here is asserted against both: the server through `directFindMany`, and the replica's
 * compiler (`ui/sync/local-sql.ts`) executed as SQL against the same rows. PGlite is Postgres, so
 * running the replica's SQL on this database is the same evaluation the browser performs.
 */

requireDocker();

/**
 * A `where` exactly as it arrives on the wire: untyped JSON, including keys no schema blesses.
 * Casting it here is the same step the remote boundary takes, and the whole point of the tests
 * below is what the server does with one afterwards.
 */
function wireWhere(where: Record<string, unknown>): CollectionQuery['where'] {
	return where as CollectionQuery['where'];
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const ACME = '33333333-3333-4333-8333-333333333333';
const GLOBEX = '44444444-4444-4444-8444-444444444444';

/** A calendar day inside the second and third ranges only. */
const IN_H2 = '2026-08-05T00:00:00.000Z';
/** A calendar day inside the first range only. */
const IN_H1 = '2026-02-01T00:00:00.000Z';

const companies = pgTable('companies', {
	norbital_id: uuid().primaryKey().defaultRandom(),
	name: text()
});

const terms = pgTable('terms', {
	norbital_id: uuid().primaryKey().defaultRandom(),
	company_id: uuid(),
	code: text(),
	effective_range: dateRange()
});

const SCHEMA_SQL = `
	CREATE TABLE companies (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		name TEXT
	);
	CREATE TABLE terms (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		company_id UUID,
		code TEXT,
		effective_range JSONB
	);
`;

const RELATIONSHIPS = [
	{ name: 'company', from: 'terms', to: 'companies' },
	{ name: 'terms', from: 'companies', to: 'terms' }
] as const;

/** Only the relationship lookups the query path reaches. */
const manifestCtx = {
	findRelationship: (name: string) => RELATIONSHIPS.find((entry) => entry.name === name),
	getRelationshipsForCollection: (collection: string) =>
		RELATIONSHIPS.filter((entry) => entry.from === collection || entry.to === collection),
	getCollection: () => ({})
} as unknown as Parameters<typeof createWorkspaceContext>[0]['manifestCtx'];

/** The schema facts runtime/client.ts publishes to the replica from the same manifest. */
function installLocalSchema(): void {
	setLocalSchema(
		new Map<string, LocalCollectionSchema>([
			[
				'companies',
				{
					name: 'companies',
					columns: ['norbital_id', 'name'],
					fieldKinds: { norbital_id: 'uuid', name: 'text' },
					searchFields: ['name'],
					relationships: [
						{
							name: 'terms',
							target: 'terms',
							cardinality: 'many',
							localField: 'norbital_id',
							targetField: 'company_id'
						}
					]
				}
			],
			[
				'terms',
				{
					name: 'terms',
					columns: ['norbital_id', 'company_id', 'code', 'effective_range'],
					fieldKinds: {
						norbital_id: 'uuid',
						company_id: 'uuid',
						code: 'text',
						effective_range: 'date-range'
					},
					searchFields: ['code'],
					relationships: [
						{
							name: 'company',
							target: 'companies',
							cardinality: 'one',
							localField: 'company_id',
							targetField: 'norbital_id'
						}
					]
				}
			]
		])
	);
}

describe('Collection `where` operators on dateRange columns (real Postgres)', () => {
	let pg: PgHarness;
	let pool: Pool;
	let host: ReturnType<typeof createHostTenantDb>;
	let ctx: ProvisionedContext;

	/** The rows the server returns, by `code`, in a stable order. */
	async function serverCodes(
		collection: string,
		where: Record<string, unknown>,
		column = 'code'
	): Promise<string[]> {
		const rows = await directFindMany(ctx, collection, { where: wireWhere(where), limit: 100 });
		return rows.map((row) => String(row[column])).sort();
	}

	/** The same query as the replica's compiler renders it, run against the same rows. */
	async function replicaCodes(
		collection: string,
		where: Record<string, unknown>,
		column = 'code'
	): Promise<string[]> {
		const built = buildSelect(collection, { where });
		expect(built, 'the replica must be able to compile this filter locally').not.toBeNull();
		const { rows } = await pool.query<Record<string, unknown>>(built!.sql, built!.params);
		return rows.map((row) => String(row[column])).sort();
	}

	/** Both evaluators, asserted to agree, returning the rows they agreed on. */
	async function agreedCodes(
		collection: string,
		where: Record<string, unknown>,
		column = 'code'
	): Promise<string[]> {
		const [server, replica] = await Promise.all([
			serverCodes(collection, where, column),
			replicaCodes(collection, where, column)
		]);
		expect(replica, 'replica and server must resolve the same rows').toEqual(server);
		return server;
	}

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await pool.query(SCHEMA_SQL);
		await pool.query(`INSERT INTO companies (norbital_id, name) VALUES ($1,'Acme'),($2,'Globex')`, [
			ACME,
			GLOBEX
		]);
		await pool.query(
			`INSERT INTO terms (company_id, code, effective_range) VALUES
			 ($1,'h1',$3::jsonb), ($1,'h2',$4::jsonb), ($2,'mid',$5::jsonb)`,
			[
				ACME,
				GLOBEX,
				JSON.stringify({ start: '2026-01-01T00:00:00.000Z', end: '2026-06-30T23:59:59.999Z' }),
				JSON.stringify({ start: '2026-07-01T00:00:00.000Z', end: '2026-12-31T23:59:59.999Z' }),
				JSON.stringify({ start: '2026-03-01T00:00:00.000Z', end: '2026-09-30T23:59:59.999Z' })
			]
		);

		host = createHostTenantDb(pg.connectionString, { pool });

		ctx = createWorkspaceContext({
			provision: 'provisioned',
			manifestCtx,
			organization: { norbital_id: ORG_ID, name: 'Test Org' },
			baseScope: {
				requestor: { norbital_id: USER_ID, role: 'admin' },
				organization: { norbital_id: ORG_ID, name: 'Test Org' }
			} as unknown as Parameters<typeof createWorkspaceContext>[0]['baseScope'],
			tenantDb: host.tenantDb,
			tableRegistry: { companies, terms },
			relationsRegistry: defineRelations({ companies, terms }, (r) => ({
				terms: {
					company: r.one.companies({ from: r.terms.company_id, to: r.companies.norbital_id })
				},
				companies: {
					terms: r.many.terms({ from: r.companies.norbital_id, to: r.terms.company_id })
				}
			}))
		});

		installLocalSchema();
	}, 180_000);

	afterAll(async () => {
		await host?.close();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	it('resolves `contains_date` in a raw where — the shape the authoring skill documents', async () => {
		expect(await agreedCodes('terms', { effective_range: { contains_date: IN_H2 } })).toEqual([
			'h2',
			'mid'
		]);
		expect(await agreedCodes('terms', { effective_range: { contains_date: IN_H1 } })).toEqual([
			'h1'
		]);
	});

	it('resolves `overlaps` in a raw where', async () => {
		const january = {
			start: '2026-01-05T00:00:00.000Z',
			end: '2026-02-05T00:00:00.000Z'
		};
		expect(await agreedCodes('terms', { effective_range: { overlaps: january } })).toEqual(['h1']);

		const midsummer = {
			start: '2026-06-25T00:00:00.000Z',
			end: '2026-07-05T00:00:00.000Z'
		};
		expect(await agreedCodes('terms', { effective_range: { overlaps: midsummer } })).toEqual([
			'h1',
			'h2',
			'mid'
		]);
	});

	it('combines with an ordinary operator on another column', async () => {
		expect(
			await agreedCodes('terms', {
				company_id: { eq: ACME },
				effective_range: { contains_date: IN_H2 }
			})
		).toEqual(['h2']);
	});

	it('resolves inside AND, OR and NOT', async () => {
		expect(
			await agreedCodes('terms', {
				AND: [{ company_id: { eq: ACME } }, { effective_range: { contains_date: IN_H2 } }]
			})
		).toEqual(['h2']);

		expect(
			await agreedCodes('terms', {
				OR: [{ effective_range: { contains_date: IN_H1 } }, { code: { eq: 'mid' } }]
			})
		).toEqual(['h1', 'mid']);

		expect(
			await agreedCodes('terms', { NOT: { effective_range: { contains_date: IN_H2 } } })
		).toEqual(['h1']);
	});

	it('resolves inside a field-level OR on the same column', async () => {
		const where = {
			effective_range: { OR: [{ contains_date: IN_H1 }, { contains_date: IN_H2 }] }
		};
		expect(await serverCodes('terms', where)).toEqual(['h1', 'h2', 'mid']);
		// The replica has no field-level AND/OR/NOT, so it declines this query outright and the
		// server answers it. Declining is the safe half of the contract — there is no optimistic
		// result to disagree with — which is exactly what `contains_date` used to lack.
		expect(buildSelect('terms', { where })).toBeNull();
	});

	it('resolves inside a relation filter object', async () => {
		expect(
			await agreedCodes(
				'companies',
				{ terms: { effective_range: { contains_date: IN_H1 } } },
				'name'
			)
		).toEqual(['Acme']);

		expect(
			await agreedCodes(
				'companies',
				{ terms: { effective_range: { contains_date: IN_H2 } } },
				'name'
			)
		).toEqual(['Acme', 'Globex']);
	});

	it('rejects an unknown operator with a 400 naming collection, field and operator', async () => {
		const failure = await directFindMany(ctx, 'terms', {
			where: wireWhere({ code: { starts_with: 'h' } })
		}).then(
			() => null,
			(cause: unknown) => cause
		);

		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(TypeError);
		expect(String((failure as Error).message)).not.toMatch(/is not a function/);
		expect((failure as { status?: number }).status).toBe(400);
		const message = String((failure as Error).message);
		expect(message).toContain("'terms'");
		expect(message).toContain("'code'");
		expect(message).toContain("'starts_with'");
		// The reply has to say what would have worked, ours and Drizzle's alike.
		expect(message).toContain('eq');
		expect(message).toContain('contains_date');
		expect(message).toContain('overlaps');
	});

	it('rejects an unknown operator wherever it is nested', async () => {
		const nested: readonly Record<string, unknown>[] = [
			{ AND: [{ code: { starts_with: 'h' } }] },
			{ NOT: { code: { starts_with: 'h' } } },
			{ effective_range: { OR: [{ contains_date: IN_H1 }, { spans: IN_H2 }] } }
		];
		for (const where of nested) {
			const failure = await directFindMany(ctx, 'terms', { where: wireWhere(where) }).then(
				() => null,
				(cause: unknown) => cause
			);
			expect((failure as { status?: number })?.status, JSON.stringify(where)).toBe(400);
			expect(String((failure as Error).message)).not.toMatch(/is not a function/);
		}

		const related = await directFindMany(ctx, 'companies', {
			where: wireWhere({ terms: { code: { starts_with: 'h' } } })
		}).then(
			() => null,
			(cause: unknown) => cause
		);
		expect((related as { status?: number })?.status).toBe(400);
		expect(String((related as Error).message)).toContain("'terms'");
	});

	it('still rejects a bad operand for our own operators, as a 400', async () => {
		const failure = await directFindMany(ctx, 'terms', {
			where: wireWhere({ effective_range: { contains_date: '2026-08-05' } })
		}).then(
			() => null,
			(cause: unknown) => cause
		);
		expect((failure as { status?: number })?.status).toBe(400);
		expect(String((failure as Error).message)).toMatch(/UTC ISO instant/);
	});

	it('accepts every operator the request boundary advertises', () => {
		// The accepted set is Drizzle's field-filter vocabulary plus ours; if a Drizzle upgrade
		// renames or drops one of those, the 400 above would start rejecting a working filter.
		const specialCased: Record<string, string> = {
			in: 'inArray',
			notIn: 'notInArray'
		};
		const available = operators as unknown as Record<string, unknown>;
		for (const operator of DRIZZLE_FIELD_OPERATORS) {
			expect(typeof available[specialCased[operator] ?? operator], operator).toBe('function');
		}
	});
});
