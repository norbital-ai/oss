import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId, type SyncChange } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { groupedInserts, type PlannedInsert } from '../src/runtime/collections/collections.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { foldedWrites, writesTo } from './support/folded-write.js';

/**
 * How many statements a batch of creates is — not how long one takes.
 *
 * A tenant database is a Neon instance a region away and charges per statement, so a write is one
 * statement: every row it creates, its history and its deliveries are pieces of one `WITH`. Rows of
 * one shape are one piece; this counts pieces and statements. A duration would be a machine's
 * opinion; a count is the claim.
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
		}),
		collection({
			name: 'note_lines',
			fields: { note_id: field.uuid({}), label: field.string({ required: true }) }
		})
	],
	relations: [
		{
			name: 'note_lines',
			source: 'notes',
			target: 'note_lines',
			cardinality: 'many',
			from: { collection: 'notes', column: 'id' },
			to: { collection: 'note_lines', column: 'note_id' },
			cascade: true
		}
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
				{ collection: 'note_lines', action: 'create' },
				{ collection: 'note_lines', action: 'read' }
			]
		})
	]
});

/** The declared write contract (RFC §4.2): a note, optionally with its lines created inline. */
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		notes: {
			create: {
				input: {
					columns: { body: true, title: true },
					with: { note_lines: { create: { columns: { label: true } } } }
				}
			}
		},
		note_lines: { create: { input: { columns: { note_id: true, label: true } } } }
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** Every statement the write issued, setup excluded, plus the ChangeBatch it captured. */
const batchFor = async (
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): Promise<{
	readonly statements: ReadonlyArray<string>;
	readonly bound: ReadonlyArray<
		Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }>
	>;
	readonly changes: ReadonlyArray<SyncChange>;
}> => {
	harness = await makeBoltTestRuntime(definition, { authored });
	harness.database.forget();
	const changes = await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.write(EffectId.make('batching'), adminSubject, [
				{ collection: 'notes', action: 'create', inputs: rows }
			]);
			return yield* (yield* SyncCommit.Service).drainChanges;
		})
	);
	const statements = [...harness.database.statements];
	const bound = [...harness.database.bound];
	await harness.dispose();
	harness = undefined;
	return { statements, bound, changes };
};

/** The insert pieces into `table` of the one folded write, each with the rows its recordset carries. */
const insertsInto = (
	bound: ReadonlyArray<
		Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<unknown> }>
	>,
	table: string
): ReadonlyArray<{ readonly columns: string; readonly rows: number }> => {
	const write = bound.find(({ sql }) => sql.includes('anchor as materialized'));
	if (write === undefined) return [];
	return [
		...write.sql.matchAll(
			new RegExp(
				`w_[a-z0-9_]+ as \\(insert into "${table}" \\(([^)]*)\\) select [^$]*\\$(\\d+)::jsonb`,
				'g'
			)
		)
	].map((match) => {
		const rows: unknown = JSON.parse(String(write.parameters[Number(match[2]) - 1]));
		return { columns: match[1]!, rows: Array.isArray(rows) ? rows.length : 0 };
	});
};

