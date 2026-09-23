import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { automation } from '../src/authoring/automations-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { writesTo } from './support/folded-write.js';

/** The read surface a transform is handed, nominal shape only: the runtime hands the live api. */
type TransformDb = Readonly<{
	readonly write_audit: Readonly<{
		readonly count: (input: Readonly<Record<string, unknown>>) => Effect.Effect<number>;
	}>;
}>;

/**
 * Both per-row costs are declared, or the measurement is of a path that never ran.
 *
 * The transform reads (one wave), and a change trigger forces a read plus an enqueue after the
 * commit. A collection with neither exercises none of it — `emitChangeEvents` returns immediately
 * when no automation watches the collection — so a fixture without them would pass this test no
 * matter what the pipeline does.
 */
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		notes: {
			create: { input: { columns: { body: true } } },
			transform: (
				inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
				context: Readonly<{ db: unknown }>
			) => (context.db as TransformDb).write_audit.count({}).pipe(Effect.as(inputs))
		},
		write_audit: { create: { input: { columns: { note_body: true } } } }
	},
	automations: {
		on_note: {
			name: 'on_note',
			policies: ['automation-data'],
			trigger: { _tag: 'Change' as const, collection: 'notes', event: 'created' as const },
			handler: () => undefined
		}
	}
};

/**
 * That a batched write costs the same number of round trips whatever N is.
 *
 * Every facility call is an RPC out of the guest isolate before it is a query, and a pipeline
 * that re-read each row after the transaction would make three per row: a read-back per row, a
 * second read of the same row for its settlement, and a read-plus-enqueue per row for its
 * change event. A real payroll run of 89 rows measured that shape at 18.1 seconds against a
 * transaction whose write itself took milliseconds — which is why the batch reuses the rows it
 * has already read back, and why this test pins cost against N.
 *
 * A count, not a duration, because a duration is a machine's opinion and this is a shape. The two
 * sizes are compared against each other rather than against a fixed number, so the test says the
 * only thing worth saying — that cost does not scale with N — and does not have to be edited every
 * time the pipeline legitimately gains or loses a step.
 */
const definition = workspace({
	name: 'budget',
	version: '1.0.0',
	collections: [
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } }),
		collection({
			name: 'write_audit',
			fields: { note_body: field.string({ required: true }) }
		})
	],
	apps: [app({ name: 'budget', label: 'Budget' })],
	// A team name maps to the policy names its members hold; `teamPath` on the subject names teams.
	teams: { admin: ['admin-data', 'automation-data'] },
	automations: [
		automation({
			name: 'on_note',
			trigger: { _tag: 'Change', collection: 'notes', event: 'created' },
			command: 'on_note',
			policies: ['automation-data']
		})
	],
	channels: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'update' },
				{ collection: 'notes', action: 'delete' },
				{ collection: 'write_audit', action: 'create' }
			]
		}),
		policy({
			name: 'automation-data',
			effect: 'allow',
			grants: [{ collection: 'notes', action: 'read' }]
		})
	]
});

/** An update whose transform adds a child create per root: the pre-image wave plus the commit. */
const dynamicAuthored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		notes: {
			update: {
				input: {
					columns: { body: true },
					with: { note_entries: { create: { columns: { label: true } } } }
				}
			},
			transform: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
				Effect.succeed(
					inputs.map((input) => ({
						...input,
						note_entries: { create: [{ label: `entry ${String(input['body'])}` }] }
					}))
				)
		},
		note_entries: { create: { input: { columns: { note_id: true, label: true } } } }
	}
};

