import type { SyncQueryInput } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { field, policy } from '../../src/authoring/workspace-schema.js';
import type { Subject } from '../../src/runtime/identity/identity.js';
import { describeSyncQuery } from '../../src/runtime/sync/resolver.js';
import { makeBoltTestRuntime, testWorkspace, TEST_TENANT } from '../support/bolt-test-layer.js';

/**
 * The sync policy hash, §2.2.
 *
 * The registry dedups on `(policyHash, queryHash)`, so the hash must be exactly as wide as the
 * subject's compiled surface over *the query's own collections* — never wider (every subscription
 * would answer for grants that cannot touch its answer) and never narrower (sharing would be
 * wrong). These tests pin the input tuple through the only seam that matters: what the guest
 * reports per registration.
 */

/** §2.2.3: identity and policy collections are dependencies of every SubState, drift wake included. */
const POLICY_DEPENDENCIES = [
	'account',
	'approval_request',
	'auth_config',
	'session',
	'team',
	'user',
	'verification'
];

const teamScopedWorkspace = testWorkspace({
	collections: [{ name: 'people', fields: { name: field.string({ required: true }), team: field.string() } }],
	policies: [
		policy({
			name: 'people-reader',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'read', where: { team: '${requestor.team}' } }]
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
			grants: [{ collection: 'people', action: 'read', where: { name: '${requestor.id}' } }]
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

describe('the sync policy hash', () => {
	it('narrows its surface to the query and the predicate graph, never every system collection', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const described = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			expect(described.policyDependencies).toEqual(POLICY_DEPENDENCIES);
			expect(described.dependencies).toEqual(['people', ...POLICY_DEPENDENCIES].toSorted());
			expect(described.policyHash).toMatch(/^sha256:/);
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
			expect(second.policyHash).toBe(first.policyHash);
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
			expect(second.policyHash).toBe(first.policyHash);
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
			expect(edge.policyHash).not.toBe(core.policyHash);
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
			expect(second.policyHash).not.toBe(first.policyHash);
		} finally {
			await harness.dispose();
		}
	});

	it('widens to every collection when a relation cannot be resolved', async () => {
		const harness = await makeBoltTestRuntime(teamScopedWorkspace);
		try {
			const plain = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), findPeople)
			);
			const unknown = await harness.runtime.runPromise(
				describeSyncQuery(subjectOn('u1', 'core'), {
					kind: 'findMany',
					collection: 'people',
					with: { nope: {} }
				})
			);
			expect(unknown.dependencies).toContain('chat_message');
			expect(unknown.policyHash).not.toBe(plain.policyHash);
		} finally {
			await harness.dispose();
		}
	});
});
