import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal, currency, dec, minorDigits, sum } from '../src/decimal.ts';
import {
	Instant, PlainDate, Zone, addDays, addMonths, contains, datePeriod, days, eachDay, formatDate, formatInstant, formatPeriod,
	intersect, monthOf, overlaps, parseInstant, yearOf
} from '../src/date.ts';
import { WorkCalendar, addBusinessHours, businessDays, cycleOf, cycles } from '../src/calendar.ts';
import { columns, decode, encode } from '../src/sheet.ts';
import { cloneNext, onlyShortens, sealWrites, voidOnce } from '../src/versioned.ts';
import { compile, context, evaluate, formula } from '../src/formula.ts';
import { band, pricedLines } from '../src/pricing.ts';
import { parseJson } from '../src/json.ts';

const d = PlainDate;

describe('std/decimal', () => {
	it('is one kind of value across std copies: instanceof holds, and each copy reads the other', async () => {
		const other = (await import('../src/decimal.ts?copy' as string)) as typeof import('../src/decimal.ts');
		const theirs = other.Decimal.of('1.20');
		assert.ok(theirs instanceof Decimal);
		assert.ok(Decimal.of('2') instanceof other.Decimal);
		assert.equal(Decimal.of('1').plus(theirs).toString(), '2.20');
		assert.equal(theirs.plus(Decimal.of('1')).toString(), '2.20');
		assert.ok(!('1.2' as unknown instanceof Decimal));
	});
	it('is exact where floats are not', () => {
		assert.equal(dec('0.1').plus('0.2').toString(), '0.3');
		assert.equal(dec('1.20').times('3').toString(), '3.60');
		assert.equal(sum(['1.005', '2', dec('-0.005')]).toString(), '3.000');
		assert.equal(dec('10').div('3', 4).toString(), '3.3333');
		assert.equal(dec('-7').div('2', 0, 'halfEven').toString(), '-4');
		assert.equal(dec('1.2').div('-0.5', 2).toString(), '-2.40');
	});
	it('rounds in every mode like Postgres', () => {
		const r = (v: string, m: Parameters<Decimal['round']>[1]) => dec(v).round(0, m).toString();
		assert.deepEqual(['2.5', '-2.5', '3.5', '2.4'].map((v) => r(v, 'halfUp')), ['3', '-3', '4', '2']);
		assert.deepEqual(['2.5', '-2.5', '3.5'].map((v) => r(v, 'halfEven')), ['2', '-2', '4']);
		assert.deepEqual(['2.1', '-2.1'].map((v) => [r(v, 'floor'), r(v, 'ceil'), r(v, 'down'), r(v, 'up')]), [['2', '3', '2', '3'], ['-3', '-2', '-2', '-3']]);
		assert.equal(dec('1.5').round(3).toString(), '1.500');
	});
	it('guards every door', () => {
		assert.throws(() => dec('1e3'));
		assert.throws(() => dec('abc'));
		assert.throws(() => dec(0.1));
		assert.throws(() => dec('1').div('0', 2));
		assert.throws(() => (dec('1') as unknown as number) + 1);
		assert.equal(Decimal.fromNumber(0.1 + 0.2, 2).toString(), '0.30');
		assert.equal(Decimal.fromNumber(1e-7, 8).toString(), '0.00000010');
		assert.equal(dec({ $dec: '-0.50' }).toJSON(), '-0.50');
		assert.equal(JSON.stringify({ a: dec('1.10') }), '{"a":"1.10"}');
		assert.ok(dec('2').gt('1.99') && dec('1.0').eq('1') && dec('-1').sign() === -1);
	});
	it('knows currencies and their minor units', () => {
		assert.equal(minorDigits(currency('JPY')), 0);
		assert.equal(minorDigits(currency('KWD')), 3);
		assert.equal(dec('10.005').roundTo(currency('SGD')).toString(), '10.01');
		assert.throws(() => currency('ABC'));
	});
});

