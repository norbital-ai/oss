import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/index.js';
import {
	Collections,
	groupedInsertStatements,
	type PlannedInsert
} from '../../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * How many statements a batch of creates is — not how long one takes.
 *
 * A tenant database is a Neon instance a region away, and the host runs a transaction's statements
 * serially on one connection because that is the only correct way to run a transaction. So every
 * statement in the transaction is a round trip, and 89 payslips at three statements each was 267 of
 * them at ~84ms: 22.4 seconds against a 30s deadline, none of it parse cost. The only lever is the
 * number of statements, so the number of statements is what this counts. A duration would be a
 * machine's opinion; a count is the claim.
 *
 * `notes` carries a required column and an optional one, because the shape of the claim is that
 * rows sharing a column set merge and rows that do not, do not — a fixture where every row has
 * every column could not tell the two apart.
 */
const definition = workspace({
	name: 'batching',
	version: '1.0.0',
	collections: [
		collection({
			name: 'notes',
			fields: { body: field.string({ required: true }), title: field.string({}) }
		})
	],
	apps: [app({ name: 'batching', label: 'Batching' })],
	teams: { admin: ['admin-data'] },
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'read' }
			]
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** Every statement the write issued, setup excluded. */
const statementsFor = async (
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): Promise<ReadonlyArray<string>> => {
	harness = await makeBoltTestRuntime(definition);
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(EffectId.make('batching'), adminSubject, 'notes', rows);
		})
	);
	const statements = [...harness.database.statements];
	await harness.dispose();
	harness = undefined;
	return statements;
};

const insertsInto = (statements: ReadonlyArray<string>, table: string): ReadonlyArray<string> =>
	statements.filter((statement) => statement.startsWith(`insert into "${table}" `));

/** How many rows one multi-row `values` list carries. */
const tuples = (sql: string): number => (sql.match(/\), \(/g)?.length ?? 0) + 1;

/** The highest `$n` a statement binds, which is how many parameters it carries. */
const parameterCount = (sql: string): number =>
	(sql.match(/\$(\d+)/g) ?? []).reduce(
		(highest, token) => Math.max(highest, Number(token.slice(1))),
		0
	);

describe('the statements a batch of creates is', () => {
	it('writes rows of one shape as one insert, not one each', async () => {
		const statements = await statementsFor(
			Array.from({ length: 40 }, (_, index) => ({ body: `note ${index}` }))
		);

		const rows = insertsInto(statements, 'notes');
		// One, not forty. This is the whole claim: 40 rows of one shape are one round trip.
		expect(rows).toHaveLength(1);
		expect(tuples(rows[0] ?? '')).toBe(40);
		// And the two bookkeeping tables collapse with them — they were the other two thirds of the
		// round trips a batch used to make.
		expect(insertsInto(statements, 'bolt_collection_history')).toHaveLength(1);
		expect(insertsInto(statements, 'bolt_sync_outbox')).toHaveLength(1);
	}, 60_000);

	/**
	 * The objection this design has to answer. A batch's rows do not have to name the same columns —
	 * `create.perRecord.before` may return different keys per row — and merging them under one column
	 * list would mean writing an explicit NULL where a row omitted a column, which is not the same as
	 * letting the column's default apply. So rows are grouped by the columns they actually carry, and
	 * a heterogeneous batch is one statement per shape rather than one statement with holes in it.
	 */
	it('writes one insert per distinct shape, and no more', async () => {
		const statements = await statementsFor([
			{ body: 'first' },
			{ body: 'second', title: 'titled' },
			{ body: 'third' },
			{ body: 'fourth', title: 'also titled' }
		]);

		const rows = insertsInto(statements, 'notes');
		expect(rows).toHaveLength(2);
		expect(rows.map(tuples).toSorted()).toEqual([2, 2]);
		// The shape that omitted `title` never names it, so the column takes its default rather than a
		// NULL this layer invented.
		const untitled = rows.find((statement) => !statement.includes('"title"'));
		expect(untitled).toBeDefined();
		expect(untitled).toContain('"body"');
	}, 60_000);
});

