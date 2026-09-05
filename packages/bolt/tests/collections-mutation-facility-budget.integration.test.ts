import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { automation } from '../src/authoring/automations-schema.js';
import { authoredHooks, type CollectionHooks } from '../src/authoring/contracts-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/** The simple fixture as a schema, so the hooks are typed the way a compiled workspace's are. */
interface BudgetWriteSchema {
	readonly tables: {
		readonly notes: {
			readonly $inferSelect: { readonly id: string; readonly body: string };
			readonly $inferInsert: { readonly id?: string; readonly body: string };
		};
		readonly write_audit: {
			readonly $inferSelect: { readonly id: string; readonly note_body: string };
			readonly $inferInsert: { readonly id?: string; readonly note_body: string };
		};
	};
	readonly relations: Record<string, never>;
}

/** The dynamic fixture as a schema, with the many edge hooks staged into the next write wave. */
interface DynamicWaveSchema {
	readonly tables: {
		readonly notes: {
			readonly $inferSelect: {
				readonly id: string;
				readonly body: string;
				readonly audit_id: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly body: string;
				readonly audit_id: string;
			};
		};
		readonly note_entries: {
			readonly $inferSelect: {
				readonly id: string;
				readonly note_id: string;
				readonly label: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly note_id: string;
				readonly label: string;
			};
		};
		readonly write_audit: {
			readonly $inferSelect: { readonly id: string; readonly note_body: string };
			readonly $inferInsert: { readonly id?: string; readonly note_body: string };
		};
	};
	readonly relations: {
		readonly notes: {
			readonly note_entries: {
				readonly cardinality: 'many';
				readonly target: 'note_entries';
				readonly column: 'note_id';
				readonly parentColumn: 'id';
			};
		};
	};
}

/**
 * Both per-row costs are declared, or the measurement is of a path that never ran.
 *
 * `mutate.after` forces a second read of a row that was just read back, and a
 * change trigger forces a third read plus an enqueue. A collection with neither
 * exercises none of it — `emitChangeEvents` returns immediately when no automation watches the
 * collection — so a fixture without them would pass this test no matter what the pipeline does.
 */
const auditStagingHooks: CollectionHooks<BudgetWriteSchema, 'notes'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'stages one audit write in the next write wave',
				handler: (context) => {
					if (context.existing !== undefined) return context.input;
					return context.api.db.write_audit
						.mutate([{ note_body: context.input.body }])
						.pipe(Effect.as(context.input));
				}
			},
			after: { description: 'observe the written row', handler: () => undefined }
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	hooks: { notes: authoredHooks(auditStagingHooks) },
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
 * second read of the same row for its `after` hook, and a read-plus-enqueue per row for its
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

const dynamicAuthored = {
	...emptyAuthoredRuntime,
	hooks: {
		notes: authoredHooks<DynamicWaveSchema, 'notes'>({
			mutate: {
				perRecord: {
					before: {
						description: 'adds a relationship graph and stages an explicit-id update',
						handler: (context) => {
							const { input, api } = context;
							const auditId = input.audit_id;
							if (typeof auditId !== 'string') throw new Error('note audit id is missing');
							const body = input.body;
							if (typeof body !== 'string') throw new Error('note body is missing');
							return api.db.write_audit.mutate([{ id: auditId, note_body: body }]).pipe(
								Effect.as({
									...input,
									note_entries: [{ label: `entry ${body}` }]
								})
							);
						}
					}
				}
			}
		})
	}
};

