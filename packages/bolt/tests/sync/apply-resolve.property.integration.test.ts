import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SyncAdvanceUpdate,
	type StoredRecord,
	type SyncAdvanceSubscription,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { field } from '../../src/authoring/workspace-schema.js';
import { applyPrefixDelta } from '../../src/client/live-query/project.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import {
	advanceActivePrefix,
	resolveInitialPrefix
} from '../../src/runtime/sync/delta-engine.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

const workspace = testWorkspace({
	collections: [
		{
			name: 'people',
			fields: {
				name: field.string({ required: true }),
				team: field.string(),
				seq: field.number()
			}
		}
	]
});

const mulberry32 =
	(seed: number): (() => number) =>
	() => {
		seed = (seed + 0x6d2b79f5) | 0;
		let state = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state;
		return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
	};

const pick = <T>(random: () => number, values: ReadonlyArray<T>): T =>
	values[Math.floor(random() * values.length)] as T;

const integer = (random: () => number, maximum: number): number =>
	Math.floor(random() * maximum);

type WriteOperation =
	| Readonly<{ readonly kind: 'insert' }>
	| Readonly<{ readonly kind: 'update'; readonly id: string }>
	| Readonly<{ readonly kind: 'delete'; readonly id: string }>;

const nextOperation = (
	random: () => number,
	ids: ReadonlyArray<string>
): WriteOperation => {
	const roll = random();
	if (ids.length === 0 || roll < 0.35) return { kind: 'insert' };
	return roll < 0.8
		? { kind: 'update', id: pick(random, ids) }
		: { kind: 'delete', id: pick(random, ids) };
};

const commitWrite = (
	harness: BoltTestRuntime,
	random: () => number,
	operation: WriteOperation,
	step: number
) =>
	Effect.gen(function* () {
		const collections = yield* Collections.Service;
		if (operation.kind === 'insert')
			return yield* collections.mutate(
				harness.effectId(`insert:${step}`),
				adminSubject,
				'people',
				[
					{
						name: `person-${step}-${integer(random, 100)}`,
						team: pick(random, ['core', 'edge']),
						seq: integer(random, 20)
					}
				],
				false,
				0
			);
		if (operation.kind === 'update')
			return yield* collections.mutate(
				harness.effectId(`update:${step}`),
				adminSubject,
				'people',
				[
					random() < 0.5
						? { id: operation.id, seq: integer(random, 20) }
						: {
								id: operation.id,
								name: `renamed-${step}-${integer(random, 100)}`,
								team: pick(random, ['core', 'edge'])
							}
				],
				false,
				0
			);
		return yield* collections.delete(
			harness.effectId(`delete:${step}`),
			adminSubject,
			'people',
			operation.id
		);
	});

type QueryState = {
	readonly input: SyncQueryInput;
	rows: ReadonlyArray<StoredRecord>;
	state: SyncAdvanceSubscription;
};

const SyncSelectedColumns = Schema.Record(Schema.String, Schema.Boolean);

const toFindManyInput = (input: SyncQueryInput): Collections.QueryInput => {
	const columns =
		input.columns === undefined
			? undefined
			: Schema.decodeUnknownSync(SyncSelectedColumns)(input.columns);
	return {
		collection: input.collection,
		...(input.where === undefined ? {} : { where: input.where }),
		...(input.userFilter === undefined ? {} : { userFilter: input.userFilter }),
		...(input.search === undefined ? {} : { search: input.search }),
		...(input.with === undefined ? {} : { with: input.with }),
		...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
		...(input.kind === 'findFirst'
			? { limit: 1 }
			: input.limit === undefined
				? {}
				: { limit: input.limit }),
		...(columns === undefined ? {} : { columns })
	};
};