/**
 * The two bounds the grouping is built against, checked on the grouping itself.
 *
 * Against the pure function rather than through a workspace, because both of them are about sizes a
 * database test cannot reach: 65,535 parameters is ten thousand rows, and a batch is capped at five
 * thousand. Writing them through PGlite would measure PGlite.
 */
describe('the bounds a grouped insert is built against', () => {
	const wideRows = (count: number): ReadonlyArray<PlannedInsert> =>
		Array.from({ length: count }, (_, row) => ({
			table: 'wide',
			layer: 0,
			columns: Array.from({ length: 10 }, (_, column) => `c${column}`),
			parameters: Array.from({ length: 10 }, (_, column) => `${row}-${column}`)
		}));

	it('splits on the parameter ceiling rather than on a row count', () => {
		// 10,000 rows of ten columns is 100,000 parameters. Postgres binds a statement's parameters
		// under a 16-bit count and refuses more than 65,535 of them, so this has to arrive as more
		// than one statement or as none at all.
		const statements = groupedInsertStatements(wideRows(10_000));

		expect(statements.length).toBeGreaterThan(1);
		for (const statement of statements) {
			expect(parameterCount(statement.sql)).toBeLessThanOrEqual(65_535);
			expect(statement.parameters.length).toBeLessThanOrEqual(65_535);
			// Each statement binds its own parameters from $1, rather than continuing the last one's
			// numbering.
			expect(statement.sql).toContain('values ($1, $2,');
		}
		// Split, not dropped: every row is still written, and every parameter still bound.
		expect(statements.reduce((total, statement) => total + tuples(statement.sql), 0)).toBe(10_000);
		expect(statements.reduce((total, statement) => total + statement.parameters.length, 0)).toBe(
			100_000
		);
	});

	/**
	 * A predicated row is not merged with anything, and that is deliberate rather than unfinished.
	 * `VALUES` has nowhere to hang a `where`, so merging would mean `select * from (values …)`, whose
	 * columns are in scope for the predicate — a grant whose `where` names a column of the collection
	 * being created fails today with `column "owner" does not exist`, and under a subquery it would
	 * quietly start resolving against the row being written instead.
	 */
	it('leaves a row carrying a visibility predicate on the statement it has today', () => {
		const predicated: ReadonlyArray<PlannedInsert> = [
			{
				table: 'notes',
				layer: 0,
				columns: ['norbital_id', 'body'],
				parameters: ['id-1', 'first'],
				where: { sql: '"owner" = $1', parameters: ['ada'] }
			},
			{
				table: 'notes',
				layer: 0,
				columns: ['norbital_id', 'body'],
				parameters: ['id-2', 'second'],
				where: { sql: '"owner" = $1', parameters: ['ada'] }
			}
		];

		const statements = groupedInsertStatements(predicated);

		expect(statements).toHaveLength(2);
		for (const statement of statements) {
			expect(statement.sql).toBe(
				'insert into "notes" ("norbital_id", "body") select $1, $2 where "owner" = $3'
			);
			expect(statement.parameters).toHaveLength(3);
		}
	});

	/** A parent is still written before the child that names it, whatever else merges. */
	it('emits a lower layer before a higher one', () => {
		const statements = groupedInsertStatements([
			{ table: 'lines', layer: 1, columns: ['norbital_id'], parameters: ['line-1'] },
			{ table: 'payslips', layer: 0, columns: ['norbital_id'], parameters: ['slip-1'] },
			{ table: 'lines', layer: 1, columns: ['norbital_id'], parameters: ['line-2'] },
			{ table: 'payslips', layer: 0, columns: ['norbital_id'], parameters: ['slip-2'] }
		]);

		expect(statements.map((statement) => statement.sql.split(' (')[0])).toEqual([
			'insert into "payslips"',
			'insert into "lines"'
		]);
		expect(statements.map((statement) => tuples(statement.sql))).toEqual([2, 2]);
	});
});
