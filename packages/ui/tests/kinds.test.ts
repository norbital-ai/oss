import assert from 'node:assert/strict';
import { it as test } from '@effect/vitest';
import './resolve.ts';
import { Decimal } from '@norbital-ai/std/decimal';
import { KIND, type Kind } from '@norbital-ai/std/kind';
import { KINDS, sortable } from '../src/kinds/registry.ts';
import { sortable as sortableFields } from '../src/filter/filter.ts';

const k = await import('../src/kinds/kind.ts');

test('native values keep exact decimals, native ISO dates and nested values', () => {
	const amount = Decimal.of('12345678901234567.89');
	assert.equal(k.formatValue(amount), '12,345,678,901,234,567.89');
	assert.equal(k.formatValue(amount, 'de-DE'), '12.345.678.901.234.567,89');
	assert.equal(k.formatValue('2026-09-25'), '2026-09-25');
	assert.equal(k.formatValue({ from: '2026-01-01', to: null }), '2026-01-01 – …');
	assert.equal(k.formatValue([Decimal.of('1')]), '1');
	const kind = {
		kind: 'object',
		fields: { amounts: { kind: 'list', of: { kind: 'decimal', scale: 2 } } }
	} as const;
	const values = { amounts: [amount] };
	assert.equal(k.problems(kind, values).size, 0);
});

test('kind matrix: picker and view sortability share the canonical traits', () => {
	for (const [name, presentation] of Object.entries(KINDS)) {
		const canonical = Object.entries(KIND).find(([kind]) => kind === name)?.[1];
		assert.ok(canonical, name);
		assert.equal(presentation.sortable, canonical.traits.sortable);
	}
	const fields = {
		title: { kind: 'text' },
		tags: { kind: 'text', many: true },
		list: { kind: 'list', of: { kind: 'text' } },
		object: { kind: 'object', fields: {} },
		amount: { kind: 'decimal', scale: 2 }
	} satisfies Record<string, Kind>;
	const exposure = { label: Object.keys(fields), fields };
	const offered = sortableFields(exposure);
	for (const [name, kind] of Object.entries(fields)) {
		assert.equal(offered.includes(name), sortable(kind));
		assert.deepEqual(
			k.pickerRead(exposure, [name], { limit: 20 }, '').orderBy,
			sortable(kind) ? { [name]: 'asc' } : undefined
		);
	}
});

test('money formats exactly in its currency minor digits', () => {
	assert.equal(k.minorDigits('JPY'), 0);
	assert.equal(k.minorDigits('BHD'), 3);
	assert.equal(
		k.format({ kind: 'money', currency: 'SGD' }, Decimal.of('1234567.5'), {
			locale: 'en',
			currency: 'SGD'
		}),
		'SGD 1,234,567.50'
	);
	assert.equal(k.moneyProblem('10.005', 'SGD'), 'SGD has 2 decimal places');
	assert.equal(k.moneyProblem('10.50', 'SGD'), null);
	// a declared scale (a unit price) keeps its places beyond the minor unit and reads padded only to the minor digits
	assert.equal(k.moneyProblem('1.2345', 'SGD', 4), null);
	assert.equal(k.moneyProblem('1.23456', 'SGD', 4), 'at most 4 decimal places');
	assert.equal(
		k.format({ kind: 'money', currency: 'SGD', scale: 4 }, '1234.5', {
			locale: 'en',
			currency: 'SGD'
		}),
		'SGD 1,234.50'
	);
	assert.equal(
		k.format({ kind: 'money', currency: 'SGD', scale: 4 }, '1234.5678', {
			locale: 'en',
			currency: 'SGD'
		}),
		'SGD 1,234.5678'
	);
	assert.equal(k.currencyOf({ kind: 'money', currency: 'currency' }, { currency: 'MYR' }), 'MYR');
	assert.equal(k.currencyOf({ kind: 'money', currency: 'EUR' }), 'EUR');
	assert.equal(k.currencyOf({ kind: 'money' }, {}, 'SGD'), 'SGD');
});

