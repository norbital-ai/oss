import { Effect } from 'effect';
import { fixtureUserId } from '../support/fixture-identity.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as Identity from '../../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const TEAM = {
	senior: '019f8a10-0000-7000-8000-0000000000a1',
	manager: '019f8a10-0000-7000-8000-0000000000a2',
	supervisor: '019f8a10-0000-7000-8000-0000000000a3'
};

/**
 * Puts a team tree and one person in it, then authenticates as them.
 *
 * The hierarchy is `senior → manager → supervisor`, so a subject placed at the top has two levels
 * beneath it to walk and one placed at the bottom has none.
 */
const placeAndAuthenticate = async (options: { readonly teamId: string | null }) => {
	const runtime = await makeBoltTestRuntime();
	harness = runtime;
	for (const [id, name, parent] of [
		[TEAM.senior, 'Senior Management', null],
		[TEAM.manager, 'L1 Manager', TEAM.senior],
		[TEAM.supervisor, 'Supervisor', TEAM.manager]
	] as const) {
		await runtime.database.query(
			`insert into "team" ("id", "name", "parent_id") values ($1, $2, $3)`,
			[id, name, parent]
		);
	}
	await runtime.database.query(
		`insert into "user" ("id", "name", "tenantId", "team_id") values (md5($1::text)::uuid, $1, 'test-tenant', $2)`,
		['u1', options.teamId]
	);
	return runtime.runtime.runPromise(
		Effect.gen(function* () {
			const identity = yield* Identity.Service;
			const credential = yield* identity.startSession(
				EffectId.make('start-1'),
				fixtureUserId('u1'),
				'test-tenant'
			);
			return yield* identity.authenticate(EffectId.make('auth-1'), credential);
		})
	);
};

/**
 * The recursive CTE in `authenticate`, run against a real Postgres rather than reasoned about.
 *
 * It resolves the hierarchy in the same round trip that authenticates, which is the only reason it
 * is worth writing as one query — so the query has to be exercised as one, with rows in a database,
 * and not stubbed at the projection.
 */
describe('team resolution during authentication', () => {
	it('walks the whole subtree, depth-first ordered', async () => {
		const subject = await placeAndAuthenticate({ teamId: TEAM.senior });
		expect(subject.teamPath[0]).toBe('Senior Management');
		// Ordered by depth, so the subject's own team is first — the order a diagnostic reads best in.
		//
		// Descent is unconditional. A `team.inherits` flag used to gate it, defaulting to off, and
		// a team two levels up therefore held nothing from beneath it unless a row remembered to say
		// so. Being above somebody is now the whole of the statement: authority composes downward
		// because that is what a hierarchy is.
		expect(subject.teamPath).toEqual(['Senior Management', 'L1 Manager', 'Supervisor']);
	});

	it('resolves a leaf team to itself even though teams sit above it', async () => {
		const subject = await placeAndAuthenticate({ teamId: TEAM.supervisor });
		// Composition runs downward and never upward, which is the half that did not change: standing
		// under a team does not hand a supervisor the manager's policies.
		expect(subject.teamPath[0]).toBe('Supervisor');
		expect(subject.teamPath).toEqual(['Supervisor']);
	});

	/**
	 * A cycle is reachable: `parent_id` is a graph an operator edits from a dashboard, and nothing
	 * has stopped them closing a loop yet. A recursive CTE over one does not fail — it runs until
	 * something else stops it — so the depth bound in the query is what stands between a mis-set
	 * parent and an authentication path that never returns.
	 */
	it('terminates on a cycle instead of running forever', async () => {
		const runtime = await makeBoltTestRuntime();
		harness = runtime;
		for (const [id, name, parent] of [
			[TEAM.senior, 'Senior Management', TEAM.supervisor],
			[TEAM.manager, 'L1 Manager', TEAM.senior],
			[TEAM.supervisor, 'Supervisor', TEAM.manager]
		] as const) {
			// Inserted with no parent first, then closed into a loop: the foreign key refuses a parent
			// that does not exist yet, which is also why an operator can only ever create a cycle by
			// editing an existing team rather than by creating one.
			await runtime.database.query(`insert into "team" ("id", "name") values ($1, $2)`, [id, name]);
			void parent;
		}
		for (const [id, parent] of [
			[TEAM.senior, TEAM.supervisor],
			[TEAM.manager, TEAM.senior],
			[TEAM.supervisor, TEAM.manager]
		] as const) {
			await runtime.database.query(`update "team" set "parent_id" = $2 where "id" = $1`, [
				id,
				parent
			]);
		}
		await runtime.database.query(
			`insert into "user" ("id", "name", "tenantId", "team_id") values (md5($1::text)::uuid, $1, 'test-tenant', $2)`,
			['u1', TEAM.senior]
		);
		const subject = await runtime.runtime.runPromise(
			Effect.gen(function* () {
				const identity = yield* Identity.Service;
				const credential = yield* identity.startSession(
					EffectId.make('start-1'),
					fixtureUserId('u1'),
					'test-tenant'
				);
				return yield* identity.authenticate(EffectId.make('auth-1'), credential);
			})
		);
		expect(subject.teamPath[0]).toBe('Senior Management');
		// Eight levels, then it stops. The names repeat because the walk goes round the loop; what
		// matters is that it ends, and that the policies it resolves are a set.
		expect(subject.teamPath?.length).toBe(8);
		expect(new Set(subject.teamPath)).toEqual(
			new Set(['Senior Management', 'L1 Manager', 'Supervisor'])
		);
	});

	it('authenticates a person nobody has placed, holding no team at all', async () => {
		const subject = await placeAndAuthenticate({ teamId: null });
		// A founder admitted into an empty workspace is exactly this. It must authenticate — it simply
		// holds no policies through membership.
		expect(subject.teamPath[0]).toBeUndefined();
		// Empty, not absent. `SUBJECT_TAIL_SQL` coalesces the walk to `'[]'::json`, so every subject
		// carries a path — `policiesHeldByTeam` reads it on each decision, and one that could be
		// missing would move that check into every caller.
		expect(subject.teamPath).toEqual([]);
		expect(subject.userId).toBe(fixtureUserId('u1'));
	});
});
