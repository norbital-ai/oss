import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { field, policy } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

const PARTITION_TEAM = 'Shared';

const definition = testWorkspace({
	collections: ['id_rows', 'email_rows', 'scope_rows', 'team_rows'].map((name) => ({
		name,
		fields: {
			owner: field.string(),
			team: field.string()
		}
	})),
	policies: [
		policy({
			name: 'partition-reader',
			effect: 'allow',
			grants: [
				{
					collection: 'id_rows',
					action: 'read',
					where: { owner: { eq: '${requestor.id}' } }
				},
				{
					collection: 'email_rows',
					action: 'read',
					where: { owner: { eq: '${requestor.email}' } }
				},
				{
					collection: 'scope_rows',
					action: 'read',
					where: { $sql: '"owner"::text IN ${requestor.team_scope_users}' }
				},
				{
					collection: 'team_rows',
					action: 'read',
					where: { team: { eq: '${requestor.team}' } }
				}
			]
		})
	],
	teams: { [PARTITION_TEAM]: ['partition-reader'] }
});

const subject = (userId: string, email: string): Identity.Subject => ({
	userId,
	tenantId: 'test-tenant',
	email,
	teamPath: [PARTITION_TEAM],
	policies: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const positions = (
	runtime: BoltTestRuntime,
	principal: Identity.Subject,
	effect: string
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Sync.Service).positions(
				runtime.effectId(effect),
				principal,
				['id_rows', 'email_rows', 'scope_rows', 'team_rows']
			);
		})
	);

describe('policy actor binding in sync partitions', () => {
	it('classifies actor-valued requestor tokens without marking a team-uniform predicate', async () => {
		harness = await makeBoltTestRuntime(definition);
		const principal = subject('actor-a', 'actor-a@example.test');
		const bindings = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const access = yield* AccessControl.Service;
				return Object.fromEntries(
					['id_rows', 'email_rows', 'scope_rows', 'team_rows'].map((name) => [
						name,
						access.predicate(principal, 'read', name).actorBound
					])
				);
			})
		);

		expect(bindings).toEqual({
			id_rows: true,
			email_rows: true,
			scope_rows: true,
			team_rows: false
		});
	});

	it('isolates two same-team actors when their policy surface is actor-bound', async () => {
		harness = await makeBoltTestRuntime(definition);
		const first = await positions(
			harness,
			subject('actor-a', 'actor-a@example.test'),
			'actor-partition-a'
		);
		const second = await positions(
			harness,
			subject('actor-b', 'actor-b@example.test'),
			'actor-partition-b'
		);

		expect(first.partition.effectivePolicyHolder).toBe('actor:actor-a');
		expect(second.partition.effectivePolicyHolder).toBe('actor:actor-b');
		expect(first.partition.key).not.toBe(second.partition.key);
	});

	it('keeps the real actors isolated while both preview the same team', async () => {
		harness = await makeBoltTestRuntime(definition);
		const firstActor = subject('administrator-a', 'administrator-a@example.test');
		const secondActor = subject('administrator-b', 'administrator-b@example.test');
		const first = await positions(
			harness,
			{ ...firstActor, admin: false, impersonatedBy: firstActor.userId },
			'preview-partition-a'
		);
		const second = await positions(
			harness,
			{ ...secondActor, admin: false, impersonatedBy: secondActor.userId },
			'preview-partition-b'
		);

		expect(first.partition).toMatchObject({
			effectivePolicyHolder: 'actor:administrator-a',
			impersonationTarget: PARTITION_TEAM
		});
		expect(second.partition).toMatchObject({
			effectivePolicyHolder: 'actor:administrator-b',
			impersonationTarget: PARTITION_TEAM
		});
		expect(first.partition.key).not.toBe(second.partition.key);
	});
});
