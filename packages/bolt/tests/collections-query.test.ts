import { pgTable, text } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	field,
	type FieldDefinition,
	type RelationDefinition,
	type WorkspaceDefinition
} from '../src/authoring/workspace-schema.js';
import {
	compileCollectionPredicate,
	compileOrderTerms,
	orderingExpressions
} from '../src/runtime/access/effective-plan.js';
import {
	compileCollectionCursorSeek,
	encodeCollectionCursor
} from '../src/runtime/collections/read/cursor.js';

/** Unwraps a where compilation the test expects to succeed and renders it the way the driver would. */
const dialect = new PgDialect();
type WhereContext = Readonly<{
	readonly collection: string;
	readonly fields: Readonly<Record<string, FieldDefinition>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	readonly collections: ReadonlyArray<string>;
	readonly fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>;
	readonly definition: WorkspaceDefinition;
	readonly qualifier?: string;
}>;

const compilePredicate = (where: unknown, context: WhereContext) =>
	compileCollectionPredicate({
		definition: context.definition,
		collection: context.collection,
		where,
		qualifier: context.qualifier ?? context.collection
	});

const whereSql = (where: unknown, context: WhereContext) => {
	const result = compilePredicate(where, context);
	if (Result.isFailure(result))
		throw new Error(`compileCollectionPredicate failed: ${result.failure.message}`);
	const built = dialect.sqlToQuery(result.success.sql);
	return { sql: built.sql, parameters: built.params };
};

const workspaceDefinition = (
	rootCollection: string,
	rootFields: Readonly<Record<string, FieldDefinition>>,
	collections: ReadonlyArray<string>,
	fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>,
	relations: ReadonlyArray<RelationDefinition>
): WorkspaceDefinition => ({
	name: 'collections-query-test',
	version: '1',
	collections: [...new Set([...collections, rootCollection])].map((name) => ({
		name,
		fields: name === rootCollection ? rootFields : (fieldsByCollection[name] ?? {}),
		history: true
	})),
	relations,
	apps: [],
	policies: [],
	prompt: 'Compile collection query test predicates.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	integrations: [],
	requiredFacilities: []
});

const context = (collection: string, extras: Partial<WhereContext> = {}): WhereContext => {
	const base = {
		collection,
		fields: {
			name: field.string({ required: true }),
			company_id: field.string({ required: true }),
			effective_range: field.json({ required: true })
		},
		relations: [
			{
				name: 'employment_employee',
				source: 'employees',
				target: 'employments',
				cardinality: 'many',
				from: { collection: 'employees', column: 'id' },
				to: { collection: 'employments', column: 'employee_id' }
			},
			{
				name: 'employment_employee',
				source: 'employments',
				target: 'employees',
				cardinality: 'one',
				from: { collection: 'employments', column: 'employee_id' },
				to: { collection: 'employees', column: 'id' }
			}
		] satisfies ReadonlyArray<RelationDefinition>,
		collections: ['companies', 'employees', 'employments'],
		fieldsByCollection: {
			companies: {
				name: field.string({ required: true }),
				effective_range: field.json({ required: true })
			},
			employees: { name: field.string({ required: true }) },
			employments: {
				company_id: field.string({ required: true }),
				employee_id: field.string({ required: true }),
				effective_range: field.json({ required: true })
			}
		}
	};
	const merged = { ...base, ...extras };
	return {
		...merged,
		definition:
			extras.definition ??
			workspaceDefinition(
				merged.collection,
				merged.fields,
				merged.collections,
				merged.fieldsByCollection,
				merged.relations
			)
	};
};

