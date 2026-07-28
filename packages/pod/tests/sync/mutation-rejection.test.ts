import { describe, it, expect } from 'vitest';
import { HttpError } from '$lib/server/collection/http_error.js';
import {
	isUnexpectedMutationError,
	mutationRejection
} from '$lib/server/collection/sync/mutation-rejection.server.js';
import { mutationRejectionMessage } from '$lib/client/sync/mutation-rejection.js';
import type { MutationResult } from '$lib/client/sync/types.js';

/** The whole trip: what a server throw becomes on the wire, and what the user then reads. */
function userCopyFor(err: unknown): { reason: string; message: string } {
	const rejection = mutationRejection(err);
	// The wire frame the client actually receives (sync-endpoints adds clientId/status).
	const wire = JSON.parse(
		JSON.stringify({ clientId: 'c1', status: 'rejected', ...rejection })
	) as MutationResult;
	if (wire.status !== 'rejected') throw new Error('expected a rejected result');
	return { reason: wire.reason, message: mutationRejectionMessage(wire) };
}

describe('mutation rejection propagation', () => {
	it('surfaces the message a hook or access-control check deliberately wrote', () => {
		const denial = 'Cannot revise record until an approver requests changes.';
		const { reason, message } = userCopyFor(new HttpError(409, denial));

		expect(message).toBe(denial);
		// The machine-readable code survives alongside the prose — callers still switch on it.
		expect(reason).toBe('HTTP_409');
	});

	it('keeps PERMISSION_DENIED as the reason while showing the denial text', () => {
		const { reason, message } = userCopyFor(
			new HttpError(403, 'Only the original requestor can revise this approval request.')
		);

		expect(reason).toBe('PERMISSION_DENIED');
		expect(message).toBe('Only the original requestor can revise this approval request.');
	});

	it('keeps a typed code and its currentRow, and prefers the message over the code', () => {
		const rejection = mutationRejection(
			new HttpError(409, {
				message: 'Record was modified concurrently',
				code: 'CONFLICT',
				currentRow: { norbital_id: 'r1' }
			})
		);

		expect(rejection.reason).toBe('CONFLICT');
		expect(rejection.currentRow).toEqual({ norbital_id: 'r1' });
		expect(mutationRejectionMessage({ clientId: 'c1', status: 'rejected', ...rejection })).toBe(
			'Record was modified concurrently'
		);
	});

	it('never turns a raw thrown Error into user copy', () => {
		const raw = new Error('duplicate key value violates unique constraint "payroll_runs_pkey"');
		const { reason, message } = userCopyFor(raw);

		expect(reason).toBe('INTERNAL_ERROR');
		expect(message).toBe('INTERNAL_ERROR');
		expect(message).not.toContain('unique constraint');
		expect(mutationRejection(raw).detail).toBeUndefined();
		expect(isUnexpectedMutationError(raw)).toBe(true);
	});

	it('does not surface a 5xx the server raised about its own state', () => {
		const err = new HttpError(500, 'Tenant database is not provisioned');
		const { reason, message } = userCopyFor(err);

		expect(reason).toBe('HTTP_500');
		expect(message).toBe('HTTP_500');
		expect(mutationRejection(err).detail).toBeUndefined();
		expect(isUnexpectedMutationError(err)).toBe(true);
	});

	it('treats a deliberate 4xx as expected, so it is not logged as a server failure', () => {
		expect(isUnexpectedMutationError(new HttpError(409, 'nope'))).toBe(false);
	});

	it('falls back to the reason code when a rejection carries no message', () => {
		expect(
			mutationRejectionMessage({ clientId: 'c1', status: 'rejected', reason: 'OFFLINE_QUEUED' })
		).toBe('OFFLINE_QUEUED');
		expect(mutationRejectionMessage(undefined)).toBe('MUTATE_FAILED');
		expect(
			mutationRejectionMessage({
				clientId: 'c1',
				status: 'rejected',
				reason: 'MISSING_ID',
				detail: '   '
			})
		).toBe('MISSING_ID');
	});
});
