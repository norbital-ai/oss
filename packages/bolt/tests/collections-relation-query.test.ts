import { Effect, Result, type Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type { WorkspaceDefinition } from '../src/authoring/workspace-schema.js';
import {
	predicateExpression,
	type RowPredicateExpression
} from '../src/runtime/access/predicate.js';
import {
	collectionQueryTable,
	physicalColumnNames,
	referenceArmKey,
	relationalSchema
} from '../src/runtime/schema/relational-schema.js';
import { resolveWritableManyRelation } from '../src/runtime/collections/collections.js';
import {
	planRelations,
	readRelationalRows,
	type PlanContext
} from '../src/runtime/collections/read/relation-plan.js';
import { orderingExpressions } from '../src/runtime/access/effective-plan.js';
import { relationalComposer } from '../src/runtime/persistence.js';

/**
 * A `with` clause is one statement, and every level of it carries its own policy predicate.
 *
 * The security property this suite exists for is the second half of that sentence. A lateral join
 * makes a related record reachable from the same query as the row that names it, which is exactly
 * how `with` would become a way to read rows a subject cannot otherwise see — unless each level's
 * row-visibility predicate is inside that level's own subquery. These tests read the rendered SQL
 * and assert where each predicate landed, because nothing else can tell the two apart.
 */

const field = (type: string, extra: Readonly<Record<string, unknown>> = {}) => ({
	type,
	required: false,
	...extra
});

const definition = {
	name: 'demo',
	version: '0',
	relations: [
		{
			name: 'time_entry_employment',
			source: 'time_entries',
			target: 'employments',
			cardinality: 'one',
			from: { collection: 'time_entries', column: 'employment_id' },
			to: { collection: 'employments', column: 'id' }
		},
		{
			// The compiler resolves these from the inverse `one` edge and stores every relation in
			// source-to-target order; this runtime fixture starts from that canonical compiled shape.
			name: 'employment_time_entries',
			source: 'employments',
			target: 'time_entries',
			cardinality: 'many',
			from: { collection: 'employments', column: 'id' },
			to: { collection: 'time_entries', column: 'employment_id' }
		}
	],
	collections: [
		{ name: 'employments', fields: { code: field('string'), active: field('boolean') } },
		{
			name: 'time_entries',
			fields: {
				employment_id: field('uuid'),
				work_date: field('date'),
				note: field('string')
			}
		},
		{ name: 'leave_requests', fields: { from_date: field('date') } },
		{
			name: 'payslip_sources',
			fields: {
				source: field('reference', {
					required: true,
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
				})
			}
		}
	]
} as unknown as WorkspaceDefinition;

const relations = relationalSchema(definition, {
	table: collectionQueryTable,
	resolveMany: resolveWritableManyRelation
});
const composer = relationalComposer(relations);

/**
 * Canonical policy expressions, the shape `predicateExpression` actually compiles.
 *
 * A predicate is no longer a rendered `{ sql, parameters }` pair: it carries structured syntax and
 * the driver owns placeholder numbering, so these fixtures name columns, operators and values and
 * let the compiler produce the identical `"column" op $n` text the assertions below read.
 */
const PREDICATES: Readonly<Record<string, RowPredicateExpression>> = {
	employments: { kind: 'comparison', column: 'code', operator: 'eq', value: 'ENG' },
	time_entries: {
		kind: 'comparison',
		column: 'work_date',
		operator: 'gte',
		value: '2026-01-01'
	},
	leave_requests: {
		kind: 'comparison',
		column: 'from_date',
		operator: 'gte',
		value: '2026-02-02'
	}
};

const contextWith = (
	predicates: Readonly<Record<string, RowPredicateExpression>>
): PlanContext => ({
	definition,
	relations,
	authorize: () => Effect.void,
	predicate: (collection) => ({
		allowed: true,
		reason: 'test',
		actorBound: false,
		expression: predicates[collection] ?? { kind: 'constant', value: true }
	})
});

const context = contextWith(PREDICATES);

const plan = (collection: string, spec: unknown) =>
	Effect.runSync(planRelations(context, collection, spec));

const render = (collection: string, spec: unknown, using: PlanContext = context) => {
	const planned = Effect.runSync(planRelations(using, collection, spec));
	const builders = composer.query as unknown as Readonly<
		Record<
			string,
			{
				findMany: (config: unknown) => {
					toSQL: () => { sql: string; params: ReadonlyArray<unknown> };
				};
			}
		>
	>;
	const builder = builders[collection]!;
	const query = builder.findMany({
		where: { RAW: predicateExpression(using.predicate(collection)) },
		orderBy: (table: unknown) => [
			...orderingExpressions(table, [{ column: 'id', direction: 'asc' }])
		],
		limit: 100,
		...(planned.with === undefined ? {} : { with: planned.with })
	});
	const built = query.toSQL();
	return { planned, sql: built.sql, parameters: built.params };
};

/**
 * The statement with every `left join lateral(…)` cut out: the root query, and nothing else.
 *
 * A predicate that belongs to a related collection must not survive this. If it does, it is being
 * evaluated against the root's rows instead of the relation's — which is the exact shape a policy
 * bypass would take, and it is invisible in a `toContain` over the whole statement.
 */
const rootQueryOnly = (sql: string): string => {
	const opener = 'left join lateral';
	let out = '';
	let index = 0;
	for (;;) {
		const at = sql.indexOf(opener, index);
		if (at === -1) return out + sql.slice(index);
		out += sql.slice(index, at);
		let depth = 0;
		let cursor = at + opener.length;
		for (; cursor < sql.length; cursor += 1) {
			if (sql[cursor] === '(') depth += 1;
			else if (sql[cursor] === ')') {
				depth -= 1;
				if (depth === 0) {
					cursor += 1;
					break;
				}
			}
		}
		const onTrue = sql.indexOf('on true', cursor);
		index = onTrue === -1 ? cursor : onTrue + 'on true'.length;
	}
};

/** The body of the first lateral join, which is the first relation the clause named. */
const firstLateral = (sql: string): string => {
	const at = sql.indexOf('left join lateral');
	let depth = 0;
	for (let cursor = at; cursor < sql.length; cursor += 1) {
		if (sql[cursor] === '(') depth += 1;
		else if (sql[cursor] === ')') {
			depth -= 1;
			if (depth === 0) return sql.slice(at, cursor + 1);
		}
	}
	return sql.slice(at);
};

const nested = {
	employment_time_entries: {
		columns: { work_date: true },
		with: { time_entry_employment: { columns: { code: true } } }
	}
};

describe('relational `with`', () => {
	it('renders a nested read as one statement', () => {
		const { sql } = render('employments', nested);
		expect(sql.match(/left join lateral/gi)).toHaveLength(2);
		// One statement, several selects: the nested ones are the lateral subqueries.
		expect(sql.split(';').filter((part) => part.trim() !== '')).toHaveLength(1);
		expect((sql.match(/\bselect\b/gi) ?? []).length).toBeGreaterThan(2);
	});

	it("puts each level's row predicate inside that level's own lateral subquery", () => {
		const { sql, parameters } = render('employments', nested);
		const root = rootQueryOnly(sql);
		// Every predicate is in the statement...
		expect(sql).toMatch(/"work_date" >= \$\d+/u);
		expect(sql.match(/"code" is not distinct from \$\d+/gu)).toHaveLength(2);
		// ...and only the root's own is evaluated against the root's rows. A related collection's
		// predicate surfacing here would be `with` widening what the subject can see, which is the
		// failure this whole path exists to prevent.
		expect(root).toMatch(/"code" is not distinct from \$\d+/u);
		expect(root.match(/"code" is not distinct from \$\d+/gu)).toHaveLength(1);
		expect(root).not.toMatch(/"work_date"/u);
		// The related time entries are filtered by their own collection's predicate, in their own
		// subquery, beside the join condition that correlates them to the parent row.
		expect(firstLateral(sql)).toMatch(/"work_date" >= \$\d+/u);
		expect(parameters).toContain('2026-01-01');
		expect(parameters.filter((value) => value === 'ENG')).toHaveLength(2);
	});

	it('renders a many relation as an aggregate and a one relation as a row', () => {
		const { sql } = render('employments', nested);
		expect(sql).toContain('coalesce(json_agg(row_to_json("t".*)), \'[]\')');
		expect(sql).toContain('row_to_json("t".*) "r"');
	});

	/**
	 * The alias scheme is load-bearing: a level's compiled `where` qualifies its columns by name, so
	 * `read/relation-plan.ts` has to know the alias before the statement exists. Drizzle changing it would
	 * be a hard SQL error rather than a wrong answer, and this is where it is noticed.
	 */
	it('aliases the root d0 and each nested level one deeper', () => {
		const { sql } = render('employments', nested);
		expect(sql).toContain('"employments" as "d0"');
		expect(sql).toContain('"time_entries" as "d1"');
		expect(sql).toContain('"employments" as "d2"');
	});

	/**
	 * The other half of the compile-time grant check in `access-control.ts`, stated in SQL.
	 *
	 * A row scope compiles to a **bare** column name, and inside a lateral the parent row is also in
	 * scope — so the whole safety of the arrangement rests on PostgreSQL resolving an unqualified
	 * name innermost first. This drives the case where both collections have the name: the predicate
	 * has to be inside the subquery whose `from` is the *related* table, and that table has to have
	 * the column. Those two facts together are what make the inner binding the only possible one;
	 * `grantScopeProblems` is what guarantees the second of them for every declared grant.
	 */
	it('evaluates a shared column name against the related table, not the outer row', () => {
		const shared = contextWith({
			employments: { kind: 'comparison', column: 'code', operator: 'eq', value: 'ENG' },
			// `id` is a column of both collections — the exact name a bare reference could bind either
			// way, and the one an authored `{ id: { in: … } }` scope uses most often.
			time_entries: { kind: 'comparison', column: 'id', operator: 'eq', value: 't1' }
		});
		const { sql } = render('employments', { employment_time_entries: true }, shared);
		const lateral = firstLateral(sql);
		expect(lateral).toContain('"time_entries" as "d1"');
		expect(lateral).toMatch(/"id" is not distinct from \$\d+/u);
		// Not at the root: the outer row is never what this predicate filters.
		expect(rootQueryOnly(sql)).not.toMatch(/"id" is not distinct from \$\d+/u);
		// And the innermost scope really does carry the name, so resolution stops there.
		const fields = definition.collections.find((entry) => entry.name === 'time_entries')!.fields;
		expect(physicalColumnNames(fields).has('id')).toBe(true);
	});

	it('uses canonical source-to-target endpoints for a resolved many edge', () => {
		const { sql } = render('employments', { employment_time_entries: true });
		expect(sql).toContain('"d0"."id" = "d1"."employment_id"');
	});

	it('narrows a related record to exactly the requested columns', () => {
		const { sql } = render('employments', {
			employment_time_entries: { columns: { work_date: true } }
		});
		expect(sql).toContain('"d1"."work_date" as "work_date"');
		expect(sql).not.toContain('"d1"."note"');
	});

	it('supports exclusion projections without turning them into select-all', () => {
		const { sql } = render('employments', {
			employment_time_entries: { columns: { note: false } }
		});
		expect(sql).toContain('"d1"."work_date" as "work_date"');
		expect(sql).not.toContain('"d1"."note" as "note"');
	});

	/**
	 * The arm key is a SQL identifier before it is a property name.
	 *
	 * It was briefly a control character: legal in a JavaScript string, invisible in review, illegal
	 * inside a Postgres identifier, and different from the key the hydrator then looked for — which
	 * dropped the hydrated record and left the raw arm on the row. Nothing about that was visible in
	 * a count of lateral joins, so the alias is asserted by name here.
	 */
	it('names each reference arm with a printable key that reaches the SQL as its alias', () => {
		expect(referenceArmKey('source', 'TIME_ENTRY')).toBe('source#TIME_ENTRY');
		expect(referenceArmKey('source', 'TIME_ENTRY')).not.toMatch(/[\u0000-\u001f\u007f]/u);
		const { sql } = render('payslip_sources', { source: true });
		expect(sql).toContain('as "source#TIME_ENTRY" on true');
		expect(sql).toContain('as "source#LEAVE_REQUEST" on true');
	});

	it('selects a reference by its storage arms rather than by its logical name', () => {
		const { sql } = render('payslip_sources', {
			source: { TIME_ENTRY: { columns: { work_date: true } } }
		});
		expect(sql).toContain('"d0"."source__time_entry_id"');
		expect(sql).toContain('"d0"."source__leave_request_id"');
		// One lateral per declared arm, each carrying its own target collection's predicate.
		expect(sql.match(/left join lateral/gi)).toHaveLength(2);
		expect(sql).toMatch(/"work_date" >= \$\d+/u);
		expect(sql).toMatch(/"from_date" >= \$\d+/u);
		expect(rootQueryOnly(sql)).not.toMatch(/"work_date"|"from_date"/u);
	});

	it('carries a relation’s own where, ordering and bounds into its subquery', () => {
		const { sql, parameters } = render('employments', {
			employment_time_entries: {
				where: { note: { eq: 'late' } },
				orderBy: { work_date: 'desc' },
				limit: 5,
				offset: 10
			}
		});
		const lateral = firstLateral(sql);
		expect(lateral).toContain('"d1"."note"');
		expect(lateral).toContain('order by "d1"."work_date" desc');
		expect(lateral).toMatch(/limit \$\d+ offset \$\d+/u);
		expect(parameters).toContain('late');
		expect(parameters).toContain(5);
		expect(parameters).toContain(10);
	});

	it('refuses a columns clause that selects nothing at all', () => {
		const outcome = Effect.runSync(
			Effect.result(
				planRelations(context, 'employments', {
					employment_time_entries: { columns: { nope: true } }
				})
			)
		);
		expect(Result.isFailure(outcome)).toBe(true);
		expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
			/columns names no column/u
		);
	});

	it('refuses a with entry it cannot resolve rather than omitting or guessing it', () => {
		const outcome = Effect.runSync(
			Effect.result(
				planRelations(context, 'employments', {
					invented: true,
					employment_time_entries: true
				})
			)
		);
		expect(Result.isFailure(outcome)).toBe(true);
		expect(Result.isFailure(outcome) && outcome.failure.message).toMatch(
			/names no compiled relationship/u
		);
	});
});

