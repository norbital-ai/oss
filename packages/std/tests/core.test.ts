import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Schema } from 'effect';
import {
	isCalendarDate,
	isClockTime,
	isUtcIsoInstant,
	parseUtcInstant
} from '../src/date/index.ts';
import { getErrorMessage } from '../src/error/index.ts';
import { currencyFractionDigits, ISO_CURRENCY, MoneyValueSchema } from '../src/finance/currency.ts';
import { safeParse } from '../src/json/index.ts';
import { hashDefinition, sha256Json, sha256Text } from '../src/reckon/hash.ts';
import { humanize, textSearchMatches } from '../src/string/index.ts';
import { treeFind, treeFlatten } from '../src/tree/index.ts';

describe('retained core utilities', () => {
	it('parses valid JSON and returns null at the invalid boundary', () => {
		assert.deepEqual(safeParse('{"ready":true}'), { ready: true });
		assert.equal(safeParse('{not json'), null);
	});

	it('extracts a synchronous message without changing the input shape', () => {
		assert.equal(getErrorMessage(new Error('failed')), 'failed');
		assert.equal(getErrorMessage('refused'), 'refused');
		assert.equal(getErrorMessage({ message: 409 }), '409');
		assert.equal(getErrorMessage(false), 'false');
	});

	it('retains currency metadata and synchronous fraction lookup', () => {
		assert.equal(currencyFractionDigits('JPY'), 0);
		assert.equal(currencyFractionDigits('kwd'), 3);
		assert.equal(currencyFractionDigits('USD'), 2);
		assert.equal(
			ISO_CURRENCY.some(({ code }) => code === 'USD'),
			true
		);
	});

	it('owns the finite ISO money contract once', () => {
		assert.deepEqual(
			Schema.decodeUnknownSync(MoneyValueSchema)({ value: 12.5, currency: ' SGD ' }),
			{
				value: 12.5,
				currency: 'SGD'
			}
		);
		assert.throws(() =>
			Schema.decodeUnknownSync(MoneyValueSchema)({
				value: Number.POSITIVE_INFINITY,
				currency: 'USD'
			})
		);
	});

	it('retains human labels and bounded literal text search', () => {
		assert.equal(humanize('hr_employee_id'), 'HR Employee Id');
		assert.equal(textSearchMatches('Construction permit', 'constrction'), true);
		assert.equal(textSearchMatches('Construction permit', 'payroll'), false);
	});

	it('retains tree traversal without mutating the input', () => {
		type Node = { readonly id: string; readonly children?: readonly Node[] };
		const tree: readonly Node[] = [
			{ id: 'root', children: [{ id: 'branch', children: [{ id: 'leaf' }] }] }
		];
		assert.deepEqual(
			treeFlatten(tree, 'children').map(({ id }) => id),
			['root', 'branch', 'leaf']
		);
		assert.equal(treeFind(tree, 'children', ({ id }) => id === 'leaf')?.id, 'leaf');
		assert.equal(
			treeFind(tree, 'children', ({ id }) => id === 'missing'),
			null
		);
	});

	it('retains strict temporal validation and parsing', () => {
		const instant = '2026-07-01T02:03:04.000Z';
		assert.equal(isCalendarDate('2026-07-01'), true);
		assert.equal(isCalendarDate('2026-02-30'), false);
		assert.equal(isClockTime('23:59'), true);
		assert.equal(isClockTime('24:00'), false);
		assert.equal(isUtcIsoInstant(instant), true);
		assert.equal(parseUtcInstant(instant).toISOString(), instant);
	});

	it('preserves the synchronous portable SHA-256 bytes', () => {
		assert.equal(
			sha256Text('The quick brown fox jumps over the lazy dog'),
			'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
		);
		assert.equal(
			sha256Json({}),
			'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
		);
		assert.equal(
			hashDefinition({
				id: 'compatibility',
				tables: {},
				exprs: { result: 'amount * 2' },
				outputs: ['result'],
				dependsOn: []
			}),
			'82c5f4246ab6421aaf99a9c90c79302b073f2976f96907ec82e4efc1d4c24cf1'
		);
	});
});
