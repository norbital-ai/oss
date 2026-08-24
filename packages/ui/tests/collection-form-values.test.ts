// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickWritableFormValues } from '../src/collection-form/collection-form-values.ts';

test('an edited hydrated row submits only declared writable fields', () => {
	const fields = [
		{ name: 'id', kind: 'uuid', nullable: false },
		{ name: 'created_at', kind: 'instant', nullable: false },
		{ name: 'updated_at', kind: 'instant', nullable: false },
		{ name: 'row_version', kind: 'integer', nullable: false },
		{ name: 'approval_id', kind: 'uuid', nullable: true },
		{ name: 'name', kind: 'text', nullable: false },
		{ name: 'normalized_name', kind: 'text', nullable: false, readOnly: true },
		{ name: 'email', kind: 'text', nullable: true }
	];

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

	assert.deepEqual(pickWritableFormValues(fields, hydrated), {
		name: 'Updated employee',
		email: 'employee@example.test'
	});
});

test('day-precision instants survive an unrelated edit without losing their stored precision', () => {
	const fields = [
		{ name: 'title', kind: 'text', nullable: false },
		{ name: 'scheduled_for', kind: 'instant', nullable: false, precision: 'day' },
		{ name: 'blackout_dates', kind: 'instant', nullable: false, precision: 'day', array: true }
	];
	const localMidnight = new Date(2026, 6, 3);
	const nextLocalMidnight = new Date(2026, 6, 4);

	assert.deepEqual(
		pickWritableFormValues(fields, {
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