describe('std/date', () => {
	it('parses and refuses', () => {
		assert.equal(d('2024-02-29'), '2024-02-29');
		assert.throws(() => d('2023-02-29'));
		assert.throws(() => d('2024-02-29T00:00:00Z'));
		assert.equal(d({ $d: '2026-01-01' }), '2026-01-01');
		assert.equal(Instant('2026-01-01T08:00:00+08:00'), '2026-01-01T00:00:00.000Z');
		assert.throws(() => Instant('2026-01-01T08:00:00'));
		assert.throws(() => Zone('Mars/Base'));
		assert.throws(() => datePeriod('2026-02-01', '2026-01-31'));
	});
	it('does inclusive period arithmetic', () => {
		const jan = datePeriod('2026-01-01', '2026-01-31');
		assert.ok(contains(jan, '2026-01-31') && !contains(jan, '2026-02-01'));
		assert.ok(contains({ from: d('2026-01-01'), to: null }, '2099-01-01'));
		assert.ok(overlaps(jan, datePeriod('2026-01-31', null)) && !overlaps(jan, datePeriod('2026-02-01', null)));
		assert.deepEqual(intersect(jan, datePeriod('2026-01-20', null)), { from: '2026-01-20', to: '2026-01-31' });
		assert.equal(intersect(jan, datePeriod('2026-03-01', null)), null);
		assert.equal(days(jan), 31);
		assert.throws(() => days({ from: d('2026-01-01'), to: null }));
		assert.deepEqual(eachDay(datePeriod('2026-12-31', '2027-01-01')), ['2026-12-31', '2027-01-01']);
		assert.equal(addDays('2026-03-01', -1), '2026-02-28');
		assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
		assert.equal(addMonths('2026-03-31', -13), '2025-02-28');
		assert.deepEqual(monthOf('2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
		assert.deepEqual(yearOf('2026-07-04'), { from: '2026-01-01', to: '2026-12-31' });
	});
	it('formats and parses in a zone', () => {
		assert.equal(formatDate('2026-01-05'), 'Jan 5, 2026');
		assert.equal(formatInstant('2026-01-05T16:30:00Z', { timeZone: 'Asia/Singapore', timeStyle: 'short' }), '12:30 AM');
		assert.equal(formatPeriod(datePeriod('2026-01-05', null)), 'Jan 5, 2026 – …');
		assert.equal(formatPeriod(null), '—');
		assert.equal(parseInstant('2026-01-05 09:00', 'Asia/Kuala_Lumpur'), '2026-01-05T01:00:00.000Z');
		assert.equal(parseInstant('2026-03-08 02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z'); // in the DST gap: after it
		assert.equal(parseInstant('2026-11-01 12:00', 'America/New_York'), '2026-11-01T17:00:00.000Z');
		assert.equal(parseInstant('garbage'), null);
		assert.equal(parseInstant('2026-01-05 09:00'), null);
	});
});

describe('std/calendar', () => {
	it('names a cycle by the day it opens', () => {
		assert.deepEqual(cycleOf({ every: 'month', opensOn: 26 }, '2026-02-25'), { from: '2026-01-26', to: '2026-02-25' });
		assert.deepEqual(cycleOf({ every: 'month', opensOn: 26 }, '2026-02-26'), { from: '2026-02-26', to: '2026-03-25' });
		assert.deepEqual(cycleOf({ every: 'month' }, '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
		assert.deepEqual(cycleOf({ every: 'semiMonth' }, '2026-02-20'), { from: '2026-02-16', to: '2026-02-28' });
		assert.deepEqual(cycleOf({ every: 'week', opensOn: 1 }, '2026-09-27'), { from: '2026-09-21', to: '2026-09-27' });
		assert.deepEqual(cycleOf({ every: 'days', n: 14, anchor: '2026-01-05' }, '2026-01-01'), { from: '2025-12-22', to: '2026-01-04' });
		assert.deepEqual(cycles({ every: 'semiMonth' }, datePeriod('2026-01-10', '2026-02-02')).map((c) => c.from), ['2026-01-01', '2026-01-16', '2026-02-01']);
	});
	const day = { start: '09:00', end: '18:00' } as const;
	const cal = WorkCalendar({ zone: 'Asia/Singapore', week: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: null, 7: null }, holidays: ['2026-10-01'] });
	it('counts business days and adds business hours', () => {
		assert.equal(businessDays(datePeriod('2026-09-28', '2026-10-04'), cal), 4); // Mon–Sun, Thursday a holiday
		// Friday 17:00 SGT + 4 h: 1 h Friday, then Monday 09:00 + 3 h = 12:00 SGT
		assert.equal(addBusinessHours('2026-09-25T09:00:00Z', 4, cal), '2026-09-28T04:00:00.000Z');
		// Wednesday 20:00 SGT + 1.5 h skips Thursday's holiday: Friday 10:30 SGT
		assert.equal(addBusinessHours('2026-09-30T12:00:00Z', dec('1.5'), cal), '2026-10-02T02:30:00.000Z');
		assert.equal(addBusinessHours('2026-09-26T00:00:00Z', 0, cal), '2026-09-28T01:00:00.000Z');
		assert.throws(() => WorkCalendar({ zone: 'UTC', week: { ...cal.week, 1: { start: '18:00', end: '09:00' } } }));
	});
});

describe('std/sheet', () => {
	const cols = columns({ employee: 'text', hours: 'decimal', day: 'date', at: { optional: 'time' }, ok: 'bool', kind: { enum: ['a', 'b'] }, span: { period: 'date' } });
	it('decodes typed rows and names every bad cell', () => {
		const out = decode([
			['employee', 'hours', 'day', 'at', 'ok', 'kind', 'span.from', 'span.to'],
			['E1', 7.5, 46000, '9:05', 'yes', 'a', '2026-01-01', ''],
			[null, null, null, null, null, null, null, null],
			['E2', 'x', '2026-13-01', '25:00', 'maybe', 'c', '2026-02-01', '2026-01-01']
		], cols);
		assert.equal(out.rows.length, 1);
		const r = out.rows[0]!;
		assert.equal(r.hours.toString(), '7.5');
		assert.deepEqual([r.employee, r.day, r.at, r.ok, r.kind, r.span], ['E1', '2025-12-09', '09:05', true, 'a', { from: '2026-01-01', to: null }]);
		assert.deepEqual(out.errors.map((e) => `${e.row}:${e.column}`), ['4:hours', '4:day', '4:at', '4:ok', '4:kind', '4:span.to']);
	});
	it('refuses unknown and missing headers', () => {
		const out = decode([['employee', 'hourz']], columns({ employee: 'text', hours: 'decimal' }));
		assert.deepEqual(out.errors, [{ row: 1, column: 'hours', message: 'missing column' }, { row: 1, column: 'hourz', message: 'unknown column' }]);
	});
	it('encodes back to the same header and cells', () => {
		const c = columns({ n: 'text', amount: 'decimal', span: { period: 'date' } });
		const row = { n: 'x', amount: dec('1.50'), span: { from: d('2026-01-01'), to: null } };
		const cells = encode([row], c);
		assert.deepEqual(cells, [['n', 'amount', 'span.from', 'span.to'], ['x', '1.50', '2026-01-01', null]]);
		assert.equal(decode(cells, c).rows[0]!.amount.toString(), '1.50');
	});
});

describe('std/versioned', () => {
	const v = (id: string, from: string, to: string | null, sealed = true) =>
		({ id, period: { from: d(from), to: to === null ? null : d(to) }, sealed_at: sealed ? '2026-01-01T00:00:00.000Z' : null, voided_at: null, void_reason: null, name: id });
	it('seals a draft over its predecessor and before its successor, in one list', () => {
		const writes = sealWrites(v('draft', '2026-04-01', null, false), [v('a', '2026-01-01', null), v('c', '2026-07-01', null)], '2026-09-25T00:00:00.000Z');
		assert.deepEqual(writes, [
			{ target: 'a', set: { period: { from: '2026-01-01', to: '2026-03-31' } } },
			{ target: 'draft', set: { period: { from: '2026-04-01', to: '2026-06-30' }, sealed_at: '2026-09-25T00:00:00.000Z' } }
		]);
		assert.throws(() => sealWrites(v('draft', '2026-01-01', null, false), [v('a', '2026-01-01', null)], '2026-09-25T00:00:00.000Z'));
	});
	it('lets a sealed version only end earlier, or be voided once with a reason', () => {
		const sealed = v('a', '2026-01-01', null);
		assert.equal(onlyShortens(sealed, { period: { from: '2026-01-01', to: '2026-03-31' } }), null);
		assert.match(onlyShortens(sealed, { period: { from: '2026-02-01', to: null } })!, /only end earlier/);
		assert.match(onlyShortens(sealed, { name: 'renamed' })!, /name cannot change/);
		assert.match(onlyShortens(sealed, { lines: { create: [{}] } })!, /lines cannot change/);
		assert.equal(onlyShortens(sealed, { name: 'a', voided_at: 'x' }), null);
		assert.match(voidOnce(sealed, { voided_at: '2026-09-25T00:00:00.000Z' })!, /states its reason/);
		assert.equal(voidOnce(sealed, { voided_at: '2026-09-25T00:00:00.000Z', void_reason: 'wrong rate' }), null);
		const voided = { ...sealed, voided_at: '2026-09-25T00:00:00.000Z', void_reason: 'wrong rate' };
		assert.match(voidOnce(voided, { voided_at: null })!, /never undone/);
		assert.match(voidOnce(voided, { void_reason: 'other' })!, /part of the record/);
		assert.match(voidOnce(sealed, { void_reason: 'why' })!, /only with a void/);
	});
	it('clones the successor draft with its children as creates', () => {
		const next = cloneNext(v('a', '2026-01-01', null), '2026-07-01', { lines: [{ id: 'l1', sku: 'X', price: '1.00' }] });
		assert.deepEqual(next, { name: 'a', period: { from: '2026-07-01', to: null }, lines: { create: [{ sku: 'X', price: '1.00' }] } });
	});
});

describe('std/formula', () => {
	const person = { kind: 'object', fields: { age: { kind: 'int' }, salary: { kind: 'money' }, kids: { kind: 'list', of: { kind: 'object', fields: { age: { kind: 'int' } } } } } } as const;
	const site = context({ person, base: { kind: 'money' }, day: { kind: 'date' } }, {
		functions: { adults: { signature: 'map.adults(int): int', fn: (p: { kids: { age: bigint }[] }, age: bigint) => BigInt(p.kids.filter((k) => k.age >= age).length) } }
	});
	const values = { person: { age: 40, salary: '5000.00', kids: [{ age: 20 }, { age: 3 }] }, base: dec('1000.10'), day: '2026-09-25' };
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
		assert.deepEqual(compile(site, 'person.agex > 3', 'bool'), { error: 'unknown path person.agex' });
		assert.match((compile(site, 'person.kids.size() >', 'bool') as { error: string }).error, /./);
		assert.match((compile(site, 'base * 2', 'bool') as { error: string }).error, /expected a yes\/no result, got Decimal/);
		assert.match((compile(site, 'nobody + 1', 'decimal') as { error: string }).error, /nobody/);
		assert.equal(formula(site, 'bool')('person.age > 18'), undefined);
		assert.equal(formula(site, 'bool')('person.nope'), 'unknown path person.nope');
	});
	it('keeps float mode for law written against doubles', () => {
		const law = context({ wage: { kind: 'decimal', scale: 2 } as { kind: 'decimal' }, age: { kind: 'int' } }, { numbers: 'float' });
		const c = compile(law, 'wage * 0.2 + age * 2', 'decimal');
		assert.ok(!('error' in c));
		assert.equal(evaluate(c, { wage: dec('100.5'), age: 3 }), 26.1);
	});
	it('types a derived root builder (M1)', () => {
		const derived = context({ age: { kind: 'int' } }, { derive: (rows: { birth: string }[]) => ({ age: 2026 - Number(rows[0]!.birth.slice(0, 4)) }) });
		const c = compile(derived, 'age >= 18', 'bool');
		assert.ok(!('error' in c) && evaluate(c, derived.derive([{ birth: '2000-01-01' }])) === true);
	});
});

describe('std/pricing (M2)', () => {
	const site = context({ quantity: { kind: 'decimal' }, rate: { kind: 'money' }, rest_day: { kind: 'bool' } });
	const bands = [
		{ when: '!rest_day', take: '2', price: 'quantity * rate * 1.5', label: 'OT 1.5×' },
		{ price: 'quantity * rate * 2', label: 'OT 2×' }
	];
	it('slices a quantity through the bands that hold', () => {
		const s = band(site, bands, { rate: dec('10'), rest_day: false }, '3.5');
		assert.deepEqual(s.map((x) => [x.label, x.quantity?.toString(), x.amount.toString()]), [['OT 1.5×', '2', '30.0'], ['OT 2×', '1.5', '30.0']]);
		assert.deepEqual(band(site, bands, { rate: dec('10'), rest_day: true }, '3').map((x) => x.amount.toString()), ['60']);
	});
	it('prices catalogue lines into buckets', () => {
		const lines = pricedLines(site, [
			{ code: 'OT', label: 'Overtime', bucket: 'EARNING', quantity: '3', bands },
			{ code: 'MEAL', label: 'Meal', bucket: 'EARNING', bands: [{ when: 'rate > 5', price: '12.50' }] }
		], { rate: dec('10'), rest_day: false });
		assert.deepEqual(lines.map((l) => [l.code, l.label, l.bucket, l.amount.toString()]),
			[['OT', 'OT 1.5×', 'EARNING', '30.0'], ['OT', 'OT 2×', 'EARNING', '20'], ['MEAL', 'Meal', 'EARNING', '12.5']]);
	});
});

describe('std/json', () => {
	it('parses or answers null', () => {
		assert.deepEqual(parseJson('{"a":[1]}'), { a: [1] });
		assert.equal(parseJson('{nope'), null);
	});
});
