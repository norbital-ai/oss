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
import { automation } from '../../src/authoring/automations-schema.js';
import { authoredHooks, type CollectionHooks } from '../../src/authoring/contracts-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { unwrapMutationPhase } from '../support/mutation-phase.js';

/** The fixture as a schema, so the hooks are typed the way a compiled workspace's are. */
interface RefusedReadbackSchema {
	readonly tables: {
		readonly notes: {
			readonly $inferSelect: { readonly id: string; readonly body: string };
			readonly $inferInsert: { readonly id?: string; readonly body: string };
		};
	};
	readonly relations: Record<string, never>;
}

/**
 * A create the subject's predicate refuses is a loud refusal, not a quiet omission.
 *
 * The create's row predicate is asserted in the same transaction that inserts the row: the
 * candidate is written first and `bolt_assert` then proves its stored row against the predicate,
 * so a refused row raises and rolls the whole graph back. Nothing in the workspace may act as
 * though a refused write happened — no `after` hook, no change trigger, no history, sync or
 * delivery row — and the caller is told, not answered with a partial batch.
 *
 * The refusal is a mutation authorization over the prepared row. Aggregate quotas do not belong in
 * opaque read predicates: production limits use the policy limit surface, while row-local business
 * decisions use this explicit authorization seam.
 */
const NOTE_CREATE_AUTHORIZATION = 'note-quota:notes:create:authorize';

const authorizeUnlessBody = (refusedBody: string) => (context: unknown): boolean => {
	const record =
		typeof context === 'object' && context !== null ? Reflect.get(context, 'record') : undefined;
	return (
		typeof record === 'object' &&
		record !== null &&
		Reflect.get(record, 'body') !== refusedBody
	);
};

