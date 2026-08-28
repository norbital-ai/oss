import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { defineConnection } from '../../src/authoring/index.js';
import {
	app,
	collection,
	defineSend,
	field,
	policy,
	workspace,
	type WorkspaceDefinition
} from '../../src/authoring/workspace-schema.js';
import { describeIntegrations } from '../../src/authoring/integration-introspection.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * A batch the subject may write only part of, and what the other part must not become.
 *
 * A create's row predicate is a `where` on the insert, so a row it refuses matches nothing and
 * writes nothing while the rest of the batch commits — that is the documented batch semantic and it
 * is not what is under test here. What is under test is what the runtime then *says* about the row
 * that was refused. It used to answer with the payload the caller had submitted, dressed as a stored
 * record, and everything downstream believed it: `create.after` ran holding a record that does not
 * exist, and a change trigger was enqueued carrying that non-record as `incoming_record`. A refused
 * write is not a quiet write; nothing in the workspace may act as though it happened.
 *
 * Nothing covered the mixed batch. A batch where every row is permitted cannot see this, and one
 * where every row is refused cannot either — the fabrication is only visible where the two sit side
 * by side and the permitted rows still have to behave exactly as they always did.
 */

/**
 * A quota, expressed the way an authored policy expresses one.
 *
 * The predicate has to depend on something that changes *between* rows of the same batch, or every
 * row in it is decided identically and there is no mixed batch to test. A grant's `where` is
 * compiled per subject, not per row, so the row-varying part has to be in the data: this one counts
 * what the collection already holds, and the count is re-evaluated for each insert inside the
 * transaction. The first two rows of a batch are written and every row after them is refused.
 */
const workspaceWith = (integrations: WorkspaceDefinition['integrations']): WorkspaceDefinition =>
	workspace({
		name: 'refused-readback',
		version: '1.0.0',
		collections: [
			collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
		],
		apps: [app({ name: 'refused', label: 'Refused' })],
		teams: { writers: ['note-quota'] },
		automations: [],
		integrations,
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		envoys: [],
		requiredFacilities: [],
		policies: [
			policy({
				name: 'note-quota',
				effect: 'allow',
				grants: [
					{
						collection: 'notes',
						action: 'create',
						where: { $sql: '(select count(*) from notes) < 2' }
					},
					{ collection: 'notes', action: 'read' },
					{ collection: 'notes', action: 'update' }
				]
			})
		]
	});

const definition = workspaceWith([]);

/** A member of `writers`; its explicit policy is the only source of authority under test. */
const writer = { userId: 'writer-1', tenantId: 'test-tenant', policies: [], teamPath: ['writers'] };

/** Every record an `after` hook was handed, in the order the hooks happened to finish. */
const afterRecords: Array<Readonly<Record<string, unknown>> | undefined> = [];

const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		notes: {
			mutate: {
				perRecord: {
					after: {
						description: 'records which written row it was handed',
						handler: (context: unknown) => {
							if (Reflect.get(context as object, 'previous') !== undefined) return undefined;
							afterRecords.push(
								(context as { readonly record?: Readonly<Record<string, unknown>> }).record
							);
							return undefined;
						}
					}
				}
			}
		}
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

let harness: BoltTestRuntime | undefined;
beforeEach(() => {
	afterRecords.length = 0;
});
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** The `incoming_record` of every change task the write enqueued, by the field the payload carried. */
const enqueuedBodies = async (runtime: BoltTestRuntime): Promise<ReadonlyArray<string>> => {
	const tasks = await runtime.database.query(
		'select input from bolt_task where command = $1 order by effect_id',
		['automations.on_note']
	);
	return tasks.map((task) => {
		const input = task['input'] as { readonly scope?: { readonly incoming_record?: unknown } };
		const record = input.scope?.incoming_record as Record<string, unknown> | undefined;
		return String(record?.['body']);
	});
};

const bodiesOf = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): ReadonlyArray<string> =>
	rows.map((row) => String(row['body'])).toSorted();

