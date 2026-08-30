import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SyncAdvanceUpdate,
	type SyncAdvanceSubscription,
	type SyncAnswer,
	type SyncChange,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy } from '../../src/authoring/workspace-schema.js';
import { applyPatch } from '../../src/client/sync/machine.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { advanceSubscription } from '../../src/runtime/sync/delta-engine.js';
import { contentDigest, heldIdsOf } from '../../src/runtime/sync/digest.js';
import { describeSyncQuery, resolveSyncQuery } from '../../src/runtime/sync/resolver.js';
import {
	TEST_TENANT,
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The DeltaEngine's designated protection (RFC live-query-sync §1.8, §2.3): for random
 * subscriptions and random write batches, applying the engine's patch to the held answer equals a
 * fresh resolve of the same query — and the digest the engine chains equals the digest a fresh
 * resolve computes, byte for byte (§1.3).
 *
 * The property runs over a real Postgres (PGlite) through the same harness every database-backed
 * test uses, so the authoritative resolve, wire patch, digest chain, visibility predicates,
 * masking and ordering all execute together. The filename carries the integration suffix by the
 * suite-split rule: this file boots a database, and the split test refuses database-backed files
 * without it.
 */

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
	],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
		policy({
			name: 'core-reader',
			effect: 'allow',
			grants: [
				{
					collection: 'people',
					action: 'read',
					where: { team: { eq: 'core' } },
					fields: ['name', 'team']
				}
			]
		})
	]
});

/** A subject holding exactly the `core-reader` grant. */
const readerSubject = {
	userId: 'reader-1',
	tenantId: TEST_TENANT,
	teamPath: ['core-reader'],
	policies: []
};

const TEAMS = ['core', 'edge'] as const;

/** Deterministic PRNG — a failing seed reproduces, which is the point of seeding. */
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

const int = (random: () => number, min: number, max: number): number =>
	min + Math.floor(random() * (max - min + 1));

const randomFindMany = (random: () => number): SyncQueryInput => {
	const roll = random();
	const where =
		roll < 0.3
			? { team: { eq: pick(random, TEAMS) } }
			: roll < 0.55
				? { seq: { gte: int(random, 0, 8) } }
				: roll < 0.7
					? { AND: [{ team: { eq: 'core' } }, { seq: { lte: int(random, 2, 9) } }] }
					: undefined;
	const orderBy = pick(random, [
		{ seq: 'asc' } as const,
		{ seq: 'desc' } as const,
		{ name: 'asc' } as const,
		{ seq: 'desc', name: 'asc' } as const
	]);
	const limit = pick(random, [2, 3, 5, 8, undefined]);
	return {
		kind: 'findMany',
		collection: 'people',
		...(where === undefined ? {} : { where }),
		orderBy,
		...(limit === undefined ? {} : { limit })
	};
};

const randomInput = (random: () => number): SyncQueryInput => {
	const roll = random();
	if (roll < 0.72) return randomFindMany(random);
	if (roll < 0.84)
		return {
			kind: 'count',
			collection: 'people',
			...(random() < 0.5 ? { where: { team: { eq: pick(random, TEAMS) } } } : {})
		};
	if (roll < 0.93)
		return {
			kind: 'findFirst',
			collection: 'people',
			where: { team: { eq: pick(random, TEAMS) } },
			orderBy: { seq: 'asc' }
		};
	return { kind: 'findGrouped', collection: 'people', group: { by: 'team' } };
};

type WriteOp =
	| Readonly<{ readonly kind: 'create' }>
	| Readonly<{ readonly kind: 'update'; readonly id: string }>
	| Readonly<{ readonly kind: 'delete'; readonly id: string }>;

const randomWrite = (random: () => number, known: ReadonlyArray<string>): WriteOp => {
	const roll = random();
	if (roll < 0.45 || known.length === 0) return { kind: 'create' };
	return roll < 0.75
		? { kind: 'update', id: pick(random, [...known]) }
		: { kind: 'delete', id: pick(random, [...known]) };
};

