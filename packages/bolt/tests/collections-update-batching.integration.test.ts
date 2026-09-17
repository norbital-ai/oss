import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId, type SyncChange } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { groupedUpdates } from '../src/runtime/collections/collections.js';
import { readConsistencyStatements } from '../src/runtime/collections/read-consistency.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { foldedWrites, writesTo } from './support/folded-write.js';

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
				{ collection: 'notes', action: 'update' },
				{ collection: 'notes', action: 'delete' }
			]
		})
	]
});

const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		notes: {
			create: { input: { columns: { body: true, title: true } } },
			update: { input: { columns: { body: true, title: true } } },
			delete: {}
		}
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** The update pieces of the one folded write that touch `notes`, each as its own text. */
const updatesOf = (statements: ReadonlyArray<string>): ReadonlyArray<string> =>
	foldedWrites(statements).flatMap((statement) =>
		[...statement.matchAll(/w_upd\d+ as \((update "notes" as t .*?returning t\.\*)\)/g)].map(
			(match) => match[1]!
		)
	);

const run = async (
	count: number,
	patch: (id: string, index: number) => Readonly<Record<string, unknown>>
): Promise<{
	readonly statements: ReadonlyArray<string>;
	readonly changes: ReadonlyArray<SyncChange>;
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}> => {
	harness = await makeBoltTestRuntime(definition, { authored });
	const result = await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			const created = yield* collections.write(EffectId.make('seed'), adminSubject, [
				{
					collection: 'notes',
					action: 'create',
					inputs: Array.from({ length: count }, (_, index) => ({ body: `note ${index}` }))
				}
			]);
			yield* (yield* SyncCommit.Service).drainChanges;
			harness!.database.forget();
			const ids = created.records.map((row) => String(row['id']));
			yield* collections.write(EffectId.make('batch'), adminSubject, [
				{
					collection: 'notes',
					action: 'update',
					inputs: ids.map((id, index) => ({ id, ...patch(id, index) }))
				}
			]);
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
		// One folded write: the pre-image read wave, the table lock, then the statement.
		expect(foldedWrites(statements)).toHaveLength(1);
		const updates = updatesOf(statements);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain('jsonb_populate_recordset(null::"notes", $');
		// The forty version guards ride inside the update: a row still at its prepared version is
		// the only row the update matches, and one count guard says every row matched.
		expect(updates[0]).toContain('(v.row_version is null or t.row_version = v.row_version)');
		const folded = foldedWrites(statements)[0] ?? '';
		expect(folded.match(/w_count\d+ as materialized \(select bolt_assert/g)).toHaveLength(1);
		// The forty history rows are one insert too: per-row bookkeeping was the second half of the
		// payroll run's statement count after the updates themselves were grouped.
		expect(writesTo(statements, 'bolt_collection_history')).toHaveLength(1);
		expect(changes.filter((change) => change.operation === 'update')).toHaveLength(40);
		expect(rows.map((row) => row['title']).toSorted()).toEqual(
			Array.from({ length: 40 }, (_, index) => `t${index}`).toSorted()
		);
	}, 60_000);

	it('writes one update per distinct shape, a lone row included', async () => {
		const { statements, rows } = await run(5, (_, index) =>
			index === 0 ? { body: 'rewritten' } : { title: `t${index}` }
		);
		const updates = updatesOf(statements);
		expect(updates).toHaveLength(2);
		expect(updates.find((statement) => statement.includes('"body" = v."body"'))).toBeDefined();
		expect(updates.find((statement) => statement.includes('"title" = v."title"'))).toBeDefined();
		expect(rows.filter((row) => row['body'] === 'rewritten')).toHaveLength(1);
	}, 60_000);
});

describe('the shape a grouped update takes', () => {
	it('carries a batch as one recordset parameter, versions included', () => {
		const groups = groupedUpdates(
			Array.from({ length: 4_500 }, (_, row) => ({
				table: 'wide',
				id: `id-${row}`,
				rowVersion: row,
				columns: ['a', 'b'],
				values: [`${row}-a`, `${row}-b`]
			}))
		);
		expect(groups).toHaveLength(1);
		const rows = JSON.parse(String(groups[0]?.fragment.parameters[0])) as ReadonlyArray<{
			id: string;
			row_version: number;
		}>;
		expect(new Set(rows.map((row) => row.id)).size).toBe(4_500);
		expect(rows[7]).toEqual({ id: 'id-7', row_version: 7, a: '7-a', b: '7-b' });
	});
});

describe('the statements a batch of deletes is', () => {
	it('deletes rows of one table as one statement, locks them as one, and writes one history row set', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const statements = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const created = yield* collections.write(EffectId.make('seed'), adminSubject, [
					{
						collection: 'notes',
						action: 'create',
						inputs: Array.from({ length: 40 }, (_, index) => ({ body: `note ${index}` }))
					}
				]);
				yield* (yield* SyncCommit.Service).drainChanges;
				harness!.database.forget();
				yield* collections.write(EffectId.make('batch'), adminSubject, [
					{
						collection: 'notes',
						action: 'delete',
						inputs: created.records.map((row) => ({ id: String(row['id']) }))
					}
				]);
				return [...harness!.database.statements];
			})
		);
		expect(writesTo(statements, 'notes')).toHaveLength(1);
		const folded = foldedWrites(statements)[0] ?? '';
		expect(folded).toContain(
			'delete from "notes" as t using jsonb_populate_recordset(null::"notes", $'
		);
		// The forty rows are locked and version-checked by the delete itself; one count guard.
		expect(folded.match(/w_count\d+ as materialized \(select bolt_assert/g)).toHaveLength(1);
		expect(writesTo(statements, 'bolt_collection_history')).toHaveLength(1);
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
		expect(statements.lock?.sql).toBe('lock table "a", "b", "c" in share row exclusive mode');
		expect(statements.check?.sql).toContain('where x = $1');
		expect(statements.check?.sql).toContain('where y = $3 and z = $4');
		expect(statements.check?.sql).toContain('= $2 and (');
		expect(statements.check?.parameters).toEqual([1, 'fa', 2, 3, 'fb', expect.any(String)]);
	});
});
