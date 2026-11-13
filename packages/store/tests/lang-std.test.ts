import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Decimal, currency, dec, minor_digits, sum } from '../src/lang/decimal.ts';
import {
	Instant,
	PlainDate,
	Zone,
	add_days,
	add_months,
	contains,
	date_period,
	days,
	each_day,
	format_date,
	format_instant,
	format_period,
	intersect,
	is_plain_date,
	month_of,
	overlaps,
	parse_instant,
	year_of
} from '../src/lang/date.ts';
import { compile, context, evaluate, formula } from '../src/lang/formula.ts';
import { Effect, Schema } from 'effect';
import * as Result from 'effect/Result';
import { input_schema } from '../src/lang/kind.ts';

const d = PlainDate;

describe('native kind values', () => {
	it.effect('nested stored lists and objects decode decimals exactly with ISO dates', () =>
		Effect.gen(function* () {
			const schema = input_schema({
				kind: 'object',
				fields: {
					lines: {
						kind: 'object',
						fields: { amount: { kind: 'decimal', scale: 2 }, day: { kind: 'date' } },
						many: true
					}
				}
			});
			const value = yield* Schema.decodeUnknownEffect(schema)({
				lines: [{ amount: { $dec: '12345678901234567.89' }, day: '2026-10-15' }]
			});
			assert.deepEqual(value, {
				lines: [{ amount: Decimal.of('12345678901234567.89'), day: '2026-10-15' }]
			});
		})
	);
	it.effect(
		'required fields reject null even when one union arm is optional, while descendants remain optional',
		() =>
			Effect.gen(function* () {
				const schema = input_schema({
					kind: 'object',
					fields: {
						choice: { kind: 'union', of: [{ kind: 'text', optional: true }, { kind: 'int' }] },
						details: { kind: 'object', fields: { note: { kind: 'text', optional: true } } }
					}
				});
				const refused = yield* Schema.decodeUnknownEffect(schema)({
					choice: null,
					details: {}
				}).pipe(Effect.result);
				assert.equal(refused._tag, 'Failure');
				const accepted = yield* Schema.decodeUnknownEffect(schema)({
					choice: 'yes',
					details: { note: null }
				});
				assert.deepEqual(accepted, { choice: 'yes', details: { note: null } });
			})
	);
});

describe('std/decimal', () => {
	it('is one kind of value across module copies: instanceof holds, and each copy reads the other', async () => {
		const copy: string = '../src/lang/decimal.ts?copy';
		const loaded: unknown = await import(copy);
		const other = Schema.decodeUnknownSync(Schema.Struct({ Decimal: Schema.Unknown }))(loaded).Decimal;
		if (typeof other !== 'function' || !('of' in other) || typeof other.of !== 'function')
			throw new Error('The copied module exposes no Decimal constructor.');
		const theirs: unknown = other.of('1.20');
		assert.ok(theirs instanceof Decimal);
		assert.ok(Decimal.of('2') instanceof other);
		assert.equal(Decimal.of('1').plus(theirs).toString(), '2.20');
		assert.equal(theirs.plus(Decimal.of('1')).toString(), '2.20');
		const text: unknown = '1.2';
		assert.ok(!(text instanceof Decimal));
	});
	it('is exact where floats are not', () => {
		assert.equal(dec('0.1').plus('0.2').toString(), '0.3');
		assert.equal(dec('1.20').times('3').toString(), '3.60');
		assert.equal(sum(['1.005', '2', dec('-0.005')]).toString(), '3.000');
		assert.equal(dec('10').div('3', 4).toString(), '3.3333');
		assert.equal(dec('-7').div('2', 0, 'half_even').toString(), '-4');
		assert.equal(dec('1.2').div('-0.5', 2).toString(), '-2.40');
	});
	it('rounds in every mode like Postgres', () => {
		const r = (v: string, m: Parameters<Decimal['round']>[1]) => dec(v).round(0, m).toString();
		assert.deepEqual(
			['2.5', '-2.5', '3.5', '2.4'].map((v) => r(v, 'half_up')),
			['3', '-3', '4', '2']
		);
		assert.deepEqual(
			['2.5', '-2.5', '3.5'].map((v) => r(v, 'half_even')),
			['2', '-2', '4']
		);
		assert.deepEqual(
			['2.1', '-2.1'].map((v) => [r(v, 'floor'), r(v, 'ceil'), r(v, 'down'), r(v, 'up')]),
			[
				['2', '3', '2', '3'],
				['-3', '-2', '-2', '-3']
			]
		);
		assert.equal(dec('1.5').round(3).toString(), '1.500');
	});
	it('guards every door', () => {
		assert.throws(() => dec('1e3'));
		assert.throws(() => dec('abc'));
		assert.throws(() => dec(0.1));
		assert.throws(() => dec('1').div('0', 2));
		assert.throws(() => Number(dec('1')) + 1);
		assert.equal(Decimal.from_number(0.1 + 0.2, 2).toString(), '0.30');
		assert.equal(Decimal.from_number(1e-7, 8).toString(), '0.00000010');
		assert.deepEqual(dec({ $dec: '-0.50' }).toJSON(), { $dec: '-0.50' });
		assert.equal(JSON.stringify({ a: dec('1.10') }), '{"a":{"$dec":"1.10"}}');
		assert.ok(dec('2').gt('1.99') && dec('1.0').eq('1') && dec('-1').sign() === -1);
	});
	it('knows currencies and their minor units', () => {
		assert.equal(minor_digits(currency('JPY')), 0);
		assert.equal(minor_digits(currency('KWD')), 3);
		assert.equal(dec('10.005').round_to(currency('SGD')).toString(), '10.01');
		assert.throws(() => currency('ABC'));
	});
});