describe('the statements a batch of creates is', () => {
	it('writes rows of one shape as one insert, not one each', async () => {
		const { statements, bound, changes } = await batchFor(
			Array.from({ length: 40 }, (_, index) => ({ body: `note ${index}` }))
		);

		// One statement — a write that read nothing takes no lock — with one piece for the forty rows.
		expect(foldedWrites(statements)).toHaveLength(1);
		expect(statements).toHaveLength(1);
		const rows = insertsInto(bound, 'notes');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.rows).toBe(40);
		// History is one piece of the same statement. Sync is a ChangeBatch in-process after the
		// write, not a second bookkeeping table.
		expect(insertsInto(bound, 'bolt_collection_history')).toHaveLength(1);
		expect(writesTo(statements, 'bolt_sync_outbox')).toHaveLength(0);
		expect(changes).toHaveLength(40);
		expect(
			changes.every((change) => change.collection === 'notes' && change.operation === 'insert')
		).toBe(true);
	}, 60_000);

	/**
	 * A root and its nested children are one graph (RFC §5.2): the forty lines are one insert of
	 * their own shape, and the forty-one history rows the graph touched are still one insert.
	 */
	it('writes a create with forty nested create children as one insert per shape and one history insert', async () => {
		const { bound, changes } = await batchFor([
			{
				body: 'parent',
				note_lines: {
					create: Array.from({ length: 40 }, (_, index) => ({ label: `line ${index}` }))
				}
			}
		]);

		expect(insertsInto(bound, 'notes')).toHaveLength(1);
		const lines = insertsInto(bound, 'note_lines');
		expect(lines).toHaveLength(1);
		expect(lines[0]?.rows).toBe(40);
		const history = insertsInto(bound, 'bolt_collection_history');
		expect(history).toHaveLength(1);
		expect(history[0]?.rows).toBe(41);
		expect(changes).toHaveLength(41);
	}, 60_000);

	/**
	 * The objection this design has to answer. A batch's rows do not have to name the same columns —
	 * a transform may return different keys per row — and merging them under one column
	 * list would mean writing an explicit NULL where a row omitted a column, which is not the same as
	 * letting the column's default apply. So rows are grouped by the columns they actually carry, and
	 * a heterogeneous batch is one statement per shape rather than one statement with holes in it.
	 */
	it('writes one insert per distinct shape, and no more', async () => {
		const { bound } = await batchFor([
			{ body: 'first' },
			{ body: 'second', title: 'titled' },
			{ body: 'third' },
			{ body: 'fourth', title: 'also titled' }
		]);

		const rows = insertsInto(bound, 'notes');
		expect(rows).toHaveLength(2);
		expect(rows.map((piece) => piece.rows).toSorted()).toEqual([2, 2]);
		// The shape that omitted `title` never names it, so the column takes its default rather than a
		// NULL this layer invented.
		const untitled = rows.find((piece) => !piece.columns.includes('"title"'));
		expect(untitled).toBeDefined();
		expect(untitled?.columns).toContain('"body"');
	}, 60_000);
});

/**
 * A group is one `jsonb` parameter however many rows it carries, so there is no parameter ceiling
 * to split on; what is checked on the grouping itself is the one row that must stay alone.
 */
describe('the shape a grouped insert takes', () => {
	it('carries a group as one recordset parameter', () => {
		const groups = groupedInserts(
			Array.from({ length: 10_000 }, (_, row) => ({
				table: 'wide',
				columns: Array.from({ length: 10 }, (_, column) => `c${column}`),
				values: Array.from({ length: 10 }, (_, column) => `${row}-${column}`)
			}))
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.fragment.parameters).toHaveLength(1);
		expect(JSON.parse(String(groups[0]?.fragment.parameters[0]))).toHaveLength(10_000);
		expect(groups[0]?.fragment.sql).toBe(
			'insert into "wide" ("c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9") select v."c0", v."c1", v."c2", v."c3", v."c4", v."c5", v."c6", v."c7", v."c8", v."c9" from jsonb_populate_recordset(null::"wide", $1::jsonb) as v returning *'
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
		const predicated: ReadonlyArray<PlannedInsert> = [1, 2].map((index) => ({
			table: 'notes',
			key: `rec${index}`,
			columns: ['id', 'body'],
			values: [`id-${index}`, 'text'],
			// A predicate is appended after the row's own column parameters and shares one bound
			// list with them, so its placeholders are numbered from where those end. The runtime
			// numbers them through `predicateStatement`'s `parameterOffset`; the fixture says the
			// same thing by hand.
			where: {
				sql: '"owner" = $3',
				parameters: ['ada'],
				casts: ['', ''],
				parameterValues: [`id-${index}`, 'text']
			}
		}));

		const groups = groupedInserts(predicated);

		expect(groups.map((group) => group.key)).toEqual(['rec1', 'rec2']);
		for (const group of groups) {
			expect(group.fragment.sql).toBe(
				'insert into "notes" ("id", "body") select $1, $2 where "owner" = $3 returning *'
			);
			expect(group.fragment.parameters).toHaveLength(3);
		}
	});

	/** Bookkeeping written after a predicated record is gated on that record's piece having written. */
	it('gates a row written after another piece on that piece', () => {
		const groups = groupedInserts([
			{ table: 'bolt_collection_history', columns: ['record_id'], values: ['id-1'], after: 'rec1' }
		]);
		expect(groups[0]?.fragment.sql).toContain('where exists (select 1 from w_rec1)');
	});
});