const dynamicDefinition = workspace({
	name: 'dynamic-write-waves',
	version: '1.0.0',
	collections: [
		collection({
			name: 'notes',
			fields: {
				body: field.string({ required: true }),
				audit_id: field.uuid({ required: true })
			}
		}),
		collection({
			name: 'note_entries',
			fields: {
				note_id: field.uuid({ required: true }),
				label: field.string({ required: true })
			}
		}),
		collection({
			name: 'write_audit',
			fields: { note_body: field.string({ required: true }) }
		})
	],
	relations: [
		{
			name: 'note_entries',
			source: 'notes',
			target: 'note_entries',
			cardinality: 'many'
		},
		{
			name: 'entry_note',
			source: 'note_entries',
			target: 'notes',
			cardinality: 'one',
			from: { collection: 'note_entries', column: 'note_id' },
			to: { collection: 'notes', column: 'id' },
			cascade: true
		}
	],
	apps: [app({ name: 'dynamic-write-waves', label: 'Dynamic write waves' })],
	teams: { admin: ['admin-data'] },
	automations: [],
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
				{ collection: 'note_entries', action: 'delete' },
				{ collection: 'write_audit', action: 'read' },
				{ collection: 'write_audit', action: 'update' }
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
): Promise<Readonly<{ count: number; waveQueries: number; legacyFallbacks: number }>> => {
	harness = await makeBoltTestRuntime(definition, { authored });
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				EffectId.make(`budget-${rows}`),
				adminSubject,
				'notes',
				Array.from({ length: rows }, (_, index) => ({ body: `note ${index}` }))
			);
		})
	);
	const count = harness.database.calls.length;
	const waveQueries = harness.database.statements.filter((statement) =>
		statement.includes('__bolt_write_wave_kind')
	).length;
	const legacyFallbacks = harness.database.statements.filter(
		(statement) =>
			statement.includes('__bolt_graph_row_ordinal') ||
			statement.includes('__bolt_relation_ordinal')
	).length;
	await harness.dispose();
	harness = undefined;
	return { count, waveQueries, legacyFallbacks };
};

const dynamicWaveStatements = async (rows: number): Promise<ReadonlyArray<string>> => {
	harness = await makeBoltTestRuntime(dynamicDefinition, { authored: dynamicAuthored });
	const inputs = Array.from({ length: rows }, (_, index) => {
		const suffix = String(index + 1).padStart(12, '0');
		return {
			id: `10000000-0000-4000-8000-${suffix}`,
			audit_id: `20000000-0000-4000-8000-${suffix}`,
			body: `after ${index}`
		};
	});
	for (const input of inputs) {
		await harness.database.query('insert into notes (id, body, audit_id) values ($1, $2, $3)', [
			input.id,
			`before ${input.body}`,
			input.audit_id
		]);
		await harness.database.query('insert into write_audit (id, note_body) values ($1, $2)', [
			input.audit_id,
			'before'
		]);
	}
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				EffectId.make(`dynamic-waves-${rows}`),
				adminSubject,
				'notes',
				inputs
			);
		})
	);
	const statements = harness.database.statements.filter((statement) =>
		statement.includes('__bolt_write_wave_kind')
	);
	await harness.dispose();
	harness = undefined;
	return statements;
};

describe('the facility-call budget of a batched write', () => {
	it('costs the same number of round trips for 50 rows as for 1', async () => {
		const one = await callsToWrite(1);
		const fifty = await callsToWrite(50);

		// Equal, not merely sub-linear. A single extra per-row call would make this 49 apart.
		expect(fifty.count).toBe(one.count);
		expect(one.waveQueries).toBe(1);
		expect(fifty.waveQueries).toBe(1);
		expect(one.legacyFallbacks).toBe(0);
		expect(fifty.legacyFallbacks).toBe(0);
		// And the constant is small enough that the assertion above is not passing on a shared floor
		// of setup traffic that swamps the difference.
		expect(one.count).toBeLessThan(10);
	}, 60_000);

	it('coalesces hook-discovered relationship reads and explicit-id updates by wave', async () => {
		const one = await dynamicWaveStatements(1);
		const fifty = await dynamicWaveStatements(50);

		// Root pre-images, hook-returned relationship memberships, and staged explicit-id updates are
		// three logical waves. Each remains one query when the batch grows from one root to fifty.
		expect(one).toHaveLength(3);
		expect(fifty).toHaveLength(3);
		expect(one.map((statement) => statement.match(/\$\d+/g)?.length)).toEqual([2, 2, 2]);
		expect(fifty.map((statement) => statement.match(/\$\d+/g)?.length)).toEqual([100, 100, 100]);
		expect(fifty[0]).toContain('join "notes" as record');
		expect(fifty[1]).toContain('join "note_entries" as child');
		expect(fifty[2]).toContain('join "write_audit" as record');
		expect(
			fifty.some(
				(statement) =>
					statement.includes('__bolt_graph_row_ordinal') ||
					statement.includes('__bolt_relation_ordinal')
			)
		).toBe(false);
	}, 60_000);
});