const queryRows = (
	harness: BoltTestRuntime,
	input: SyncQueryInput,
	effect: string
) =>
	harness.runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.findMany(harness.effectId(effect), adminSubject, toFindManyInput(input))
		)
	);

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('sync engine property: apply(delta) equals fresh query', () => {
	it('holds across deterministic insert, update, move, filter and delete batches', async () => {
		const h = await makeBoltTestRuntime(workspace);
		harness = h;
		const random = mulberry32(0x5eed2026);
		const seeded = await h.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.mutate(
					h.effectId('seed'),
					adminSubject,
					'people',
					Array.from({ length: 24 }, (_, index) => ({
						name: `person-${index.toString().padStart(2, '0')}`,
						team: index % 3 === 0 ? 'edge' : 'core',
						seq: (index * 7) % 20
					})),
					false,
					0
				)
			)
		);
		const liveIds = new Set(
			seeded.records.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []))
		);
		const inputs: ReadonlyArray<SyncQueryInput> = [
			{
				kind: 'findMany',
				collection: 'people',
				orderBy: { seq: 'asc' },
				limit: 8
			},
			{
				kind: 'findMany',
				collection: 'people',
				where: { team: { eq: 'core' } },
				orderBy: { seq: 'desc', name: 'asc' },
				limit: 5
			},
			{
				kind: 'findFirst',
				collection: 'people',
				where: { team: { eq: 'edge' } },
				orderBy: { name: 'asc' }
			},
			{
				kind: 'findMany',
				collection: 'people',
				where: { AND: [{ seq: { gte: 4 } }, { seq: { lte: 15 } }] },
				orderBy: { name: 'desc' },
				limit: 6
			}
		];
		const states: Array<QueryState> = [];
		for (const [index, input] of inputs.entries()) {
			const requested = input.kind === 'findFirst' ? 1 : (input.limit ?? 100);
			const initial = await h.runtime.runPromise(
				resolveInitialPrefix(h.effectId(`open:${index}`), adminSubject, input, requested)
			);
			states.push({
				input,
				rows: initial.rows,
				state: {
					subId: `plan-${index}`,
					input,
					planKey: initial.plan.effectivePlan.fingerprint,
					version: 0,
					prefixKeys: initial.keys,
					prefixBytes: initial.retainedBytes,
					viewerPrefixes: [initial.rows.length],
					credential: 'host-opaque',
					authorityFingerprint: initial.plan.effectivePlan.authority.fingerprint
				}
			});
		}

		for (let step = 0; step < 40; step += 1) {
			const operation = nextOperation(random, [...liveIds]);
			const committed = await h.runtime.runPromise(commitWrite(h, random, operation, step));
			const writtenId = committed.records[0]?.['id'];
			if (operation.kind === 'insert' && typeof writtenId === 'string') liveIds.add(writtenId);
			if (operation.kind === 'delete') liveIds.delete(operation.id);

			for (const [index, query] of states.entries()) {
				const update = await h.runtime.runPromise(
					advanceActivePrefix(
						h.effectId(`advance:${step}:${index}`),
						adminSubject,
						query.state,
						committed.batch
					)
				);
				if (update !== undefined) {
					Schema.decodeUnknownSync(SyncAdvanceUpdate)(update);
					const loadedPrefix = query.state.viewerPrefixes[0] ?? 0;
					const delta = update.deltas.find(
						(candidate) => candidate.loadedPrefix === loadedPrefix
					)?.delta;
					expect(delta).toBeDefined();
					query.rows = applyPrefixDelta(query.rows, delta ?? { removeIds: [], put: [] });
					expect(update.fromVersion).toBe(query.state.version);
					expect(update.toVersion).toBe(query.state.version + 1);
					query.state = {
						...query.state,
						version: update.toVersion,
						prefixKeys: update.prefixKeys,
						prefixBytes: update.prefixBytes,
						authorityFingerprint: update.authorityFingerprint
					};
				}
				const fresh = await queryRows(h, query.input, `fresh:${step}:${index}`);
				expect(query.rows).toEqual(fresh);
			}
		}
	});
});