test('typed text parses per kind with decode wording', () => {
	assert.deepEqual(k.parse({ kind: 'int' }, '42'), { value: 42 });
	assert.deepEqual(k.parse({ kind: 'int' }, '4.2'), { error: 'expected an integer' });
	assert.deepEqual(k.parse({ kind: 'decimal', scale: 2 }, '1,234.50'), {
		value: Decimal.of('1234.50')
	});
	assert.deepEqual(k.parse({ kind: 'decimal', scale: 2 }, '1.234'), {
		error: 'at most 2 decimal places'
	});
	assert.deepEqual(k.parse({ kind: 'duration' }, '1h 30m'), { value: 5400 });
	assert.deepEqual(k.parse({ kind: 'duration' }, '90'), { value: 5400 });
	assert.deepEqual(k.parse({ kind: 'duration' }, 'soon'), {
		error: 'expected a duration like 1h 30m'
	});
	assert.deepEqual(k.parse({ kind: 'text' }, '  '), { value: null });
	assert.equal(k.formatDuration(5400), '1h 30m');
});

test('points need no provider: typed coordinates parse and range-check', () => {
	assert.deepEqual(k.parsePoint('1.3521, 103.8198'), { lat: 1.3521, lng: 103.8198 });
	assert.deepEqual(k.parsePoint('1.3521 103.8198'), { lat: 1.3521, lng: 103.8198 });
	assert.equal(k.parsePoint('91, 0'), null);
	assert.equal(k.parsePoint('Singapore'), null);
	assert.equal(k.problem({ kind: 'point' }, { lat: 1, lng: 2 }), null);
	assert.equal(k.problem({ kind: 'point' }, { lat: 100, lng: 2 }), 'expected latitude, longitude');
});