const workspaceWith = (
	integrations: WorkspaceDefinition['integrations']
): WorkspaceDefinition =>
	workspace({
		name: 'refused-readback',
		version: '1.0.0',
		collections: [
			collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
		],
		apps: [app({ name: 'refused', label: 'Refused' })],
		teams: { writers: ['note-quota'] },
		automations: [
			automation({
				name: 'on_note',
				trigger: { _tag: 'Change', collection: 'notes', event: 'created' },
				command: 'on_note',
				policies: []
			})
		],
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
						authorization: { id: NOTE_CREATE_AUTHORIZATION, live: true }
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

/** The `incoming_record` body of every change-trigger the write announced, in run order. */
const changeBodies: Array<string> = [];

/**
 * The authoring api surface the change automation's read probe reaches, nominal shape only — the
 * runtime hands the live api and the handler only reflects what it needs off it.
 */
interface AutomationApi {
	readonly db: Readonly<{
		readonly notes: Readonly<{
			readonly findMany: (
				input?: Readonly<Record<string, unknown>> | undefined
			) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>;
		}>;
	}>;
}

/**
 * A read the automation's own authority cannot perform unless it holds the writer's grants.
 *
 * The writer holds `note-quota` (notes read included); the declared automation names no policy at
 * all. A probe that is `denied` therefore proves the turn ran under the declared automation
 * identity rather than inherited the caller's.
 */
const changeProbe = (api: unknown): Effect.Effect<'denied' | 'allowed'> =>
	(api as AutomationApi).db.notes.findMany({}).pipe(
		Effect.match({
			onFailure: () => 'denied' as const,
			onSuccess: () => 'allowed' as const
		})
	);

const noteHooks: CollectionHooks<RefusedReadbackSchema, 'notes'> = {
	mutate: {
		perRecord: {
			after: {
				description: 'records which written row it was handed',
				handler: ({ previous, record }) => {
					if (previous !== undefined) return undefined;
					afterRecords.push(record);
					return undefined;
				}
			}
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: {
		[NOTE_CREATE_AUTHORIZATION]: authorizeUnlessBody('forbidden')
	},
	hooks: { notes: authoredHooks(noteHooks) },
	automations: {
		on_note: {
			name: 'on_note',
			policies: [],
			trigger: { _tag: 'Change' as const, collection: 'notes', event: 'created' as const },
			handler: (api: unknown, context: unknown) => {
				const scope =
					typeof context === 'object' && context !== null
						? Reflect.get(context, 'scope')
						: undefined;
				const incoming =
					typeof scope === 'object' && scope !== null
						? Reflect.get(scope, 'incoming_record')
						: undefined;
				if (typeof incoming === 'object' && incoming !== null)
					changeBodies.push(String(Reflect.get(incoming, 'body')));
				return changeProbe(api);
			}
		}
	}
};

let harness: BoltTestRuntime | undefined;
beforeEach(() => {
	afterRecords.length = 0;
	changeBodies.length = 0;
});
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const bodiesOf = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): ReadonlyArray<string> =>
	rows.map((row) => String(row['body'])).toSorted();

/** The failure a mutation phase wrapped, for asserting on the message the caller actually sees. */
const refusalMessage = (failure: unknown): string => {
	const cause = unwrapMutationPhase(failure);
	return cause instanceof Error ? cause.message : String(cause);
};

describe('a batch the subject may write only part of', () => {
	it('runs a single-record change trigger only as its declared automation authority', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.mutate(
					EffectId.make('single-authority'),
					writer,
					'notes',
					[{ id: '10000000-0000-4000-8000-000000000001', body: 'one note' }],
					false,
					0,
					{
						root: { id: '10000000-0000-4000-8000-000000000001', action: 'create' }
					}
				);
			})
		);

		// The change trigger answered the row it was told about, and its run row settled as a direct
		// automation run — the durable half of the old `bolt_task` lifecycle row.
		expect(changeBodies).toEqual(['one note']);
		const [run] = await harness.database.query(
			'select status, result from automation_run where name = $1',
			['on_note']
		);
		expect(run).toMatchObject({ status: 'done' });
		// The declared automation names no policy, so it holds no notes read — a probe its api
		// performs is denied, which is exactly what an inherited writer authority would not deny.
		expect(String(run?.['result'])).toContain('denied');
	}, 60_000);

	it('refuses a batch its mutation authorization cannot fully admit, loudly, and stores nothing', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.mutate(EffectId.make('refused-1'), writer, 'notes', [
						{ body: 'note 0' },
						{ body: 'note 1' },
						{ body: 'forbidden' },
						{ body: 'note 3' }
					]);
				})
			)
		);

		// The refusal is loud: the post-insert guard raises inside the transaction and the whole
		// batch rolls back with it.
		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(refusalMessage(outcome.failure)).toContain('authorization');

		// Nothing was stored, and nothing acted as though it were: no hook, no change trigger run.
		expect(await harness.database.query('select body from notes')).toEqual([]);
		expect(afterRecords).toEqual([]);
		expect(changeBodies).toEqual([]);
	}, 60_000);

	it('denies a single create the predicate refuses, with the guard message', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					// Two separate writes satisfy the row-local decision.
					yield* collections.mutate(EffectId.make('denied-1'), writer, 'notes', [
						{ body: 'note 0' }
					]);
					yield* collections.mutate(EffectId.make('denied-2'), writer, 'notes', [
						{ body: 'note 1' }
					]);
					// The third is refused on its own, loudly.
					return yield* collections.mutate(EffectId.make('denied-3'), writer, 'notes', [
						{ body: 'forbidden' }
					]);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(refusalMessage(outcome.failure)).toContain('authorization');

		const stored = await harness.database.query('select body, row_version from notes');
		expect(bodiesOf(stored)).toEqual(['note 0', 'note 1']);
		for (const row of stored) expect(row['row_version']).toBe(1);
		expect(afterRecords.map((record) => String(record?.['body'])).toSorted()).toEqual([
			'note 0',
			'note 1'
		]);
		expect(changeBodies.toSorted()).toEqual(['note 0', 'note 1']);
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
					const id = created.records[0]?.['id'];
					// One update that lands and one that cannot: the second names an id no row carries, so
					// its preparation cannot read a pre-image and the whole transaction never opens.
					return yield* collections.mutate(EffectId.make('refused-3'), writer, 'notes', [
						{ id: String(id), body: 'kept, edited' },
						{ id: '00000000-0000-4000-8000-000000000000', body: 'never existed' }
					]);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(refusalMessage(outcome.failure)).toContain('no longer exists');
		// The batch is atomic: the update that could have landed rolls back with the one that could not.
		expect(bodiesOf(await harness.database.query('select body from notes'))).toEqual(['kept']);
	}, 60_000);
});

/**
 * The same refusal, for a create a hook issued.
 *
 * A `before` hook's write is planned into the graph that issued it — it does not reach the database
 * early — so the row a hook asks for is asserted by the same post-insert guard as every other row,
 * in the same transaction. When the predicate refuses it, the refusal is loud and the whole graph
 * rolls back: the hook's write did not happen, and neither did the write that issued it.
 *
 * Driven through a hook rather than through the service, because `api.db.notes.mutate` is the
 * authoring surface. An input without an id is its canonical create form. The hook issues one more
 * create than the quota admits, so the guard declines a row the graph carried — which is the way
 * this is actually reached, not a fault injected to reach it.
 */
