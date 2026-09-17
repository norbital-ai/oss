// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertCollectionFormFieldRegistration,
	collectionFormWriteColumns,
	collectionFormWriteSelection,
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
		pickWritableFormValues(writableColumns, {
			company_id: 'c1',
			period: '2026-01',
			lifecycle: 'PAID',
			pay_date: '2026-02-01'
		}),
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

test('a matrix relation rides along only when the selection declares it', () => {
	const values = { principal: 1200, repayment_loan: [{ amount_due: 600 }], notes: [] };
	assert.deepEqual(pickWritableFormValues(['principal'], values, ['repayment_loan']), {
		principal: 1200,
		repayment_loan: [{ amount_due: 600 }]
	});
});

test('the form writes through the operation the record decides', () => {
	const write = {
		create: { columns: { name: true, email: true } },
		update: { columns: { email: true }, with: { addresses: { create: {} } } }
	};
	assert.deepEqual(collectionFormWriteColumns(collectionFormWriteSelection(write, false)), [
		'name',
		'email'
	]);
	assert.deepEqual(collectionFormWriteColumns(collectionFormWriteSelection(write, true)), [
		'email'
	]);
	assert.equal(collectionFormWriteSelection({ create: write.create }, true), undefined);
	assert.equal(collectionFormWriteSelection(undefined, false), undefined);
});

test('form composition requires every declared column exactly once and keeps identity internal', () => {
	const expectedKeys = collectionFormWriteColumns({ columns: { name: true, email: true } });
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