const rows = (
	values: ReadonlyArray<Readonly<Record<string, unknown>>>
): ReadonlyArray<Readonly<Record<string, unknown>>> => values;

const identityMask = (_collection: string, row: Readonly<Record<string, Schema.Json>>) => row;

describe('reading a relational result', () => {
	it('attaches a many relation as an array and a one relation as the record itself', () => {
		const planned = plan('employments', nested);
		const [row] = readRelationalRows(
			rows([
				{
					id: 'e1',
					code: 'ENG',
					employment_time_entries: [
						{ work_date: '2026-06-01', time_entry_employment: { code: 'ENG' } }
					]
				}
			]),
			planned.level,
			identityMask
		);
		expect(row).toEqual({
			id: 'e1',
			code: 'ENG',
			employment_time_entries: [{ work_date: '2026-06-01', time_entry_employment: { code: 'ENG' } }]
		});
	});

	it('reports an unmatched one relation as null, not an empty record', () => {
		const planned = plan('employments', nested);
		const [row] = readRelationalRows(
			rows([
				{
					id: 'e1',
					employment_time_entries: [{ work_date: '2026-06-01', time_entry_employment: null }]
				}
			]),
			planned.level,
			identityMask
		);
		const entries = (row as Record<string, ReadonlyArray<Record<string, unknown>>>)[
			'employment_time_entries'
		];
		expect(entries?.[0]?.['time_entry_employment']).toBeNull();
	});

	it('hydrates the arm of a polymorphic reference that the row actually names', () => {
		const planned = plan('payslip_sources', { source: true });
		const [row] = readRelationalRows(
			rows([
				{
					id: 'p1',
					source__time_entry_id: 't1',
					source__leave_request_id: null,
					[referenceArmKey('source', 'TIME_ENTRY')]: { id: 't1', work_date: '2026-06-01' },
					[referenceArmKey('source', 'LEAVE_REQUEST')]: null
				}
			]),
			planned.level,
			identityMask
		);
		expect(row).toEqual({
			id: 'p1',
			source: { kind: 'TIME_ENTRY', id: 't1', record: { id: 't1', work_date: '2026-06-01' } }
		});
	});

	it('masks every level against its own collection', () => {
		const planned = plan('employments', { employment_time_entries: true });
		const [row] = readRelationalRows(
			rows([
				{
					id: 'e1',
					code: 'ENG',
					employment_time_entries: [{ id: 't1', work_date: '2026-06-01', note: 'secret' }]
				}
			]),
			planned.level,
			(collection, record) =>
				collection === 'time_entries'
					? Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'note'))
					: record
		);
		const entries = (row as Record<string, ReadonlyArray<Record<string, unknown>>>)[
			'employment_time_entries'
		];
		expect(entries?.[0]).toEqual({ id: 't1', work_date: '2026-06-01' });
		expect(row?.['code']).toBe('ENG');
	});

	it('hydrates nothing onto a reference a field mask removed', () => {
		const planned = plan('payslip_sources', { source: true });
		const [row] = readRelationalRows(
			rows([
				{
					id: 'p1',
					source__time_entry_id: 't1',
					source__leave_request_id: null,
					[referenceArmKey('source', 'TIME_ENTRY')]: { id: 't1' },
					[referenceArmKey('source', 'LEAVE_REQUEST')]: null
				}
			]),
			planned.level,
			(_collection, record) =>
				Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'source'))
		);
		expect(row).toEqual({ id: 'p1' });
	});
});