describe('an authored create the predicate refused', () => {
	it('rolls the whole graph back loudly instead of storing the hook-issued row', async () => {
		const innerHooks: CollectionHooks<RefusedReadbackSchema, 'notes'> = {
			mutate: {
				perRecord: {
					before: {
						description: 'issues one extra create through the authored mutation api',
						handler: ({ input, existing, api }) =>
							Effect.gen(function* () {
								if (existing !== undefined) return input;
								// Only the write that opened the graph issues the extra one. A staged create
								// runs this hook too, so an unguarded issue enqueues itself until the host's
								// nesting bound stops it and the guard under test is never reached.
								if (input.body === 'inner') return input;
								yield* api.db.notes.mutate({ body: 'inner' });
								return input;
							})
					}
				}
			}
		};
		const authoredInner = {
			...emptyAuthoredRuntime,
			policyAuthorizations: {
				[NOTE_CREATE_AUTHORIZATION]: authorizeUnlessBody('inner')
			},
			hooks: { notes: authoredHooks(innerHooks) }
		};

		harness = await makeBoltTestRuntime(workspaceWith([]), { authored: authoredInner });
		const collections = await harness.runtime.runPromise(Collections.Service);

		// The outer row is admitted and the hook-issued `inner` row is not: the refusal takes the
		// issuing write down with it.
		const outcome = await harness.runtime.runPromise(
			collections
				.mutate(EffectId.make('inner-1'), writer, 'notes', [{ body: 'outer' }])
				.pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(refusalMessage(outcome.failure)).toContain('authorization');
		expect(await harness.database.query('select body from notes')).toEqual([]);
	});
});

/**
 * The rows that describe a record, for a record that was never written.
 *
 * The refusal is loud and the transaction is atomic, so a refused write leaves nothing behind: no
 * `create` in the sync log for any later reader to apply, no pending delivery, no history entry.
 * Everything that speaks on a record's behalf is written in the same transaction as the record and
 * rolls back with it.
 *
 * Asserted against the tables directly rather than through the runtime's answer, because the
 * runtime's answer is the half the refusal itself already settles. This is the transaction itself.
 */
describe('what a refused row must leave in the bookkeeping tables', () => {
	/** A binding that would deliver every created note, so a phantom create would be a phantom send. */
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

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.mutate(EffectId.make('bookkeeping-1'), writer, 'notes', [
						{ body: 'note 0' },
						{ body: 'note 1' },
						{ body: 'forbidden' },
						{ body: 'note 3' }
					]);
				})
			)
		);
		expect(outcome._tag).toBe('Failure');

		// The refusal is the whole batch, so the tables hold nothing — and there is no phantom row in
		// any of them for a reader, a partner or an audit to trip over.
		expect(await harness.database.query('select id, body from notes')).toEqual([]);
		const sync = await harness.database.query(
			'select collection_name from bolt_sync_outbox where collection_name = $1',
			['notes']
		);
		expect(sync).toEqual([]);
		const history = await harness.database.query(
			'select record_id from bolt_collection_history where collection_name = $1 and operation = $2',
			['notes', 'create']
		);
		expect(history).toEqual([]);
		const deliveries = await harness.database.query(
			'select record_id from bolt_integration_outbox where collection_name = $1',
			['notes']
		);
		expect(deliveries).toEqual([]);
	}, 60_000);

	/**
	 * The bookkeeping of a batch every row survives.
	 *
	 * Bookkeeping is written after every record of the batch under the row's own existence, so a
	 * row-dependent predicate that stays true for the whole batch still finds every row and every
	 * entry it owes: history, sync and deliveries for two stored records, and none for a third the
	 * caller never sent.
	 */
	it('keeps the bookkeeping of a batch the predicate allowed in full', async () => {
		const admitted = workspaceWith(described.declarations);
		harness = await makeBoltTestRuntime(admitted, {
			authored: { ...authored, integrations: described.authored }
		});

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(EffectId.make('bookkeeping-2'), writer, 'notes', [
					{ body: 'note 0' },
					{ body: 'note 1' }
				]);
			})
		);

		const stored = await harness.database.query('select id, body from notes');
		expect(bodiesOf(stored)).toEqual(['note 0', 'note 1']);
		const storedIds = stored.map((row) => String(row['id'])).toSorted();
		// The changelog rows are written by the collection's sync trigger, one per row the insert
		// wrote, inside the same transaction.
		const sync = await harness.database.query(
			'select collection_name from bolt_sync_outbox where collection_name = $1',
			['notes']
		);
		expect(sync).toHaveLength(storedIds.length);
		const history = await harness.database.query(
			'select record_id from bolt_collection_history where collection_name = $1 and operation = $2',
			['notes', 'create']
		);
		expect(history.map((row) => String(row['record_id'])).toSorted()).toEqual(storedIds);
		const deliveries = await harness.database.query(
			'select record_id from bolt_integration_outbox where collection_name = $1',
			['notes']
		);
		expect(deliveries.map((row) => String(row['record_id'])).toSorted()).toEqual(storedIds);
	}, 60_000);
});
