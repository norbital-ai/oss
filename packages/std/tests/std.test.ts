import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Decimal, currency, dec, minor_digits, sum } from '../src/decimal.ts';
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
} from '../src/date.ts';
import { Cycle, WorkCalendar, add_business_hours, business_days, cycle_of, cycles } from '../src/calendar.ts';
import { columns, decode, encode } from '../src/sheet.ts';
import { clone_next, only_shortens, seal_writes, void_once } from '../src/versioned.ts';
import { compile, context, evaluate, formula } from '../src/formula.ts';
import { band, priced_lines } from '../src/pricing.ts';
import { parse_json, parse_json_result } from '../src/json.ts';
import { Effect, Schema } from 'effect';
import * as Result from 'effect/Result';
import { input_schema } from '../src/kind.ts';

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
	it('is one kind of value across std copies: instanceof holds, and each copy reads the other', async () => {
		const copy: string = '../src/decimal.ts?copy';
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

describe('std/calendar', () => {
	it('refuses retired cycle metadata instead of silently changing the selected pay period', () => {
		const monthly = { every: 'month', opensOn: 26 } as const;
		const semi_monthly = { every: 'semi_month', secondOpensOn: 11 } as const;
		assert.throws(() => cycle_of(monthly, '2026-02-25'));
		assert.throws(() => cycle_of(semi_monthly, '2026-02-20'));
		assert.throws(() => Schema.decodeUnknownSync(Cycle)({ every: 'semiMonth' }));
		assert.deepEqual(cycle_of({ every: 'semi_month', second_opens_on: 11 }, '2026-02-10'), {
			from: '2026-02-01', to: '2026-02-10'
		});
		assert.deepEqual(cycle_of({ every: 'semi_month', second_opens_on: 11 }, '2026-02-11'), {
			from: '2026-02-11', to: '2026-02-28'
		});
	});
	it('names a cycle by the day it opens', () => {
		assert.deepEqual(cycle_of({ every: 'month', opens_on: 26 }, '2026-02-25'), {
			from: '2026-01-26',
			to: '2026-02-25'
		});
		assert.deepEqual(cycle_of({ every: 'month', opens_on: 26 }, '2026-02-26'), {
			from: '2026-02-26',
			to: '2026-03-25'
		});
		assert.deepEqual(cycle_of({ every: 'month' }, '2026-02-10'), {
			from: '2026-02-01',
			to: '2026-02-28'
		});
		assert.deepEqual(cycle_of({ every: 'semi_month' }, '2026-02-20'), {
			from: '2026-02-16',
			to: '2026-02-28'
		});
		assert.deepEqual(cycle_of({ every: 'week', opens_on: 1 }, '2026-09-27'), {
			from: '2026-09-21',
			to: '2026-09-27'
		});
		assert.deepEqual(cycle_of({ every: 'days', n: 14, anchor: '2026-01-05' }, '2026-01-01'), {
			from: '2025-12-22',
			to: '2026-01-04'
		});
		assert.deepEqual(
			cycles({ every: 'semi_month' }, date_period('2026-01-10', '2026-02-02')).map((c) => c.from),
			['2026-01-01', '2026-01-16', '2026-02-01']
		);
	});
	const day = { start: '09:00', end: '18:00' } as const;
	const cal = WorkCalendar({
		zone: 'Asia/Singapore',
		week: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: null, 7: null },
		holidays: ['2026-10-01']
	});
	it('counts business days and adds business hours', () => {
		assert.equal(business_days(date_period('2026-09-28', '2026-10-04'), cal), 4); // Mon–Sun, Thursday a holiday
		// Friday 17:00 SGT + 4 h: 1 h Friday, then Monday 09:00 + 3 h = 12:00 SGT
		assert.equal(add_business_hours('2026-09-25T09:00:00Z', 4, cal), '2026-09-28T04:00:00.000Z');
		// Wednesday 20:00 SGT + 1.5 h skips Thursday's holiday: Friday 10:30 SGT
		assert.equal(
			add_business_hours('2026-09-30T12:00:00Z', dec('1.5'), cal),
			'2026-10-02T02:30:00.000Z'
		);
		assert.equal(add_business_hours('2026-09-26T00:00:00Z', 0, cal), '2026-09-28T01:00:00.000Z');
		assert.throws(() =>
			WorkCalendar({ zone: 'UTC', week: { ...cal.week, 1: { start: '18:00', end: '09:00' } } })
		);
	});
});

describe('std/sheet', () => {
	const cols = columns({
		employee: 'text',
		hours: 'decimal',
		day: 'date',
		at: { optional: 'time' },
		ok: 'bool',
		kind: { enum: ['a', 'b'] },
		span: { period: 'date' }
	});
	it('decodes typed rows and names every bad cell', () => {
		const out = decode(
			[
				['employee', 'hours', 'day', 'at', 'ok', 'kind', 'span.from', 'span.to'],
				['E1', 7.5, 46000, '9:05', 'yes', 'a', '2026-01-01', ''],
				[null, null, null, null, null, null, null, null],
				['E2', 'x', '2026-13-01', '25:00', 'maybe', 'c', '2026-02-01', '2026-01-01']
			],
			cols
		);
		assert.equal(out.rows.length, 1);
		const r = out.rows[0];
		assert.ok(r);
		assert.equal(r.hours.toString(), '7.5');
		assert.deepEqual(
			[r.employee, r.day, r.at, r.ok, r.kind, r.span],
			['E1', '2025-12-09', '09:05', true, 'a', { from: '2026-01-01', to: null }]
		);
		assert.deepEqual(
			out.errors.map((e) => `${e.row}:${e.column}`),
			['4:hours', '4:day', '4:at', '4:ok', '4:kind', '4:span.to']
		);
	});
	it('refuses unknown and missing headers', () => {
		const out = decode([['employee', 'hourz']], columns({ employee: 'text', hours: 'decimal' }));
		assert.deepEqual(out.errors, [
			{ row: 1, column: 'hours', message: 'missing column' },
			{ row: 1, column: 'hourz', message: 'unknown column' }
		]);
	});
	it('encodes back to the same header and cells', () => {
		const c = columns({ n: 'text', amount: 'decimal', span: { period: 'date' } });
		const row = { n: 'x', amount: dec('1.50'), span: { from: d('2026-01-01'), to: null } };
		const cells = encode([row], c);
		assert.deepEqual(cells, [
			['n', 'amount', 'span.from', 'span.to'],
			['x', '1.50', '2026-01-01', null]
		]);
		const decoded = decode(cells, c).rows[0];
		assert.ok(decoded);
		assert.equal(decoded.amount.toString(), '1.50');
	});
});

describe('std/versioned', () => {
	const v = (id: string, from: string, to: string | null, sealed = true) => ({
		id,
		revision: 1,
		period: { from: d(from), to: to === null ? null : d(to) },
		sealed_at: sealed ? '2026-01-01T00:00:00.000Z' : null,
		voided_at: null,
		void_reason: null,
		name: id
	});
	it('seals a draft over its predecessor and before its successor, in one list', () => {
		const writes = seal_writes(
			v('draft', '2026-04-01', null, false),
			[v('a', '2026-01-01', null), v('c', '2026-07-01', null)],
			'2026-09-25T00:00:00.000Z'
		);
		assert.deepEqual(writes, [
			{
				target: v('a', '2026-01-01', null),
				set: { period: { from: '2026-01-01', to: '2026-03-31' } }
			},
			{
				target: v('draft', '2026-04-01', null, false),
				set: {
					period: { from: '2026-04-01', to: '2026-06-30' },
					sealed_at: '2026-09-25T00:00:00.000Z'
				}
			}
		]);
		assert.throws(() =>
			seal_writes(
				v('draft', '2026-01-01', null, false),
				[v('a', '2026-01-01', null)],
				'2026-09-25T00:00:00.000Z'
			)
		);
	});
	it('lets a sealed version only end earlier, or be voided once with a reason', () => {
		const sealed = v('a', '2026-01-01', null);
		assert.equal(only_shortens(sealed, { period: { from: '2026-01-01', to: '2026-03-31' } }), null);
		assert.match(
			only_shortens(sealed, { period: { from: '2026-02-01', to: null } }) ?? '',
			/only end earlier/
		);
		assert.match(only_shortens(sealed, { name: 'renamed' }) ?? '', /name cannot change/);
		assert.match(only_shortens(sealed, { lines: { create: [{}] } }) ?? '', /lines cannot change/);
		assert.equal(only_shortens(sealed, { name: 'a', voided_at: 'x' }), null);
		assert.match(
			void_once(sealed, { voided_at: '2026-09-25T00:00:00.000Z' }) ?? '',
			/states its reason/
		);
		assert.equal(
			void_once(sealed, { voided_at: '2026-09-25T00:00:00.000Z', void_reason: 'wrong rate' }),
			null
		);
		const voided = { ...sealed, voided_at: '2026-09-25T00:00:00.000Z', void_reason: 'wrong rate' };
		assert.match(void_once(voided, { voided_at: null }) ?? '', /never undone/);
		assert.match(void_once(voided, { void_reason: 'other' }) ?? '', /part of the record/);
		assert.match(void_once(sealed, { void_reason: 'why' }) ?? '', /only with a void/);
	});
	it('compares values structurally: key order is no change, a decimal compares by its exact text', () => {
		const sealed = {
			...v('a', '2026-01-01', null),
			meta: { b: 2, a: [1, { y: 'y', x: 'x' }] },
			rate: dec('1.20')
		};
		assert.equal(only_shortens(sealed, { meta: { a: [1, { x: 'x', y: 'y' }], b: 2 } }), null);
		assert.equal(only_shortens(sealed, { rate: { $dec: '1.20' } }), null);
		assert.match(only_shortens(sealed, { rate: dec('1.2') }) ?? '', /rate cannot change/);
		assert.match(
			only_shortens(sealed, { meta: { a: [{ x: 'x', y: 'y' }, 1], b: 2 } }) ?? '',
			/meta cannot change/
		);
	});
	it('clones the successor draft with its children as creates', () => {
		const next = clone_next(v('a', '2026-01-01', null), '2026-07-01', {
			lines: [{ id: 'l1', sku: 'X', price: '1.00' }]
		});
		assert.deepEqual(next, {
			name: 'a',
			period: { from: '2026-07-01', to: null },
			lines: { create: [{ sku: 'X', price: '1.00' }] }
		});
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

describe('std/pricing (M2)', () => {
	const site = context({
		quantity: { kind: 'decimal' },
		rate: { kind: 'money' },
		rest_day: { kind: 'bool' }
	});
	const bands = [
		{ when: '!rest_day', take: '2', price: 'quantity * rate * 1.5', label: 'OT 1.5×' },
		{ price: 'quantity * rate * 2', label: 'OT 2×' }
	];
	it('slices a quantity through the bands that hold', () => {
		const s = Result.getOrThrow(band(site, bands, { rate: dec('10'), rest_day: false }, '3.5'));
		assert.deepEqual(
			s.map((x) => [x.label, x.quantity?.toString(), x.amount.toString()]),
			[
				['OT 1.5×', '2', '30.0'],
				['OT 2×', '1.5', '30.0']
			]
		);
		assert.deepEqual(
			Result.getOrThrow(band(site, bands, { rate: dec('10'), rest_day: true }, '3')).map((x) =>
				x.amount.toString()
			),
			['60']
		);
	});
	it('prices catalogue lines into buckets', () => {
		const lines = Result.getOrThrow(priced_lines(
			site,
			[
				{ code: 'OT', label: 'Overtime', bucket: 'EARNING', quantity: '3', bands },
				{
					code: 'MEAL',
					label: 'Meal',
					bucket: 'EARNING',
					bands: [{ when: 'rate > 5', price: '12.50' }]
				}
			],
			{ rate: dec('10'), rest_day: false }
		));
		assert.deepEqual(
			lines.map((l) => [l.code, l.label, l.bucket, l.amount.toString()]),
			[
				['OT', 'OT 1.5×', 'EARNING', '30.0'],
				['OT', 'OT 2×', 'EARNING', '20'],
				['MEAL', 'Meal', 'EARNING', '12.5']
			]
		);
	});
});

describe('std/json', () => {
	it('distinguishes invalid text from JSON scalars without changing native number behavior', () => {
		for (const [text, value] of [
			['null', null],
			['false', false],
			['0', 0],
			['1e400', Infinity],
			['[1,{"a":true}]', [1, { a: true }]]
		] as const) {
			const result = parse_json_result(text);
			assert.equal(result._tag, 'Success');
			if (result._tag === 'Success') assert.deepEqual(result.success, value);
		}
		for (const text of ['', '{nope', '{"a":']) assert.equal(parse_json_result(text)._tag, 'Failure');
	});
	it('parses or answers null', () => {
		assert.deepEqual(parse_json('{"a":[1]}'), { a: [1] });
		assert.equal(parse_json('{nope'), null);
	});
});