describe('Collections query owner', () => {
	it('compiles isNull against a system column', () => {
		const compiled = whereSql({ approval_id: { isNull: true } }, context('companies'));
		expect(compiled.sql).toBe('"companies"."approval_id" is null');
		expect(compiled.parameters).toEqual([]);
	});

	it('compiles eq AND isNull as a conjunction', () => {
		const compiled = whereSql(
			{ name: { eq: 'Acme' }, approval_id: { isNull: true } },
			context('companies')
		);
		expect(compiled.sql).toBe(
			'("companies"."name" is not distinct from $1 and "companies"."approval_id" is null)'
		);
		expect(compiled.parameters).toEqual(['Acme']);
	});

	it('compiles contains_date against a jsonb dateRange with an open end', () => {
		const compiled = whereSql(
			{ effective_range: { contains_date: '2026-08-15T16:00:00.000Z' } },
			context('companies')
		);
		expect(compiled.sql).toBe(
			'(("companies"."effective_range"->>\'start\') is not null and ("companies"."effective_range"->>\'start\') <= $1::text and ("companies"."effective_range"->>\'end\' is null or ("companies"."effective_range"->>\'end\') >= $2::text))'
		);
		expect(compiled.parameters).toEqual(['2026-08-15T16:00:00.000Z', '2026-08-15T16:00:00.000Z']);
	});

	it('maps id to the persisted id column', () => {
		const compiled = whereSql({ id: { eq: 'seed-company' } }, context('companies'));
		expect(compiled.sql).toBe('"companies"."id" is not distinct from $1');
		expect(compiled.parameters).toEqual(['seed-company']);
	});

	it('compiles a many-relation filter as EXISTS using the inverse foreign key', () => {
		const compiled = whereSql(
			{
				employment_employee: {
					some: {
						approval_id: { isNull: true },
						company_id: { eq: 'seed-company' }
					}
				}
			},
			context('employees')
		);
		expect(compiled.sql).toBe(
			'exists (select 1 from "employments" as "pr0" where "pr0"."employee_id" = "employees"."id" and (true) and (("pr0"."approval_id" is null and "pr0"."company_id" is not distinct from $1)))'
		);
		expect(compiled.parameters).toEqual(['seed-company']);
	});

	it('refuses a relation filter when the compiled relation is not emitted', () => {
		const result = compilePredicate(
			{ employment_employee: { some: { company_id: { eq: 'seed-company' } } } },
			context('employees', { relations: [] })
		);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure.message).toContain('no compiled relationship');
			expect(result.failure.relationship).toBe('employees.employment_employee');
		}
	});

	it('compiles every comparison operator authored workspaces use', () => {
		const compiled = whereSql(
			{ name: { gte: 'A', lte: 'M', ne: 'Bob', gt: 'A', lt: 'Z' } },
			context('companies')
		);
		expect(compiled.sql).toBe(
			'("companies"."name" >= $1 and "companies"."name" <= $2 and "companies"."name" is distinct from $3 and "companies"."name" > $4 and "companies"."name" < $5)'
		);
		expect(compiled.parameters).toEqual(['A', 'M', 'Bob', 'A', 'Z']);
	});

	it('binds a Date operand as a UTC instant', () => {
		const compiled = whereSql(
			{ created_at: { gte: new Date('2026-01-01T00:00:00.000Z') } },
			context('companies')
		);
		expect(compiled.sql).toBe('"companies"."created_at" >= $1');
		expect(compiled.parameters).toEqual(['2026-01-01T00:00:00.000Z']);
	});

	it('expands in and notIn to placeholder lists', () => {
		const included = whereSql({ name: { in: ['Acme', 'Globex'] } }, context('companies'));
		expect(included.sql).toBe('"companies"."name" in ($1, $2)');
		expect(included.parameters).toEqual(['Acme', 'Globex']);
		const excluded = whereSql({ name: { notIn: ['Acme'] } }, context('companies'));
		expect(excluded.sql).toBe('"companies"."name" not in ($1)');
		expect(excluded.parameters).toEqual(['Acme']);
	});

	it('compiles polymorphic reference handles to their selected exclusive-arc arms', () => {
		const referenceContext = context('payslip_sources', {
			fields: {
				source: {
					type: 'reference',
					required: true,
					indexed: true,
					unique: true,
					reference: {
						onDelete: 'restrict',
						targets: [
							{
								tag: 'TIME_ENTRY',
								collection: 'time_entries',
								storageColumn: 'source__time_entry_id'
							},
							{
								tag: 'LEAVE_REQUEST',
								collection: 'leave_requests',
								storageColumn: 'source__leave_request_id'
							}
						]
					}
				}
			}
		});
		const id = '018f9f89-6cb2-7b3c-8fc8-832ea10c46d1';
		expect(whereSql({ source: { eq: { kind: 'TIME_ENTRY', id } } }, referenceContext)).toEqual({
			sql: '"payslip_sources"."source__time_entry_id" is not distinct from $1',
			parameters: [id]
		});
		expect(whereSql({ source: { kind: { eq: 'LEAVE_REQUEST' } } }, referenceContext)).toEqual({
			sql: '"payslip_sources"."source__leave_request_id" is not null',
			parameters: []
		});
	});

	it('answers an empty membership set as a constant instead of invalid SQL', () => {
		expect(whereSql({ name: { in: [] } }, context('companies')).sql).toBe('false');
		expect(whereSql({ name: { notIn: [] } }, context('companies')).sql).toBe('true');
	});

	it('compiles pattern operators', () => {
		const compiled = whereSql({ name: { ilike: '%acme%' } }, context('companies'));
		expect(compiled.sql).toBe('"companies"."name" ilike $1');
		expect(compiled.parameters).toEqual(['%acme%']);
	});

	it('compiles OR as a parenthesised disjunction with rebased placeholders', () => {
		const compiled = whereSql(
			{ OR: [{ name: { eq: 'Acme' } }, { company_id: { eq: 'c-1' } }] },
			context('companies')
		);
		expect(compiled.sql).toBe(
			'("companies"."name" is not distinct from $1 or "companies"."company_id" is not distinct from $2)'
		);
		expect(compiled.parameters).toEqual(['Acme', 'c-1']);
	});

	it('negates a nested where under NOT', () => {
		const compiled = whereSql({ NOT: { name: { eq: 'Acme' } } }, context('companies'));
		expect(compiled.sql).toBe('not ("companies"."name" is not distinct from $1)');
		expect(compiled.parameters).toEqual(['Acme']);
	});

	it('rejects an unknown operator instead of widening the query', () => {
		const result = compilePredicate({ name: { startsWith: 'A' } }, context('companies'));
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure.field).toBe('where.name.startsWith');
			expect(result.failure.collection).toBe('companies');
			expect(result.failure.message).toContain('startsWith');
		}
	});

	it('rejects a key that is neither a column nor a relation', () => {
		const result = compilePredicate({ not_a_column: { eq: 1 } }, context('companies'));
		expect(Result.isFailure(result)).toBe(true);
	});

	it('rejects an operand that cannot be bound', () => {
		const result = compilePredicate({ name: { eq: () => 'x' } }, context('companies'));
		expect(Result.isFailure(result)).toBe(true);
	});

	it('appends a whitelist order by clause, always ending on the primary key', () => {
		// The tiebreaker is not decoration: keyset paging seeks past the last row's ordering tuple, so a
		// sort that is not total repeats or skips rows at every page boundary. Ordering resolves
		// against the driver's table, which keeps runtime collation metadata out of the cursor.
		const companies = pgTable('companies', { id: text('id'), name: text('name') });
		const queryContext = context('companies');
		const named = compileOrderTerms(queryContext.definition, queryContext.collection, {
			name: 'asc'
		});
		expect(named).toEqual([
			{ column: 'name', direction: 'asc' },
			{ column: 'id', direction: 'asc' }
		]);
		expect(
			compileOrderTerms(queryContext.definition, queryContext.collection, { unknown: 'asc' })
		).toEqual([{ column: 'id', direction: 'asc' }]);
		const descending = compileOrderTerms(queryContext.definition, queryContext.collection, {
			id: 'desc'
		});
		expect(descending).toEqual([{ column: 'id', direction: 'desc' }]);
		const rendered = new PgDialect().sqlToQuery(orderingExpressions(companies, descending)[0]!);
		expect(rendered.sql).toBe('"companies"."id" desc');
	});

	it('uses cursor v2 without embedding runtime collation metadata', () => {
		const queryContext = context('companies');
		const terms = compileOrderTerms(queryContext.definition, queryContext.collection, {
			name: 'asc'
		});
		expect(terms).toEqual([
			{ column: 'name', direction: 'asc' },
			{ column: 'id', direction: 'asc' }
		]);
		const cursor = encodeCollectionCursor(terms, { name: 'Ada', id: 'company-1' });
		if (cursor === null) throw new Error('expected an encoded collection cursor');
		const seek = compileCollectionCursorSeek(cursor, terms, 'companies');
		if (Result.isFailure(seek)) throw new Error(`cursor seek failed: ${seek.failure.message}`);
		const built = new PgDialect().sqlToQuery(seek.success);
		expect(built.sql).toContain('"name" > $1');
		expect(built.sql).toContain('"name" = $2');
	});
});