const dynamicDefinition = workspace({
	name: 'dynamic-write-waves',
	version: '1.0.0',
	collections: [
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } }),
		collection({
			name: 'note_entries',
			fields: {
				note_id: field.uuid({ required: true }),
				label: field.string({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'note_entries',
			source: 'notes',
			target: 'note_entries',
			cardinality: 'many',
			from: { collection: 'notes', column: 'id' },
			to: { collection: 'note_entries', column: 'note_id' },
			cascade: true
		}
	],
	apps: [app({ name: 'dynamic-write-waves', label: 'Dynamic write waves' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	channels: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'read' },
				{ collection: 'notes', action: 'update' },
				{ collection: 'note_entries', action: 'create' },
				{ collection: 'note_entries', action: 'read' },
				{ collection: 'note_entries', action: 'update' },
				{ collection: 'note_entries', action: 'delete' }
			]
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const callsToWrite = async (
	rows: number
): Promise<Readonly<{ count: number; auditReads: number }>> => {
	harness = await makeBoltTestRuntime(definition, { authored });
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.write(EffectId.make(`budget-${rows}`), adminSubject, [
				{
					collection: 'notes',
					action: 'create',
					inputs: Array.from({ length: rows }, (_, index) => ({ body: `note ${index}` }))
				}
			]);
		})
	);
	const count = harness.database.calls.length;
	// The read itself, not the commit's assertion that what it read has not moved.
	const auditReads = harness.database.statements.filter(
		(statement) =>
			statement.includes('from "write_audit"') && !statement.includes('anchor as materialized')
	).length;
	await harness.dispose();
	harness = undefined;
	return { count, auditReads };
};

const dynamicWaves = async (
	rows: number
): Promise<Readonly<{ calls: number; waves: ReadonlyArray<string>; entryInserts: number }>> => {
	harness = await makeBoltTestRuntime(dynamicDefinition, { authored: dynamicAuthored });
	const inputs = Array.from({ length: rows }, (_, index) => ({
		id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		body: `after ${index}`
	}));
	for (const input of inputs)
		await harness.database.query('insert into notes (id, body) values ($1, $2)', [
			input.id,
			`before ${input.body}`
		]);
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.write(EffectId.make(`dynamic-waves-${rows}`), adminSubject, [
				{ collection: 'notes', action: 'update', inputs }
			]);
		})
	);
	const calls = harness.database.calls.length;
	const waves = harness.database.statements.filter((statement) =>
		statement.includes('__bolt_write_wave_kind')
	);
	const entryInserts = writesTo(harness.database.statements, 'note_entries').length;
	await harness.dispose();
	harness = undefined;
	return { calls, waves, entryInserts };
};

describe('the facility-call budget of a batched write', () => {
	it('costs the same number of round trips for 50 rows as for 1', async () => {
		const one = await callsToWrite(1);
		const fifty = await callsToWrite(50);

		// Equal, not merely sub-linear. A single extra per-row call would make this 49 apart.
		expect(fifty.count).toBe(one.count);
		// The transform runs once per batch, so its one read is one statement whatever N is.
		expect(one.auditReads).toBe(1);
		expect(fifty.auditReads).toBe(1);
		// And the constant is small enough that the assertion above is not passing on a shared floor
		// of setup traffic that swamps the difference.
		expect(one.count).toBeLessThan(10);
	}, 60_000);

	it('reads the pre-images of a batch as one wave and commits its transform-added children as one insert', async () => {
		const one = await dynamicWaves(1);
		const fifty = await dynamicWaves(50);

		// The root pre-images are one wave (RFC §5.3): one query for one root and one for fifty.
		expect(one.waves).toHaveLength(1);
		expect(fifty.waves).toHaveLength(1);
		expect(one.waves.map((statement) => statement.match(/\$\d+/g)?.length)).toEqual([2]);
		expect(fifty.waves.map((statement) => statement.match(/\$\d+/g)?.length)).toEqual([100]);
		expect(fifty.waves[0]).toContain('join "notes" as record');
		// One wave plus one transaction, whatever N is; the fifty children are one insert.
		expect(fifty.calls).toBe(one.calls);
		expect(one.entryInserts).toBe(1);
		expect(fifty.entryInserts).toBe(1);
	}, 60_000);
});