describe('std/date', () => {
	it('parses and refuses', () => {
		assert.equal(d('2024-02-29'), '2024-02-29');
		assert.throws(() => d('2023-02-29'));
		assert.throws(() => d('2024-02-29T00:00:00Z'));
		assert.equal(Instant('2026-01-01T08:00:00+08:00'), '2026-01-01T00:00:00.000Z');
		assert.throws(() => Instant('2026-01-01T08:00:00'));
		assert.throws(() => Zone('Mars/Base'));
		assert.throws(() => date_period('2026-02-01', '2026-01-31'));
	});
	it('does inclusive period arithmetic', () => {
		const jan = date_period('2026-01-01', '2026-01-31');
		assert.ok(contains(jan, '2026-01-31') && !contains(jan, '2026-02-01'));
		assert.ok(contains({ from: d('2026-01-01'), to: null }, '2099-01-01'));
		assert.ok(
			overlaps(jan, date_period('2026-01-31', null)) &&
				!overlaps(jan, date_period('2026-02-01', null))
		);
		assert.deepEqual(intersect(jan, date_period('2026-01-20', null)), {
			from: '2026-01-20',
			to: '2026-01-31'
		});
		assert.equal(intersect(jan, date_period('2026-03-01', null)), null);
		assert.equal(days(jan), 31);
		assert.throws(() => days({ from: d('2026-01-01'), to: null }));
		assert.deepEqual(each_day(date_period('2026-12-31', '2027-01-01')), ['2026-12-31', '2027-01-01']);
		assert.equal(add_days('2026-03-01', -1), '2026-02-28');
		assert.equal(add_months('2024-01-31', 1), '2024-02-29');
		assert.equal(add_months('2026-03-31', -13), '2025-02-28');
		assert.deepEqual(month_of('2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
		assert.deepEqual(year_of('2026-07-04'), { from: '2026-01-01', to: '2026-12-31' });
	});
	it('validates Gregorian century boundaries and four-digit calendar years', () => {
		for (const value of [
			'0000-02-29',
			'0004-02-29',
			'0400-02-29',
			'1600-02-29',
			'2000-02-29',
			'9999-12-31'
		]) {
			assert.equal(is_plain_date(value), true);
			assert.equal(PlainDate(value), value);
		}
		for (const value of [
			'0100-02-29',
			'1700-02-29',
			'1900-02-29',
			'2100-02-29',
			'2026-04-31',
			'2026-00-01',
			'2026-13-01',
			'2026-01-00',
			'2026-01-01\n',
			'10000-01-01'
		]) {
			assert.equal(is_plain_date(value), false);
			assert.throws(() => PlainDate(value), RangeError);
		}
		for (const value of [null, undefined, 20260101, new Date('2026-01-01'), {}, []])
			assert.equal(is_plain_date(value), false);
		assert.equal(add_months('0000-03-31', -1), '0000-02-29');
		assert.equal(add_months('0099-12-31', 1), '0100-01-31');
		assert.equal(add_months('0100-03-31', -1), '0100-02-28');
		assert.equal(add_months('2026-01-31', -0.5), '2026-01-31');
		assert.equal(add_months('2026-03-31', -2.5), '2026-01-31');
		for (const offset of [Number.NaN, Infinity, -Infinity])
			assert.throws(() => add_months('2026-01-01', offset), RangeError);
		assert.throws(() => add_months('0000-01-01', -1), RangeError);
		assert.throws(() => add_months('9999-12-31', 1), RangeError);
	});
	it('matches native calendar clamping throughout a Gregorian 400-year cycle', () => {
		const two = (value: number) => String(value).padStart(2, '0');
		for (let year = 2000; year < 2400; year++) {
			for (let month = 1; month <= 12; month++) {
				const first = new Date(`${year}-${two(month)}-01T00:00:00Z`);
				const end = new Date(first);
				end.setUTCMonth(end.getUTCMonth() + 1);
				end.setUTCDate(0);
				for (const day of [1, end.getUTCDate()]) {
					const source = `${year}-${two(month)}-${two(day)}`;
					assert.equal(PlainDate(source), source);
					for (const offset of [-13, -1, 1, 13]) {
						const expected = new Date(first);
						expected.setUTCMonth(expected.getUTCMonth() + offset);
						const last = new Date(expected);
						last.setUTCMonth(last.getUTCMonth() + 1);
						last.setUTCDate(0);
						expected.setUTCDate(Math.min(day, last.getUTCDate()));
						assert.equal(add_months(source, offset), expected.toISOString().slice(0, 10));
					}
				}
			}
		}
	});
	it('formats and parses in a zone', () => {
		assert.equal(format_date('2026-01-05'), 'Jan 5, 2026');
		assert.equal(
			format_instant('2026-01-05T16:30:00Z', { timeZone: 'Asia/Singapore', timeStyle: 'short' }),
			'12:30 AM'
		);
		assert.equal(format_period(date_period('2026-01-05', null)), 'Jan 5, 2026 – …');
		assert.equal(format_period(null), '—');
		assert.equal(parse_instant('2026-01-05 09:00', 'Asia/Kuala_Lumpur'), '2026-01-05T01:00:00.000Z');
		assert.equal(parse_instant('2026-03-08 02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z'); // in the DST gap: after it
		assert.equal(parse_instant('2026-11-01 12:00', 'America/New_York'), '2026-11-01T17:00:00.000Z');
		assert.equal(parse_instant('garbage'), null);
		assert.equal(parse_instant('2026-01-05 09:00'), null);
	});
});

describe('std/formula', () => {
	const person = {
		kind: 'object',
		fields: {
			age: { kind: 'int' },
			salary: { kind: 'money' },
			kids: { kind: 'object', fields: { age: { kind: 'int' } }, many: true }
		}
	} as const;
	const site = context(
		{ person, base: { kind: 'money' }, day: { kind: 'date' } },
		{
			functions: {
				adults: {
					signature: 'map.adults(int): int',
					fn: (p: { kids: { age: bigint }[] }, age: bigint) =>
						BigInt(p.kids.filter((k) => k.age >= age).length)
				}
			}
		}
	);
	const values = {
		person: { age: 40, salary: '5000.00', kids: [{ age: 20 }, { age: 3 }] },
		base: dec('1000.10'),
		day: '2026-09-25'
	};
	const run = <T extends 'bool' | 'decimal' | 'int' | 'date' | 'text'>(text: string, result: T) => {
		const c = compile(site, text, result);
		if ('error' in c) throw new Error(c.error);
		return evaluate(c, values);
	};
	it('evaluates exact decimals', () => {
		assert.equal(String(run('base * 0.17 + person.salary / 3', 'decimal')), '1836.683666666667');
		assert.equal(String(run('round(base * 0.17, 2)', 'decimal')), '170.02');
		assert.equal(run('person.salary > base && person.age >= 40', 'bool'), true);
		assert.equal(run('person.adults(18)', 'int'), 1);
		assert.equal(run('day', 'date'), '2026-09-25');
		assert.equal(String(run('base + 1', 'decimal')), '1001.10');
	});
	it('names the unknown path, the syntax fault and the wrong type at compile', () => {
		assert.deepEqual(compile(site, 'person.agex > 3', 'bool'), {
			error: 'unknown path person.agex'
		});
		const syntax = compile(site, 'person.kids.size() >', 'bool');
		assert.ok('error' in syntax);
		assert.match(syntax.error, /./);
		const resultType = compile(site, 'base * 2', 'bool');
		assert.ok('error' in resultType);
		assert.match(resultType.error, /expected a yes\/no result, got Decimal/);
		const unknown = compile(site, 'nobody + 1', 'decimal');
		assert.ok('error' in unknown);
		assert.match(unknown.error, /nobody/);
		assert.equal(formula(site, 'bool')('person.age > 18'), undefined);
		assert.equal(formula(site, 'bool')('person.nope'), 'unknown path person.nope');
		// the walk reaches every operand position: call arguments, receivers, ternaries, lists and maps
		for (const text of [
			'round(person.nope, 2) > 1',
			'person.nope.size() > 0',
			'base > 1 ? person.nope : 1',
			'[person.nope].size() > 0',
			'{"a": person.nope}.size() > 0',
			'!(person.nope)'
		])
			assert.equal(formula(site, 'bool')(text), 'unknown path person.nope', text);
	});
	it('keeps float mode for law written against doubles', () => {
		const law = context(
			{ wage: { kind: 'decimal', scale: 2 }, age: { kind: 'int' } },
			{ numbers: 'float' }
		);
		const c = compile(law, 'wage * 0.2 + age * 2', 'decimal');
		assert.ok(!('error' in c));
		assert.equal(evaluate(c, { wage: dec('100.5'), age: 3 }), 26.1);
	});
	it('types a derived root builder (M1)', () => {
		const derived = context(
			{ age: { kind: 'int' } },
			{
				derive: (rows: { birth: string }[]) => {
					const person = rows[0];
					assert.ok(person);
					return { age: 2026 - Number(person.birth.slice(0, 4)) };
				}
			}
		);
		const c = compile(derived, 'age >= 18', 'bool');
		assert.ok(!('error' in c) && evaluate(c, derived.derive([{ birth: '2000-01-01' }])) === true);
	});
});
