// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	collectionRecordLeadingAccent,
	collectionRecordMutationReason,
	resolveCollectionRecordMetadata
} from '../src/collection-record-metadata/collection-record-metadata.ts';

const copy = {
	pendingApprovalLabel: 'Awaiting approval',
	pendingApprovalReason: 'This record cannot change until approval closes.'
};

test('protected system state and authored metadata resolve through one strict contract', () => {
	const resolved = resolveCollectionRecordMetadata(
		{ approval_id: 'approval-1' },
		[
			{
				kind: 'restriction',
				operations: ['update'],
				reason: 'Payroll has consumed this entry.'
			},
			{
				kind: 'flag',
				tone: 'warning',
				label: 'Review evidence'
			}
		],
		copy
	);

	assert.deepEqual(
		resolved.map(({ kind, source }) => ({ kind, source })),
		[
			{ kind: 'restriction', source: 'system' },
			{ kind: 'restriction', source: 'application' },
			{ kind: 'flag', source: 'application' }
		]
	);
	assert.equal(
		collectionRecordMutationReason(resolved, 'update'),
		'This record cannot change until approval closes.'
	);
	assert.equal(
		collectionRecordMutationReason(resolved, 'delete'),
		'This record cannot change until approval closes.'
	);
});

test('flags never restrict mutations and restrictions apply only to declared operations', () => {
	const flagged = resolveCollectionRecordMetadata(
		{},
		[{ kind: 'flag', tone: 'danger', label: 'Suspicious' }],
		copy
	);
	assert.equal(collectionRecordMutationReason(flagged, 'update'), null);
	assert.equal(collectionRecordMutationReason(flagged, 'delete'), null);

	const updateOnly = resolveCollectionRecordMetadata(
		{},
		[{ kind: 'restriction', operations: ['update'], reason: 'Updates are frozen.' }],
		copy
	);
	assert.equal(collectionRecordMutationReason(updateOnly, 'update'), 'Updates are frozen.');
	assert.equal(collectionRecordMutationReason(updateOnly, 'delete'), null);
});

test('an empty protected approval field injects no system metadata', () => {
	assert.deepEqual(resolveCollectionRecordMetadata({ approval_id: '' }, undefined, copy), []);
});

test('warning metadata produces the same leading accent for every collection surface', () => {
	const metadata = resolveCollectionRecordMetadata(
		{},
		[{ kind: 'flag', tone: 'warning', label: 'Suspicious', description: 'Review this record.' }],
		copy
	);
	assert.deepEqual(collectionRecordLeadingAccent(metadata), {
		markerClass: 'w-1 bg-warning',
		tooltip: 'Review this record.'
	});
});
