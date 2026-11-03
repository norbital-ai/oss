import { expect, it } from '@effect/vitest';
import { compatibleHistoryValue } from '../src/engine/query/history-schema.ts';

it('refuses destructive shape, precision, currency and reference changes', () => {
	expect(
		compatibleHistoryValue(
			{ $dec: '100.00' },
			{ kind: 'decimal', scale: 2 },
			{ kind: 'decimal', scale: 2, precision: 4 }
		)
	).toBeUndefined();
	expect(compatibleHistoryValue('2147483648', { kind: 'text' }, { kind: 'int' })).toBeUndefined();
	expect(
		compatibleHistoryValue(
			{ $dec: '1.2345' },
			{ kind: 'money', currency: 'SGD', scale: 4 },
			{ kind: 'money', currency: 'SGD', scale: 4 }
		)
	).toEqual({ $dec: '1.2345' });
	expect(
		compatibleHistoryValue(
			{ title: 'Old', removed: 'Keep me' },
			{ kind: 'json' },
			{ kind: 'object', fields: { title: { kind: 'text' } } }
		)
	).toBeUndefined();
	expect(
		compatibleHistoryValue(
			{ $dec: '1.234' },
			{ kind: 'decimal', scale: 3 },
			{ kind: 'decimal', scale: 2 }
		)
	).toBeUndefined();
	expect(
		compatibleHistoryValue('9007199254740993', { kind: 'text' }, { kind: 'int' })
	).toBeUndefined();
	expect(
		compatibleHistoryValue(
			{ $dec: '12.00' },
			{ kind: 'money', currency: 'USD' },
			{ kind: 'money', currency: 'SGD' }
		)
	).toBeUndefined();
	expect(
		compatibleHistoryValue(
			'same-id',
			{ kind: 'ref', to: 'people' },
			{ kind: 'ref', to: 'companies' }
		)
	).toBeUndefined();
	expect(compatibleHistoryValue('1.5', { kind: 'text' }, { kind: 'int' })).toBeUndefined();
});

it('validates current custom shapes instead of silently dropping historical keys', () => {
	const fields = {
		address: {
			description: 'Address',
			shape: { kind: 'object' as const, fields: { line: { kind: 'text' as const } } }
		}
	};
	expect(
		compatibleHistoryValue(
			{ line: 'Street' },
			{ kind: 'custom', of: 'address' },
			{ kind: 'custom', of: 'address' },
			fields
		)
	).toEqual({ line: 'Street' });
	expect(
		compatibleHistoryValue(
			{ line: 'Street', retired: 'Old' },
			{ kind: 'custom', of: 'address' },
			{ kind: 'custom', of: 'address' },
			fields
		)
	).toBeUndefined();
});

it('keeps finite numbers and converts reference cardinalities without changing targets', () => {
	expect(compatibleHistoryValue(1e-7, { kind: 'number' }, { kind: 'number' })).toBe(1e-7);
	expect(compatibleHistoryValue('42', { kind: 'text' }, { kind: 'int' })).toBe(42);
	expect(
		compatibleHistoryValue(
			'id',
			{ kind: 'ref', to: 'people' },
			{ kind: 'ref', to: ['people', 'companies'] }
		)
	).toEqual({ model: 'people', id: 'id' });
	expect(
		compatibleHistoryValue(
			{ model: 'people', id: 'id' },
			{ kind: 'ref', to: ['people', 'companies'] },
			{ kind: 'ref', to: 'people' }
		)
	).toBe('id');
});