describe('a batch the subject may write only part of', () => {
	it('runs a single-record change trigger only as its declared automation authority', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(EffectId.make('single-authority'), writer, {
					collection: 'notes',
					id: '10000000-0000-4000-8000-000000000001',
					values: { body: 'one note' }
				});
			})
		);

		const [task] = await harness.database.query('select input from bolt_task where command = $1', [
			'automations.on_note'
		]);
		const input = task?.['input'] as { readonly bolt_run_as?: unknown } | undefined;
		expect(input?.bolt_run_as).toEqual({
			userId: 'automation:on_note',
			tenantId: 'test-tenant',
			teamPath: [],
			policies: ['automation-data'],
			admin: false
		});
		expect(input?.bolt_run_as).not.toEqual(writer);
	}, 60_000);

	it('answers with the rows that were stored and acts on no others', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		const written = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(EffectId.make('refused-1'), writer, 'notes', [
					{ body: 'note 0' },
					{ body: 'note 1' },
					{ body: 'note 2' },
					{ body: 'note 3' }
				]);
			})
		);

		// The quota admitted two of the four. Read from the table rather than from the answer, so the
		// rest of this test is checked against what is actually stored and not against its own claim.
		const stored = await harness.database.query('select body from notes');
		expect(bodiesOf(stored)).toEqual(['note 0', 'note 1']);

		// The answer is the stored rows and nothing else. Two, not four — and the refused bodies are
		// not among them under any guise.
		expect(bodiesOf(written)).toEqual(['note 0', 'note 1']);
		// A stored row, not the submission wearing its shape: `row_version` is a column the
		// database fills, and no payload here carries one. Without it this test would still pass on a
		// fabrication that merely got the count right.
		for (const row of written) expect(row['row_version']).toBe(1);

		// The hook that must not run for a record that does not exist.
		expect(bodiesOf(afterRecords.filter((record) => record !== undefined))).toEqual([
			'note 0',
			'note 1'
		]);
		// And it was never handed an empty slot either — a hook receiving `undefined` as its record is
		// the same defect wearing a different mask.
		expect(afterRecords.filter((record) => record === undefined)).toHaveLength(0);

		// The change trigger fired for the two records that exist, carrying each as `incoming_record`,
		// and for neither of the two that do not.
		expect((await enqueuedBodies(harness)).toSorted()).toEqual(['note 0', 'note 1']);
		const tasks = await harness.database.query(
			'select input from bolt_task where command = $1 order by effect_id',
			['automations.on_note']
		);
		for (const task of tasks) {
			const input = task['input'] as { readonly bolt_run_as?: unknown };
			expect(input.bolt_run_as).toEqual({
				userId: 'automation:on_note',
				tenantId: 'test-tenant',
				teamPath: [],
				policies: ['automation-data'],
				admin: false
			});
			expect(input.bolt_run_as).not.toEqual(writer);
		}
	}, 60_000);

	it('fails a nonexistent update instead of treating the patch as an omitted row', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					const created = yield* collections.mutate(EffectId.make('refused-2'), writer, 'notes', [
						{ body: 'kept' }
					]);
					const id = created[0]?.['id'];
					// One update that lands and one that cannot: the second names an id no row carries, so
					// its statement matches nothing, exactly as a refused insert does.
					return yield* collections.mutate(EffectId.make('refused-3'), writer, 'notes', [
						{ id: String(id), body: 'kept, edited' },
						{ id: '00000000-0000-4000-8000-000000000000', body: 'never existed' }
					]);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(Collections.unwrapMutationPhase(outcome.failure)).toMatchObject({
				message: expect.stringContaining('changed after update authorization')
			});
		expect(bodiesOf(await harness.database.query('select body from notes'))).toEqual([
			'kept, edited'
		]);
	}, 60_000);
});

/**
 * The same lie, in the authoring API, where it must be refused rather than dropped.
 *
 * The authored mutation create path used to end `row ?? { id: id, ...values }` exactly as the
 * batch path did.
 * The batch path now omits a refused row and proceeds, because a batch legitimately has others; here
 * an authored hook asked for one record and the very next line it runs will use what comes back, so
 * answering `undefined` would only move the fabrication into the workspace's own code. It refuses.
 *
 * Driven through a hook rather than through the service, because `api.db.notes.mutate` is the
 * authoring surface. An input without an id is its canonical create form. The quota is already full
 * by the time the inner mutation runs, so the predicate declines the insert and nothing is stored —
 * which is the way this is actually reached, not a fault injected to reach it.
 */
describe('an authored create the predicate refused', () => {
	it('refuses rather than answering the values it was handed', async () => {
		let innerAnswer: unknown = 'hook did not run';
		const authoredInner = {
			...emptyAuthoredRuntime,
			hooks: {
				notes: {
					mutate: {
						perRecord: {
							before: {
								description: 'creates a second note through the authored mutation api',
								handler: (context: unknown, api: unknown) =>
									Effect.gen(function* () {
										const input = (context as { readonly input: Record<string, unknown> }).input;
										if (Reflect.get(context as object, 'existing') !== undefined) return input;
										const notes = (api as { readonly db: Record<string, Record<string, Function>> })
											.db['notes'];
										const mutate = notes?.['mutate'];
										if (typeof mutate !== 'function')
											return yield* Effect.die('notes.mutate is unavailable');
										innerAnswer = yield* (mutate as (v: unknown) => Effect.Effect<unknown>)({
											body: 'inner'
										}).pipe(Effect.result);
										return input;
									})
							}
						}
					}
				}
			}
		} as unknown as typeof authored;

		harness = await makeBoltTestRuntime(definition, { authored: authoredInner });
		const collections = await harness.runtime.runPromise(Collections.Service);

		// Two through the ordinary path fills the quota; each one's hook also attempts an inner
		// create, so by the second the inner one is the write the predicate declines.
		await harness.runtime.runPromise(
			collections
				.mutate(EffectId.make('inner-1'), writer, 'notes', [
					{ body: 'a' },
					{ body: 'b' },
					{ body: 'c' }
				])
				.pipe(Effect.result)
		);

		expect(innerAnswer).toMatchObject({ _tag: 'Failure' });
	});
});

