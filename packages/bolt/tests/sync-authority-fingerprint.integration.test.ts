import type { SyncQueryInput } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { subject } from '../src/authoring/index.js';
import { field, policy } from '../src/authoring/workspace-schema.js';
import type { Subject } from '../src/runtime/identity/identity.js';
import { describeSyncQuery } from '../src/runtime/sync/delta-engine.js';
import { makeBoltTestRuntime, testWorkspace, TEST_TENANT } from './support/bolt-test-layer.js';

/**
 * The sync authority fingerprint, §2.2.
 *
 * The registry dedups on `planKey`, whose effective-plan fingerprint includes authority. Authority
 * covers the subject's compiled surface over *the query's own collections* — never wider (every
 * subscription would answer for grants that cannot touch its answer) and never narrower (sharing
 * would be wrong). These tests pin the input tuple through the only seam that matters: what the
 * guest reports per registration.
 *
 * `authority` and `dependencies` are two different sets and neither is a superset of the other.
 * Authority is the *policy* surface: the compiled read predicate of each collection the plan
 * resolves through, hashed, and the thing that decides whether two subjects may share one plan.
 * Dependencies are the *row* surface: the collections whose writes can change this answer, indexed
 * by `SyncRegistry` to decide which subscriptions a transaction wakes. A collection can be a row
 * input without being a policy input, which is exactly what the approval-read branch is.
 */

const teamScopedWorkspace = testWorkspace({
	collections: [{ name: 'people', fields: { name: field.string({ required: true }), team: field.string() } }],
	policies: [
		policy({
			name: 'people-reader',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'read', where: { team: { eq: subject.team } } }]
		})
	],
	teams: { core: ['people-reader'], edge: ['people-reader'] }
});

const actorBoundWorkspace = testWorkspace({
	collections: [{ name: 'people', fields: { name: field.string({ required: true }), team: field.string() } }],
	policies: [
		policy({
			name: 'own-people',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'read', where: { name: { eq: subject.id } } }]
		})
	],
	teams: { core: ['own-people'] }
});

const subjectOn = (userId: string, team: string): Subject => ({
	userId,
	tenantId: TEST_TENANT,
	teamPath: [team],
	policies: []
});

const findPeople: SyncQueryInput = { kind: 'findMany', collection: 'people' };

describe('the sync authority fingerprint', () => {
	it('narrows both surfaces to the query and the predicate graph, never every system collection', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const described = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			// Every granted read carries the approval-read branch — `id in (select record_id from
			// approval_request where …)` — so an approval opened or closed against `people` changes
			// which rows this subject may see. The predicate says so, and the dependency set has to
			// say the same thing, or the registry never wakes this subscription for that write.
			expect(described.effectivePlan.dependencies).toEqual(['approval_request', 'people']);
			// Authority is the policy surface, and the approval branch adds no *policy* input: it reads
			// approval rows, not the approval collection's grants. It stays the query's own collections.
			expect(described.effectivePlan.authority.collections).toEqual(['people']);
			// The point both sets have to keep making: one predicate branch pulls in one collection.
			// Neither surface is a blanket sweep of the system model.
			for (const uninvolved of ['bolt_task', 'requestor', 'team', 'user']) {
				expect(described.effectivePlan.dependencies).not.toContain(uninvolved);
				expect(described.effectivePlan.authority.collections).not.toContain(uninvolved);
			}
			expect(described.effectivePlan.authority.subjectOperands).toEqual(['team']);
			expect(described.effectivePlan.authority.fingerprint).toMatch(/^sha256:/);
		} finally {
			await harness.dispose();
		}
	});

	it('is a pure function of the query and the subject surface', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const first = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			const second = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			expect(second.effectivePlan.authority.fingerprint).toBe(
				first.effectivePlan.authority.fingerprint
			);
		} finally {
			await harness.dispose();
		}
	});

	it('collapses two members of one team-scoped policy to one hash', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const first = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			const second = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u2', 'core'), findPeople)
			);
			expect(second.effectivePlan.authority.fingerprint).toBe(
				first.effectivePlan.authority.fingerprint
			);
		} finally {
			await harness.dispose();
		}
	});

	it('splits subjects whose team-scoped grants bind different teams', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const core = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			const edge = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u2', 'edge'), findPeople)
			);
			expect(edge.effectivePlan.authority.fingerprint).not.toBe(
				core.effectivePlan.authority.fingerprint
			);
		} finally {
			await harness.dispose();
		}
	});

	it('splits actor-bound grants by the bound user id, even on one team', async () => {
		const harness = await makeBoltTestRuntime(actorBoundWorkspace);
		try {
			const first = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			const second = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u2', 'core'), findPeople)
			);
			expect(second.effectivePlan.authority.fingerprint).not.toBe(
				first.effectivePlan.authority.fingerprint
			);
		} finally {
			await harness.dispose();
		}
	});

	it('fails closed when a relation cannot be resolved', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			await expect(
				harness.runtime.runPromise(
					describeSyncQuery(subjectOn('u1', 'core'), {
						kind: 'findMany',
						collection: 'people',
						with: { nope: {} }
					})
				)
			).rejects.toMatchObject({
				_tag: 'Bolt.Access.EffectivePlanError',
				code: 'unknown-relationship'
			});
		} finally {
			await harness.dispose();
		}
	});
});
