import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId, type SyncChange } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	groupedUpdateStatements,
	type PlannedUpdate
} from '../src/runtime/collections/collections.js';
import { readConsistencyStatements } from '../src/runtime/collections/read-consistency.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * A batch of updates of one shape is one statement, the way a batch of creates already is.
 *
 * The write that made this matter is a payroll run pinning every source row it consumed: two and
 * a half thousand `{ id, payslip_id }` updates across six collections arrived as two and a half
 * thousand `update … where id = $n` statements, each preceded by a `bolt_assert` that only proved
 * the row existed. Over a network database that is the whole of a twenty-second "Saving…". The
 * grouped form types its columns through `jsonb_populate_recordset`, so it holds for any table
 * and any column set without a cast table of its own.
 */
const definition = workspace({
	name: 'update-batching',
	version: '1.0.0',
	collections: [
		collection({
			name: 'notes',
			fields: { body: field.string({ required: true }), title: field.string({}) }
		})
	],
	apps: [app({ name: 'batching', label: 'Batching' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'read' },
				{ collection: 'notes', action: 'update' }
			]
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const updatesOf = (statements: ReadonlyArray<string>): ReadonlyArray<string> =>
	statements.filter((statement) => statement.startsWith('update "notes"'));

const run = async (
	count: number,
	patch: (id: string, index: number) => Readonly<Record<string, unknown>>
): Promise<{
	readonly statements: ReadonlyArray<string>;
	readonly changes: ReadonlyArray<SyncChange>;
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}> => {
	harness = await makeBoltTestRuntime(definition);
	const result = await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			const created = yield* collections.mutate(
				EffectId.make('seed'),
				adminSubject,
				'notes',
				Array.from({ length: count }, (_, index) => ({ body: `note ${index}` }))
			);
			yield* (yield* SyncCommit.Service).drainChanges;
			harness!.database.forget();
			const ids = created.records.map((row) => String(row['id']));
			yield* collections.mutate(
				EffectId.make('batch'),
				adminSubject,
				'notes',
				ids.map((id, index) => ({ id, ...patch(id, index) }))
			);
			const changes = yield* (yield* SyncCommit.Service).drainChanges;
			const rows = yield* collections.findMany(EffectId.make('read'), adminSubject, {
				collection: 'notes',
				limit: count
			});
			return { changes, rows };
		})
	);
	const statements = [...harness.database.statements];
	return { statements, ...result };
};

describe('the statements a batch of updates is', () => {
	it('writes rows of one shape as one update, not one each, and no per-row assertion', async () => {
		const { statements, changes, rows } = await run(40, (_, index) => ({ title: `t${index}` }));
		const updates = updatesOf(statements);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain('jsonb_populate_recordset(null::"notes", $1::jsonb)');
		// The forty version guards are one statement too, typed through the same recordset.
		const guards = statements.filter((statement) => statement.startsWith('select bolt_assert'));
		expect(guards).toHaveLength(1);
		expect(guards[0]).toContain('jsonb_populate_recordset(null::"notes", $1::jsonb) as v join');
		// The forty history rows are one insert too: per-row bookkeeping was the second half of the
		// payroll run's statement count after the updates themselves were grouped.
		const history = statements.filter((statement) =>
			statement.startsWith('insert into "bolt_collection_history"')
		);
		expect(history).toHaveLength(1);
		expect(changes.filter((change) => change.operation === 'update')).toHaveLength(40);
		expect(rows.map((row) => row['title']).toSorted()).toEqual(
			Array.from({ length: 40 }, (_, index) => `t${index}`).toSorted()
		);
	}, 60_000);

	it('writes one update per distinct shape, and a lone row keeps its plain statement', async () => {
		const { statements, rows } = await run(5, (_, index) =>
			index === 0 ? { body: 'rewritten' } : { title: `t${index}` }
		);
		const updates = updatesOf(statements);
		expect(updates).toHaveLength(2);
		expect(updates.find((statement) => statement.includes('"body" = $1'))).toBeDefined();
		expect(updates.find((statement) => statement.includes('"title" = v."title"'))).toBeDefined();
		expect(rows.filter((row) => row['body'] === 'rewritten')).toHaveLength(1);
	}, 60_000);
});

describe('the bounds a grouped update is built against', () => {
	const rowsOf = (count: number): ReadonlyArray<PlannedUpdate> =>
		Array.from({ length: count }, (_, row) => ({
			table: 'wide',
			id: `id-${row}`,
			columns: ['a', 'b'],
			casts: ['', ''],
			parameters: [`${row}-a`, `${row}-b`],
			values: [`${row}-a`, `${row}-b`],
			clearLock: false
		}));

	it('chunks a large batch and keeps every row in exactly one chunk', () => {
		const statements = groupedUpdateStatements(rowsOf(4_500));
		expect(statements.length).toBe(3);
		const ids = statements.flatMap((statement) =>
			(JSON.parse(String(statement.parameters[0])) as ReadonlyArray<{ id: string }>).map(
				(row) => row.id
			)
		);
		expect(new Set(ids).size).toBe(4_500);
	});

	it('keeps the lock release on the batched statement', () => {
		const [statement] = groupedUpdateStatements(
			rowsOf(2).map((row) => ({ ...row, clearLock: true }))
		);
		expect(statement?.sql).toContain('approval_id = null');
		expect(statement?.sql).toContain('row_version = t.row_version + 1');
	});
});

describe('the statements a batch of deletes is', () => {
	it('deletes rows of one table as one statement, locks them as one, and writes one history row set', async () => {
		harness = await makeBoltTestRuntime(definition);
		const statements = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const created = yield* collections.mutate(
					EffectId.make('seed'),
					adminSubject,
					'notes',
					Array.from({ length: 40 }, (_, index) => ({ body: `note ${index}` }))
				);
				yield* (yield* SyncCommit.Service).drainChanges;
				harness!.database.forget();
				yield* collections.delete(
					EffectId.make('batch'),
					adminSubject,
					'notes',
					created.records.map((row) => String(row['id']))
				);
				return [...harness!.database.statements];
			})
		);
		const deletes = statements.filter((statement) => statement.startsWith('delete from "notes"'));
		expect(deletes).toHaveLength(1);
		expect(deletes[0]).toContain('jsonb_populate_recordset(null::"notes", $1::jsonb)');
		const locks = statements.filter(
			(statement) => statement.startsWith('select bolt_assert') && statement.includes('for update')
		);
		expect(locks).toHaveLength(1);
		const history = statements.filter((statement) =>
			statement.startsWith('insert into "bolt_collection_history"')
		);
		expect(history).toHaveLength(1);
	}, 60_000);
});

describe('the statements a write opens with', () => {
	it('locks every table in one statement and checks every read in one assertion', () => {
		const statements = readConsistencyStatements(
			[
				{
					sql: 'select 1 from "a" where x = $1',
					parameters: [1],
					fingerprint: 'fa',
					tables: ['a']
				},
				{
					sql: 'select 1 from "b" where y = $1 and z = $2',
					parameters: [2, 3],
					fingerprint: 'fb',
					tables: ['b']
				}
			],
			['c']
		);
		expect(statements).toHaveLength(2);
		expect(statements[0]!.sql).toBe('lock table "a", "b", "c" in share row exclusive mode');
		expect(statements[1]!.sql).toContain('where x = $1');
		expect(statements[1]!.sql).toContain('where y = $3 and z = $4');
		expect(statements[1]!.sql).toContain('= $2 and (');
		expect(statements[1]!.parameters).toEqual([1, 'fa', 2, 3, 'fb', expect.any(String)]);
	});
});
