import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { captureApproval } from '../src/authoring/approval-outcome.js';
import {
	MutationPhaseFailure,
	PendingApproval
} from '../src/runtime/collections/collections.contract.js';

describe('captureApproval', () => {
	it('returns a durable pending request without treating it as applied', async () => {
		const pending = new PendingApproval({
			requestId: 'review',
			collection: 'laws',
			id: 'revision',
			action: 'create'
		});
		const wrapped = new MutationPhaseFailure({
			phase: 'prepare',
			collection: 'laws',
			committed: [],
			cause: pending
		});
		expect(await Effect.runPromise(captureApproval(Effect.fail(wrapped)))).toEqual({
			status: 'pending',
			requestId: 'review',
			collection: 'laws',
			id: 'revision',
			action: 'create'
		});
	});
	it('keeps applied results and propagates unrelated failures', async () => {
		expect(await Effect.runPromise(captureApproval(Effect.succeed(42)))).toEqual({
			status: 'applied',
			value: 42
		});
		await expect(
			Effect.runPromise(captureApproval(Effect.fail(new Error('write failed'))))
		).rejects.toThrow('write failed');
		await expect(
			Effect.runPromise(captureApproval(Effect.die(new Error('defect'))))
		).rejects.toThrow('defect');
	});
});