const runWrite = (harness: BoltTestRuntime, random: () => number, op: WriteOp, step: number) =>
	Effect.gen(function* () {
		const collections = yield* Collections.Service;
		if (op.kind === 'create') {
			return yield* collections.mutate(
				harness.effectId(`property:create:${step}`),
				adminSubject,
				'people',
				[{ name: `n${step}`, team: pick(random, TEAMS), seq: int(random, 0, 9) }],
				false,
				0
			);
		}
		if (op.kind === 'update') {
			const values = random() < 0.5 ? { seq: int(random, 0, 9) } : { team: pick(random, TEAMS) };
			return yield* collections.mutate(
				harness.effectId(`property:update:${step}`),
				adminSubject,
				'people',
				[{ id: op.id, ...values }],
				false,
				0
			);
		}
		return yield* collections.delete(
			harness.effectId(`property:delete:${step}`),
			adminSubject,
			'people',
			op.id
		);
	});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('delta engine: apply(patches) ≡ resolve(input, subject)', () => {
	it('keeps every applied patch equal to a fresh resolve, and every digest content-derived, across random writes', async () => {
		const h = await makeBoltTestRuntime(workspace);
		harness = h;
		const random = mulberry32(0x5eed2026);

		// Seed a small corpus; the ids the commit returns are the write surface's handles.
		const seeded = await h.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					h.effectId('property:seed'),
					adminSubject,
					'people',
					Array.from({ length: 12 }, (_, index) => ({
						name: `n${index}`,
						team: index % 3 === 0 ? 'edge' : 'core',
						seq: (index * 7) % 10
					})),
					false,
					0
				);
			})
		);
		const knownIds = seeded.records.flatMap((row) => {
			const id = row['id'];
			return typeof id === 'string' ? [id] : [];
		});
		// Only rows the database still holds are write targets: re-targeting a deleted id would
		// test the write path's refusals, which this property does not own.
		const liveIds = new Set<string>(knownIds);

		/**
		 * One round of the property: advance the subscription after a write, resolve the same
		 * query fresh, and demand the two agree — patch application and digest both.
		 */
		const assertRound = async (
			state: SyncAdvanceSubscription,
			base: SyncAnswer,
			subject: typeof adminSubject,
			input: SyncQueryInput,
			step: string
		): Promise<[SyncAnswer, SyncAdvanceUpdate | undefined]> => {
			const update = await h.runtime.runPromise(
				advanceSubscription(h.effectId(`property:advance:${step}`), { state, subject })
			);
			const expected = await h.runtime.runPromise(
				resolveSyncQuery(h.effectId(`property:resolve:${step}`), subject, input)
			);
			const expectedDigest = await contentDigest(expected);
			if (update === undefined) {
				// No patch may mean no change: a silent miss here is the defect class the digest
				// chain exists to catch, so the property refuses it outright.
				expect(expectedDigest).toBe(state.digest);
				return [base, undefined];
			}
			// The update rides the wire: it must decode exactly as the protocol defines it.
			Schema.decodeUnknownSync(SyncAdvanceUpdate)(update);
			const applied = applyPatch(base, update.patch);
			expect(applied).toEqual(expected);
			expect(update.from).toBe(state.digest);
			expect(update.to).toBe(expectedDigest);
			if (!update.digestOnly) expect([...update.heldIds]).toEqual([...heldIdsOf(expected)]);
			return [applied, update];
		};

		/** One chained subscription: the same question, advanced round over round on its own chain. */
		const chainInput: SyncQueryInput = {
			kind: 'findMany',
			collection: 'people',
			orderBy: { seq: 'asc' },
			limit: 3
		};
		const chainDescribed = await h.runtime.runPromise(describeSyncQuery(adminSubject, chainInput));
		const chainAnswer = await h.runtime.runPromise(
			resolveSyncQuery(h.effectId('property:chain:base'), adminSubject, chainInput)
		);
		let chain: SyncAdvanceSubscription = {
			subId: 'chain',
			key: 'chain',
			input: chainInput,
			credential: 'engine-property-test',
			heldIds: heldIdsOf(chainAnswer),
			digestOnly: false,
			digest: await contentDigest(chainAnswer),
			policyHash: chainDescribed.policyHash
		};
		let chainBase: SyncAnswer = chainAnswer;

		for (let round = 0; round < 8; round += 1) {
			const changes: SyncChange[] = [];
			for (let step = 0; step < 1 + int(random, 0, 1); step += 1) {
				const op = randomWrite(random, [...liveIds]);
				const commit = await h.runtime.runPromise(runWrite(h, random, op, round * 10 + step));
				for (const change of commit.changes) changes.push(change);
				for (const record of commit.records) {
					const id = record['id'];
					if (typeof id === 'string' && !knownIds.includes(id)) knownIds.push(id);
				}
				if (op.kind === 'create') {
					const id = commit.records[commit.records.length - 1]?.['id'];
					if (typeof id === 'string') liveIds.add(id);
				}
				if (op.kind === 'delete') liveIds.delete(op.id);
			}
			expect(changes.length).toBeGreaterThan(0);

			// The chained subscription: base and digest come from the previous round's application.
			const [nextBase, chainUpdate] = await assertRound(
				chain,
				chainBase,
				adminSubject,
				chainInput,
				`${round}c`
			);
			chainBase = nextBase;
			if (chainUpdate !== undefined) {
				chain = {
					...chain,
					digest: chainUpdate.to,
					heldIds: [...chainUpdate.heldIds],
					digestOnly: chainUpdate.digestOnly
				};
			}

			// A fresh random subscription each round: random shape, random subject, random policy.
			const subject = random() < 0.5 ? adminSubject : readerSubject;
			const input = randomInput(random);
			const described = await h.runtime.runPromise(describeSyncQuery(subject, input));
			const answer = await h.runtime.runPromise(
				resolveSyncQuery(h.effectId(`property:base:${round}`), subject, input)
			);
			const state: SyncAdvanceSubscription = {
				subId: `random-${round}`,
				key: `random-${round}`,
				input,
				credential: 'engine-property-test',
				heldIds: heldIdsOf(answer),
				digestOnly: false,
				digest: await contentDigest(answer),
				policyHash: described.policyHash
			};
			await assertRound(state, answer, subject, input, `${round}r`);
		}
	});

	it('keeps the window honest for a policy-bound subject: denied rows never enter, revoked rows leave', async () => {
		const h = await makeBoltTestRuntime(workspace);
		harness = h;
		const input: SyncQueryInput = {
			kind: 'findMany',
			collection: 'people',
			orderBy: { seq: 'asc' }
		};
		// Rows the reader's policy admits, so the subscription holds a real window to defend.
		await h.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.mutate(
					h.effectId('policy:seed'),
					adminSubject,
					'people',
					[
						{ name: 'held-a', team: 'core', seq: 1 },
						{ name: 'held-b', team: 'core', seq: 2 }
					],
					false,
					0
				);
			})
		);
		const described = await h.runtime.runPromise(describeSyncQuery(readerSubject, input));
		const answer = await h.runtime.runPromise(
			resolveSyncQuery(h.effectId('policy:base'), readerSubject, input)
		);
		const state: SyncAdvanceSubscription = {
			subId: 'reader',
			key: 'reader',
			input,
			credential: 'engine-property-test',
			heldIds: heldIdsOf(answer),
			digestOnly: false,
			digest: await contentDigest(answer),
			policyHash: described.policyHash
		};

		// A row the subject's policy denies leaves the authoritative answer unchanged.
		await h.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					h.effectId('policy:denied'),
					adminSubject,
					'people',
					[{ name: 'edge-row', team: 'edge', seq: 1 }],
					false,
					0
				);
			})
		);
		const quietUpdate = await h.runtime.runPromise(
			advanceSubscription(h.effectId('policy:advance:denied'), {
				state,
				subject: readerSubject
			})
		);
		expect(quietUpdate).toBeUndefined();

		// A row the subject holds, rewritten until the policy refuses it: the next wake removes it.
		const heldId = state.heldIds[0];
		expect(typeof heldId).toBe('string');
		await h.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.mutate(
					h.effectId('policy:revoke'),
					adminSubject,
					'people',
					[{ id: heldId, team: 'edge' }],
					false,
					0
				);
			})
		);
		const revokeUpdate = await h.runtime.runPromise(
			advanceSubscription(h.effectId('policy:advance:revoke'), {
				state,
				subject: readerSubject
			})
		);
		const expected = await h.runtime.runPromise(
			resolveSyncQuery(h.effectId('policy:expected'), readerSubject, input)
		);
		expect(revokeUpdate).toBeDefined();
		const applied = applyPatch(answer, revokeUpdate?.patch ?? { op: 'answer', answer: null });
		expect(applied).toEqual(expected);
		expect(revokeUpdate?.to).toBe(await contentDigest(expected));
	});
});
