import { expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Json } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import { Array as Arr } from 'effect';
import { displayWireValue } from '../src/shell/wire-value.ts';

const record = (value: Value | undefined) => {
	if (
		value === undefined ||
		value === null ||
		typeof value !== 'object' ||
		Arr.isArray<Value>(value) ||
		value instanceof Decimal
	)
		throw new Error('Expected a projected record.');
	return value;
};

it('revives exact wire decimal tags at any depth without losing precision or changing the source', () => {
	const amount = '99999999999999999999999999.120000';
	const source = { total: { $dec: amount }, lines: [{ amount: { $dec: '-0.00500' } }] };
	const displayed = record(displayWireValue(source));
	const total = displayed['total'];
	expect(total).toBeInstanceOf(Decimal);
	expect(String(total)).toBe(amount);
	const lines = displayed['lines'];
	if (lines === undefined || !Arr.isArray<Value>(lines))
		throw new Error('Expected projected lines.');
	const nestedAmount = record(lines[0])['amount'];
	expect(nestedAmount).toBeInstanceOf(Decimal);
	expect(String(nestedAmount)).toBe('-0.00500');
	expect(JSON.stringify(displayed)).toBe(JSON.stringify(source));
	expect(source).toEqual({ total: { $dec: amount }, lines: [{ amount: { $dec: '-0.00500' } }] });
});

it('preserves primitive values, unknown keys and ordinary tag-shaped objects', () => {
	for (const value of [
		null,
		false,
		0,
		'',
		'1.20',
		{ $dec: 'invalid' },
		{ $dec: '1e3' },
		{ $dec: '' },
		{ $dec: 12 },
		{ $dec: '1.20', currency: 'SGD' },
		{ $other: 'value', nested: { empty: null, enabled: false } }
	] satisfies readonly Json[])
		expect(displayWireValue(value)).toEqual(value);
});
