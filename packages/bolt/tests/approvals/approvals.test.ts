import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type * as AccessControl from '../../src/runtime/access/access-control.js';
import {
	ApprovalConflict,
	approvalRequestId,
	approvalReviewDigest,
	decideState,
	maskApprovalReview
} from '../../src/runtime/approvals/approvals.js';

describe('Approvals owner', () => {
	it('derives retry-stable request ids from the root and effect', () => {
		const root = { collection: 'people', id: 'person-1', action: 'update' as const };
		const effectId = EffectId.make('write-1');
		expect(approvalRequestId(root, effectId)).toBe(approvalRequestId({ ...root }, effectId));
		expect(approvalRequestId(root, EffectId.make('write-2'))).not.toBe(
			approvalRequestId(root, effectId)
		);
	});

	it('fingerprints exact review bytes, including stored snapshot bytes', () => {
		const review = {
			version: 1,
			rows: [{ collection: 'people', id: 'person-1', snapshot: '{"name":"Ada"}' }]
		};
		expect(approvalReviewDigest(review)).toBe(approvalReviewDigest({ ...review }));
		expect(
			approvalReviewDigest({
				...review,
				rows: [{ collection: 'people', id: 'person-1', snapshot: '{ "name": "Ada" }' }]
			})
		).not.toBe(approvalReviewDigest(review));
	});

	it('stores review snapshots through the requestor read mask', () => {
		const invocation = {
			mask: (
				_subject: unknown,
				_action: string,
				_resource: string,
				value: Readonly<Record<string, unknown>>
			) => Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'secret'))
		} as unknown as AccessControl.Invocation;
		const subject = {
			userId: 'requestor-1',
			tenantId: 'tenant-1',
			teamPath: ['requestors'],
			policies: []
		};

		expect(
			maskApprovalReview(
				{
					version: 1,
					rows: [
						{
							collection: 'people',
							id: 'person-1',
							snapshot: '{"id":"person-1","name":"Ada","secret":"hidden"}'
						}
					]
				},
				invocation,
				subject
			)
		).toEqual({
			version: 1,
			rows: [
				{
					collection: 'people',
					id: 'person-1',
					snapshot: '{"id":"person-1","name":"Ada"}'
				}
			]
		});
	});

	it('makes one terminal decision from pending state', () => {
		expect(
			decideState({ _tag: 'Pending', requestId: 'r1', step: 0, operation: {} }, 'approve', 'u1')
		).toEqual({
			_tag: 'Approved',
			requestId: 'r1',
			decidedBy: 'u1',
			operation: {}
		});
	});
	it('stays pending until the last configured step', () => {
		const first = decideState(
			{ _tag: 'Pending', requestId: 'r1', step: 0, operation: { collection: 'employees' } },
			'approve',
			'u1',
			'',
			2
		);
		expect(first).toEqual({
			_tag: 'Pending',
			requestId: 'r1',
			step: 1,
			operation: { collection: 'employees' }
		});
		if (first instanceof ApprovalConflict || first._tag !== 'Pending') {
			throw new Error('expected the first approve to remain pending');
		}
		expect(decideState(first, 'approve', 'u2', '', 2)).toEqual({
			_tag: 'Approved',
			requestId: 'r1',
			decidedBy: 'u2',
			operation: { collection: 'employees' }
		});
	});
	it('rejects replay against terminal state', () => {
		expect(
			decideState({ _tag: 'Approved', requestId: 'r1', decidedBy: 'u1' }, 'reject', 'u2')
		).toBeInstanceOf(ApprovalConflict);
	});
});
