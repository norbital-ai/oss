import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { createInvocationFactory } from '../src/runtime/access/invocation.js';
import { predicateStatement, type RowPredicate } from '../src/runtime/access/predicate.js';
import { policyHashSource } from '../src/runtime/access/policy-surface.js';
import { Subject } from '../src/runtime/identity/subject.js';
import { isWorkspaceSubject, workspaceSubject } from '../src/runtime/identity/static-identity.js';

const caller = {
	userId: 'user-1',
	tenantId: 'tenant-1',
	teamPath: ['writers'],
	policies: [],
	email: 'user-1@example.test'
};

/** An evaluator that grants nobody anything, so every allowance below is the workspace's. */
const denyAll = createInvocationFactory(() => ({
	decision: () => ({ allowed: false, reason: 'no matching allow policy' }),
	predicate: () => ({
		allowed: false,
		reason: 'no matching allow policy',
		expression: { kind: 'constant', value: false },
		actorBound: false
	})
}));

describe('invocation policy contracts', () => {
	it('answers the workspace unrestricted, with no authorization and no approval route', async () => {
		const invocation = denyAll();
		const workspace = workspaceSubject(caller);
		expect(isWorkspaceSubject(workspace)).toBe(true);
		expect(isWorkspaceSubject(caller)).toBe(false);
		expect(workspace.userId).toBe(caller.userId);
		expect(workspace.policies).toEqual([]);

		const write = await Effect.runPromise(invocation.write(workspace, 'create', 'people', { any: 1 }));
		expect(write).toEqual({
			action: 'create',
			resource: 'people',
			predicate: {
				allowed: true,
				reason: 'workspace',
				expression: { kind: 'constant', value: true },
				actorBound: false
			},
			authorization: undefined,
			approval: undefined
		});
		const read = await Effect.runPromise(invocation.read(workspace, 'people'));
		expect(read.predicate.allowed).toBe(true);
		expect(read.mask({ id: 'p1', secret: 'kept' })).toEqual({ id: 'p1', secret: 'kept' });
		await Effect.runPromise(invocation.authorize(workspace, 'read', 'people'));
		expect(invocation.mask(workspace, 'read', 'people', { secret: 'kept' })).toEqual({
			secret: 'kept'
		});

		// The caller the workspace was minted for is still judged on its own grants.
		const denied = await Effect.runPromise(Effect.flip(invocation.write(caller, 'create', 'people', {})));
		expect(denied.reason).toBe('no matching allow policy');
	});

	it('cannot be minted from a payload and survives a spread', () => {
		const workspace = workspaceSubject(caller);
		expect(isWorkspaceSubject({ ...workspace })).toBe(true);
		const decoded = Schema.decodeUnknownSync(Subject)(JSON.parse(JSON.stringify(workspace)));
		expect(isWorkspaceSubject(decoded)).toBe(false);
		expect(isWorkspaceSubject({ ...caller, policies: [], teamPath: [] })).toBe(false);
		expect(workspaceSubject(workspace)).toBe(workspace);
	});

	it('produces stable policy-hash material from executed predicate and mask', () => {
		const source: RowPredicate = {
			allowed: true,
			reason: 'matching authored grant',
			expression: {
				kind: 'or',
				expressions: [
					{
						kind: 'comparison',
						column: 'owner_id',
						operator: 'eq',
						value: 'user-1'
					},
					{ kind: 'constant', value: false }
				]
			},
			actorBound: true,
			fields: ['status', 'name', 'status']
		};

		const hash = policyHashSource('read', 'people', source);
		expect(hash).toMatchObject({
			action: 'read',
			resource: 'people',
			allowed: true,
			parameters: ['user-1'],
			fields: ['name', 'status']
		});
		expect(hash.sql).toContain('"owner_id" is not distinct from $1');
		expect(hash.sql).toContain('or false');
	});

	it('owns qualification and parameter offsets at the statement compiler boundary', () => {
		const source: RowPredicate = {
			allowed: true,
			reason: 'matching authored grant',
			expression: {
				kind: 'and',
				expressions: [
					{
						kind: 'comparison',
						column: 'owner_id',
						operator: 'eq',
						value: 'user-1'
					},
					{
						kind: 'membership',
						column: 'status',
						negated: false,
						values: ['open', 'closed']
					}
				]
			},
			actorBound: true
		};

		const statement = predicateStatement(source, {
			qualifier: 'candidate',
			parameterOffset: 3
		});

		expect(statement.sql).toContain('"candidate"."owner_id" is not distinct from $4');
		expect(statement.sql).toContain('"candidate"."status" in ($5, $6)');
		expect(statement.sql).not.toContain(' as "predicate"');
		expect(statement.parameters).toEqual(['user-1', 'open', 'closed']);
	});
});
