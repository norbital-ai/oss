// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertCollectionFormFieldRegistration,
	collectionFormMutationFieldNames,
	pickCollectionFormValues,
	pickWritableFormValues
} from '../src/collection-form/collection-form-values.ts';

test('an edited hydrated row submits only declared writable fields', () => {
	const writableColumns = ['name', 'email'];
	const hydrated = {
		id: 'employee-1',
		created_at: '2026-08-23T00:00:00.000Z',
		updated_at: '2026-08-23T00:00:00.000Z',
		row_version: 3,
		approval_id: null,
		name: 'Updated employee',
		normalized_name: 'updated employee',
		undeclared_relationship: []
	};
	Object.defineProperty(hydrated, 'email', { value: 'employee@example.test', enumerable: false });

	assert.deepEqual(pickWritableFormValues(writableColumns, hydrated), {
		name: 'Updated employee',
		email: 'employee@example.test'
	});
});

test('a declared input narrows the write mask past the catalog', () => {
	const writableColumns = ['company_id', 'period'];
	assert.deepEqual(
		pickWritableFormValues(
			writableColumns,
			{ company_id: 'c1', period: '2026-01', lifecycle: 'PAID', pay_date: '2026-02-01' }
		),
		{ company_id: 'c1', period: '2026-01' }
	);
});

test('day-precision instants survive an unrelated edit without losing their stored precision', () => {
	const writableColumns = ['title', 'scheduled_for', 'blackout_dates'];
	const localMidnight = new Date(2026, 6, 3);
	const nextLocalMidnight = new Date(2026, 6, 4);

	assert.deepEqual(
		pickWritableFormValues(writableColumns, {
			title: 'Title only changed',
			scheduled_for: localMidnight.toISOString(),
			blackout_dates: [nextLocalMidnight, '2026-07-05']
		}),
		{
			title: 'Title only changed',
			scheduled_for: localMidnight.toISOString(),
			blackout_dates: [nextLocalMidnight, '2026-07-05']
		}
	);
});

test('form composition requires every mutable field exactly once and keeps identity internal', () => {
	const fields = [
		{ name: 'id', kind: 'uuid', nullable: false },
		{ name: 'created_at', kind: 'instant', nullable: false },
		{ name: 'name', kind: 'text', nullable: false },
		{ name: 'search_name', kind: 'text', nullable: false, readOnly: true },
		{ name: 'email', kind: 'text', nullable: true }
	];

	assert.deepEqual(collectionFormMutationFieldNames(fields), ['name', 'email']);
	const expectedKeys = collectionFormMutationFieldNames(fields);
	assert.doesNotThrow(() =>
		assertCollectionFormFieldRegistration(
			'employees',
			expectedKeys,
			new Map([
				['name', 1],
				['email', 1]
			])
		)
	);
	assert.throws(
		() => assertCollectionFormFieldRegistration('employees', expectedKeys, new Map([['name', 1]])),
		/missing: email/
	);
	assert.throws(
		() =>
			assertCollectionFormFieldRegistration(
				'employees',
				expectedKeys,
				new Map([
					['name', 2],
					['email', 1]
				])
			),
		/duplicated: name/
	);
	assert.throws(
		() =>
			assertCollectionFormFieldRegistration(
				'employees',
				expectedKeys,
				new Map([
					['id', 1],
					['name', 1],
					['email', 1]
				])
			),
		/not mutable: id/
	);
});

test('form baselines retain optional read-only facts without exposing system fields', () => {
	const fields = [
		{ name: 'id', kind: 'uuid', nullable: false },
		{ name: 'name', kind: 'text', nullable: false },
		{ name: 'normalized_name', kind: 'text', nullable: false, readOnly: true }
	];
	assert.deepEqual(
		pickCollectionFormValues(fields, {
			id: 'employee-1',
			name: 'Ada',
			normalized_name: 'ada'
		}),
		{ name: 'Ada', normalized_name: 'ada' }
	);
});
