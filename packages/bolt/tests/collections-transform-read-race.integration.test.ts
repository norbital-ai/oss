import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';
import { describePolicy } from '../src/authoring/policy-introspection.js';
import { refuse } from '../src/authoring/refusal.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { adminSubject, makeBoltTestRuntime, testWorkspace } from './support/bolt-test-layer.js';

/** The read surface a transform is handed, nominal shape only: the runtime hands the live api. */
type TransformDb = Readonly<{
	readonly people: Readonly<{
		readonly count: (input: Readonly<Record<string, unknown>>) => Effect.Effect<number>;
		readonly findMany: (
			input: Readonly<Record<string, unknown>>
		) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>;
	}>;
}>;

/**
 * What a transform read is asserted against at commit (RFC §6, statement economy): the commit's
 * read-consistency prologue re-checks every read the transform made, so a rule decided on a read
 * that moved before the transaction fails rather than committing a phantom.
 */
describe('transform read consistency at commit', () => {
	for (const shared of [false, true]) {
		for (const counted of [false, true]) {
			it(`${counted ? 'count' : 'rows'} read ${shared ? 'refuses the competing phantom' : 'allows unrelated writes'}`, async () => {
				let readers = 0;
				const barrier = Promise.withResolvers<void>();
				const authored: AuthoredRuntime = {
					...emptyAuthoredRuntime,
					collections: {
						people: {
							create: { input: { columns: { name: true, team: true } } },
							transform: (
								inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
								context: Readonly<{ db: unknown }>
							) =>
								Effect.gen(function* () {
									const db = context.db as TransformDb;
									const team = String(inputs[0]?.['team'] ?? '');
									const query = { where: { team: { eq: team } } };
									// One settled place per team: the read decides the rule.
									const count = counted
										? yield* db.people.count(query)
										: (yield* db.people.findMany(query)).length;
									if (count > 0) refuse('This team already has its place.');
									if (++readers === 2) barrier.resolve();
									yield* Effect.promise(() => barrier.promise);
									return inputs;
								})
						}
					}
				};
				const definition = testWorkspace({
					policies: [
						describePolicy('admin', {
							description: 'One place per team.',
							grants: { people: { read: {}, mutate: { new: {} } } }
						})
					]
				});
				const harness = await makeBoltTestRuntime(definition, { authored });
				try {
					await seedSession(harness, {
						token: 'requestor-session',
						user: 'requestor',
						team: 'admin'
					});
					const results = await Promise.all(
						['first', 'second'].map((name) =>
							harness.runtime.runPromiseExit(
								Effect.gen(function* () {
									const collections = yield* Collections.Service;
									return yield* collections.write(
										harness.effectId(name),
										{ ...adminSubject, userId: fixtureUserId('requestor'), admin: false },
										[
											{
												collection: 'people',
												action: 'create',
												inputs: [{ name, team: shared ? 'last-place' : name }]
											}
										]
									);
								})
							)
						)
					);
					// Both transforms read before either committed, so both rules said "free".
					expect(readers).toBe(2);
					expect(results.filter(Exit.isSuccess)).toHaveLength(shared ? 1 : 2);
					if (shared)
						expect(
							results.some(
								(result) =>
									Exit.isFailure(result) &&
									(Cause.pretty(result.cause) + JSON.stringify(result)).includes(
										'Refresh and retry'
									)
							)
						).toBe(true);
					const rows = await harness.database.query('select id from people');
					expect(
						rows,
						results
							.map((result) => (Exit.isFailure(result) ? Cause.pretty(result.cause) : 'success'))
							.join('\n')
					).toHaveLength(shared ? 1 : 2);
				} finally {
					barrier.resolve();
					await harness.dispose();
				}
			}, 30_000);
		}
	}
});