/**
 * The rows that describe a record, for a record that was never written.
 *
 * The refusal is a `where` on the insert, and for a while it was a `where` on *only* the insert:
 * the history entry, the sync outbox entry and the integration deliveries were plain inserts sitting
 * behind it in the same transaction and ran whatever the predicate decided. So a refused row still
 * left a `create` in the sync log — which a replica applies, giving every client a record the
 * database does not have — and a pending delivery, which the next flush hands to a partner over the
 * wire. The record is the only thing that was refused; everything that speaks on its behalf was not.
 *
 * Asserted against the three tables directly rather than through the runtime's answer, because the
 * runtime's answer is the half that was already fixed. This is the transaction itself.
 */
describe('what a refused row must leave in the bookkeeping tables', () => {
	/** A binding that would deliver every created note, so a phantom create becomes a phantom send. */
	const described = describeIntegrations({
		notes: {
			partner: {
				policies: [],
				connection: defineConnection({ baseUrl: 'https://integration.invalid' }),
				send: {
					note_created: defineSend<{ readonly id: string; readonly body: string }>({
						send: { method: 'POST', path: '/notes' },
						on: 'create',
						body: ({ record }) => ({ body: record.body })
					})
				}
			}
		}
	});

	it('writes history, sync and delivery rows for the stored records only', async () => {
		harness = await makeBoltTestRuntime(workspaceWith(described.declarations), {
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(EffectId.make('bookkeeping-1'), writer, 'notes', [
					{ body: 'note 0' },
					{ body: 'note 1' },
					{ body: 'note 2' },
					{ body: 'note 3' }
				]);
			})
		);

		// What is actually there, and what every table below has to agree with — two of the four.
		const stored = await harness.database.query('select id, body from notes');
		expect(bodiesOf(stored)).toEqual(['note 0', 'note 1']);
		const storedIds = stored.map((row) => String(row['id'])).toSorted();

		// The sync log. A row here for a refused record is a `create` every replica applies.
		const sync = await harness.database.query(
			'select record_id, after_record from bolt_sync_outbox where collection_name = $1',
			['notes']
		);
		expect(sync.map((row) => String(row['record_id'])).toSorted()).toEqual(storedIds);
		expect(bodiesOf(sync.map((row) => row['after_record'] as Record<string, unknown>))).toEqual([
			'note 0',
			'note 1'
		]);

		// History. The snapshot of a create that did not happen is a version of a record that has none.
		const history = await harness.database.query(
			'select record_id from bolt_collection_history where collection_name = $1 and operation = $2',
			['notes', 'create']
		);
		expect(history.map((row) => String(row['record_id'])).toSorted()).toEqual(storedIds);

		// The deliveries. This is the one that leaves the process: a pending row here is a request the
		// next flush makes to a partner about a record the tenant never created.
		const deliveries = await harness.database.query(
			'select record_id from bolt_integration_outbox where collection_name = $1',
			['notes']
		);
		expect(deliveries.map((row) => String(row['record_id'])).toSorted()).toEqual(storedIds);
	}, 60_000);

	/**
	 * The other half, and the reason the guard is the row's existence and not a second copy of the
	 * predicate.
	 *
	 * Bookkeeping is written after every record of the batch, so a predicate that reads the collection
	 * it guards — this quota reads `count(*)` — no longer answers the same way it did for the insert:
	 * by then the quota is full and re-asking it refuses the rows that were written. A batch that is
	 * entirely permitted is where that mistake shows, because there is nothing else to blame for the
	 * missing rows.
	 */
	it('keeps the bookkeeping of a batch the predicate allowed in full', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(EffectId.make('bookkeeping-2'), writer, 'notes', [
					{ body: 'note 0' },
					{ body: 'note 1' }
				]);
			})
		);

		expect(bodiesOf(await harness.database.query('select body from notes'))).toEqual([
			'note 0',
			'note 1'
		]);
		const sync = await harness.database.query(
			'select after_record from bolt_sync_outbox where collection_name = $1',
			['notes']
		);
		expect(bodiesOf(sync.map((row) => row['after_record'] as Record<string, unknown>))).toEqual([
			'note 0',
			'note 1'
		]);
		const history = await harness.database.query(
			'select snapshot from bolt_collection_history where collection_name = $1 and operation = $2',
			['notes', 'create']
		);
		expect(bodiesOf(history.map((row) => row['snapshot'] as Record<string, unknown>))).toEqual([
			'note 0',
			'note 1'
		]);
	}, 60_000);
});