test('periods refuse empty and inverted ranges; open ends are allowed', () => {
	const d = { kind: 'period', of: 'date' } as const,
		i = { kind: 'period', of: 'instant' } as const;
	assert.equal(k.problem(d, { from: '2026-01-02', to: '2026-01-01' }), 'ends before it starts');
	assert.equal(k.problem(d, { from: '2026-01-01', to: '2026-01-01' }), null); // inclusive: one day
	assert.equal(
		k.problem(i, { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' }),
		'ends before it starts'
	); // [) empty
	assert.equal(k.problem(d, { from: '2026-01-01', to: null }), null);
	assert.equal(k.problem(d, { from: null, to: '2026-01-01' }), 'needs a start');
});

test('files are checked against accept and max before upload', () => {
	const f = { kind: 'file', accept: ['image/*', 'application/pdf'], max: '2MiB' } as const;
	assert.equal(k.fileProblem(f, { name: 'a.png', type: 'image/png', size: 10 }), null);
	assert.equal(
		k.fileProblem(f, { name: 'a.txt', type: 'text/plain', size: 10 }),
		'a.txt: expected image/*, application/pdf'
	);
	assert.equal(
		k.fileProblem(f, { name: 'b.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 }),
		'b.pdf: over 2MiB'
	);
});

test('structured problems carry decode paths; unions check the chosen arm', () => {
	const kind = {
		kind: 'object',
		fields: {
			lines: {
				kind: 'list',
				of: {
					kind: 'object',
					fields: { amount: { kind: 'decimal', scale: 2 }, note: { kind: 'text', optional: true } }
				}
			},
			basis: {
				kind: 'union',
				by: 'type',
				arms: { fixed: { amount: { kind: 'number' } }, rate: { pct: { kind: 'number', max: 100 } } }
			}
		}
	} as const;
	const out = k.problems(kind, {
		lines: [{ amount: Decimal.of('1.00') }, { amount: null }],
		basis: { type: 'rate', pct: 150 }
	});
	assert.deepEqual(
		[...out],
		[
			['lines.1.amount', 'is required'],
			['basis.pct', 'is out of range']
		]
	);
	assert.deepEqual(k.armValue(kind.fields.basis, 'fixed'), { type: 'fixed', amount: null });
});

test('initial values: literal defaults, state initial, empty structures; clock defaults stay to the host', () => {
	assert.equal(k.initial({ kind: 'int', default: 3 }), 3);
	assert.equal(k.initial({ kind: 'date', default: { today: '+0d' } }), null);
	assert.equal(k.initial({ kind: 'state', initial: 'draft', states: { draft: {} } }), 'draft');
	assert.deepEqual(
		k.initial({
			kind: 'object',
			fields: { a: { kind: 'bool' }, b: { kind: 'list', of: { kind: 'text' } } }
		}),
		{ a: false, b: [] }
	);
	assert.deepEqual(k.initial({ kind: 'text', many: true }), []);
});

test('state helpers: edges, edit locks and a stable tone', () => {
	const s = {
		kind: 'state',
		initial: 'draft',
		states: {
			draft: { to: ['submitted'] },
			submitted: { edit: ['note'] },
			ordered: { edit: 'none' }
		}
	} as const;
	assert.deepEqual(k.edgesFrom(s, 'draft'), ['submitted']);
	assert.equal(k.editable(s, 'draft', 'total'), true);
	assert.equal(k.editable(s, 'submitted', 'note'), true);
	assert.equal(k.editable(s, 'submitted', 'total'), false);
	assert.equal(k.editable(s, 'ordered', 'note'), false);
	assert.equal(k.tone('rejected'), 'danger');
	assert.equal(k.tone('approved'), 'success');
});

test('display text: dates never shift, masked values stay masked', () => {
	assert.equal(k.format({ kind: 'date' }, '2026-01-01', { locale: 'en-US' }), 'Jan 1, 2026');
	assert.equal(k.format({ kind: 'text' }, { $masked: true }), '•••');
	assert.equal(k.format({ kind: 'decimal', scale: 2 }, '1234.50', { locale: 'en' }), '1,234.5'); // only money pads
	assert.equal(k.format({ kind: 'enum', values: ['a', 'b'], many: true }, ['a', 'b']), 'A, B');
});

test('a picker searches on the server, patterned seq labels included, and sorts by its label unless told otherwise', () => {
	const target = {
		label: ['code', 'name'],
		fields: {
			code: { kind: 'seq', pattern: 'P-{0000}' },
			name: { kind: 'text' },
			n: { kind: 'seq' }
		}
	} as const;
	assert.deepEqual(k.pickerRead(target, ['code', 'name'], { limit: 20 }, ''), {
		fields: ['code', 'name'],
		limit: 20,
		orderBy: { code: 'asc' }
	});
	assert.deepEqual(
		k.pickerRead(
			target,
			['code', 'name'],
			{ where: { active: { eq: true } }, orderBy: { name: 'desc' }, limit: 20 },
			' P-00_1 '
		).where,
		{
			and: [
				{ active: { eq: true } },
				{ or: [{ code: { like: '%P-00\\_1%' } }, { name: { like: '%P-00\\_1%' } }] }
			]
		}
	);
	assert.equal(k.pickerRead(target, ['n'], { limit: 20 }, 'x').where, undefined); // an unpatterned seq is a number
	// a declared search ranks the typed text; with nothing typed the label sorts
	const indexed = { ...target, search: ['name'] };
	assert.deepEqual(k.pickerRead(indexed, ['name'], { limit: 20 }, 'acme'), {
		fields: ['name'],
		limit: 20,
		search: 'acme'
	});
	assert.deepEqual(k.pickerRead(indexed, ['name'], { limit: 20 }, '').orderBy, { name: 'asc' });
});

test('precision: a year, month or week snaps to its first day (weeks from Monday); a period end to its last', async () => {
	const p = await import('../src/kinds/precision.ts');
	assert.equal(p.unitStart('2026-09-26', 'year'), '2026-01-01');
	assert.equal(p.unitStart('2026-09-26', 'month'), '2026-09-01');
	assert.equal(p.unitStart('2026-09-26', 'week'), '2026-09-21'); // a Saturday → its Monday
	assert.equal(p.unitStart('2026-09-21', 'week'), '2026-09-21');
	assert.equal(p.unitStart('2026-09-27', 'week'), '2026-09-21'); // Sunday closes the week
	assert.equal(p.unitEnd('2026-02-10', 'month'), '2026-02-28');
	assert.equal(p.unitEnd('2028-02-10', 'month'), '2028-02-29');
	assert.equal(p.unitEnd('2026-09-23', 'week'), '2026-09-27');
	assert.equal(p.unitEnd('2026-05-05', 'year'), '2026-12-31');
	assert.equal(p.unitNext('2026-12-15', 'month'), '2027-01-01');
	assert.equal(p.unitNext('2026-12-31', 'week'), '2027-01-04');
	assert.deepEqual(
		p.unitPage('2026-09-26', 'year').map((d) => d.slice(0, 4)),
		['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027']
	);
	assert.equal(p.unitPage('2026-09-26', 'month')[11], '2026-12-01');
	// September 2026: the weeks from Mon 31 Aug to Mon 28 Sep, each by its Monday
	assert.deepEqual(p.unitPage('2026-09-26', 'week'), [
		'2026-08-31',
		'2026-09-07',
		'2026-09-14',
		'2026-09-21',
		'2026-09-28'
	]);
	assert.equal(p.pageStep('2026-01-31', 'week', 1), '2026-02-01');
	assert.equal(p.pageStep('2026-09-26', 'year', -1).slice(0, 4), '2014');
	assert.equal(p.snapTime('09:41', 'hour'), '09:00');
	assert.equal(p.snapTime('09:41:07', undefined), '09:41');
	// a month-precision date shows as its month, never as its first day
	assert.equal(
		k.format({ kind: 'date', precision: 'month' }, '2026-09-01', { locale: 'en' }),
		'September 2026'
	);
	assert.equal(
		k.format({ kind: 'date', precision: 'year' }, '2026-01-01', { locale: 'en' }),
		'2026'
	);
});

test('instant and time display honor precision and the workspace zone', () => {
	const value = '2026-09-30T16:30:00Z';
	const options = { locale: 'en-US', zone: 'Asia/Singapore' };
	assert.equal(k.format({ kind: 'instant', precision: 'month' }, value, options), 'October 2026');
	assert.equal(k.format({ kind: 'instant', precision: 'year' }, value, options), '2026');
	assert.equal(k.format({ kind: 'instant', precision: 'day' }, value, options), 'Oct 1, 2026');
	assert.equal(
		k.format({ kind: 'instant', precision: 'hour' }, value, options),
		'Oct 1, 2026, 12 AM'
	);
	assert.equal(k.format({ kind: 'time', precision: 'hour' }, '09:41'), '09');
	assert.equal(k.format({ kind: 'time', precision: 'minute' }, '09:41'), '09:41');
	assert.equal(
		k.format(
			{ kind: 'period', of: 'instant', precision: 'month' },
			{
				start: value,
				end: '2026-10-30T16:30:00Z'
			},
			options
		),
		'October 2026'
	);
});

test('coarse instant ranges label the last covered month in the workspace zone', () => {
	const options = { locale: 'en', zone: 'Asia/Singapore' };
	assert.equal(
		k.format(
			{ kind: 'period', of: 'instant', precision: 'month' },
			{
				start: '2026-09-30T16:00:00Z',
				end: '2026-10-31T16:00:00Z'
			},
			options
		),
		'October 2026'
	);
	assert.equal(
		k.format(
			{ kind: 'period', of: 'instant', precision: 'month' },
			{
				start: '2026-08-31T16:00:00Z',
				end: '2026-10-31T16:00:00Z'
			},
			options
		),
		'September 2026 – October 2026'
	);
	assert.equal(
		k.format(
			{ kind: 'period', of: 'date', precision: 'month' },
			{
				from: '2026-10-01',
				to: '2026-11-01'
			},
			options
		),
		'October 2026 – November 2026'
	);
});
