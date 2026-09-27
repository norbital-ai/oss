import assert from 'node:assert/strict';
import test from 'node:test';
import './resolve.ts';

const k = await import('../src/kinds/kind.ts');

test('tagged wire values untag to exact text, never floats', () => {
	assert.equal(k.untag({ $dec: '12345678901234567.89' }), '12345678901234567.89');
	assert.equal(k.untag({ $d: '2026-09-25' }), '2026-09-25');
	assert.deepEqual(k.untag({ from: { $d: '2026-01-01' }, to: null }), { from: '2026-01-01', to: null });
	assert.deepEqual(k.untag([{ $dec: '1' }]), ['1']);
});

test('money formats exactly in its currency minor digits', () => {
	assert.equal(k.minorDigits('JPY'), 0);
	assert.equal(k.minorDigits('BHD'), 3);
	assert.equal(k.format({ kind: 'money', currency: 'SGD' }, { $dec: '1234567.5' }, { locale: 'en', currency: 'SGD' }), 'SGD1,234,567.50');
	assert.equal(k.moneyProblem('10.005', 'SGD'), 'SGD has 2 decimal places');
	assert.equal(k.moneyProblem('10.50', 'SGD'), null);
	assert.equal(k.currencyOf({ kind: 'money', currency: 'currency' }, { currency: 'MYR' }), 'MYR');
	assert.equal(k.currencyOf({ kind: 'money', currency: 'EUR' }), 'EUR');
	assert.equal(k.currencyOf({ kind: 'money' }, {}, 'SGD'), 'SGD');
});

test('typed text parses per kind with decode wording', () => {
	assert.deepEqual(k.parse({ kind: 'int' }, '42'), { value: 42 });
	assert.deepEqual(k.parse({ kind: 'int' }, '4.2'), { error: 'expected an integer' });
	assert.deepEqual(k.parse({ kind: 'decimal', scale: 2 }, '1,234.50'), { value: '1234.50' });
	assert.deepEqual(k.parse({ kind: 'decimal', scale: 2 }, '1.234'), { error: 'at most 2 decimal places' });
	assert.deepEqual(k.parse({ kind: 'duration' }, '1h 30m'), { value: 5400 });
	assert.deepEqual(k.parse({ kind: 'duration' }, '90'), { value: 5400 });
	assert.deepEqual(k.parse({ kind: 'duration' }, 'soon'), { error: 'expected a duration like 1h 30m' });
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
	const d = { kind: 'period', of: 'date' } as const, i = { kind: 'period', of: 'instant' } as const;
	assert.equal(k.problem(d, { from: '2026-01-02', to: '2026-01-01' }), 'ends before it starts');
	assert.equal(k.problem(d, { from: '2026-01-01', to: '2026-01-01' }), null); // inclusive: one day
	assert.equal(k.problem(i, { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' }), 'ends before it starts'); // [) empty
	assert.equal(k.problem(d, { from: '2026-01-01', to: null }), null);
	assert.equal(k.problem(d, { from: null, to: '2026-01-01' }), 'needs a start');
});

test('files are checked against accept and max before upload', () => {
	const f = { kind: 'file', accept: ['image/*', 'application/pdf'], max: '2MiB' } as const;
	assert.equal(k.fileProblem(f, { name: 'a.png', type: 'image/png', size: 10 }), null);
	assert.equal(k.fileProblem(f, { name: 'a.txt', type: 'text/plain', size: 10 }), 'a.txt: expected image/*, application/pdf');
	assert.equal(k.fileProblem(f, { name: 'b.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 }), 'b.pdf: over 2MiB');
});

test('structured problems carry decode paths; unions check the chosen arm', () => {
	const kind = { kind: 'object', fields: {
		lines: { kind: 'list', of: { kind: 'object', fields: { amount: { kind: 'decimal', scale: 2 }, note: { kind: 'text', optional: true } } } },
		basis: { kind: 'union', by: 'type', arms: { fixed: { amount: { kind: 'number' } }, rate: { pct: { kind: 'number', max: 100 } } } }
	} } as const;
	const out = k.problems(kind, { lines: [{ amount: '1.00' }, { amount: null }], basis: { type: 'rate', pct: 150 } });
	assert.deepEqual([...out], [['lines.1.amount', 'is required'], ['basis.pct', 'is out of range']]);
	assert.deepEqual(k.armValue(kind.fields.basis, 'fixed'), { type: 'fixed', amount: null });
});

test('initial values: literal defaults, state initial, empty structures; clock defaults stay to the host', () => {
	assert.equal(k.initial({ kind: 'int', default: 3 }), 3);
	assert.equal(k.initial({ kind: 'date', default: { today: '+0d' } }), null);
	assert.equal(k.initial({ kind: 'state', initial: 'draft', states: { draft: {} } }), 'draft');
	assert.deepEqual(k.initial({ kind: 'object', fields: { a: { kind: 'bool' }, b: { kind: 'list', of: { kind: 'text' } } } }), { a: false, b: [] });
	assert.deepEqual(k.initial({ kind: 'text', many: true }), []);
});

test('state helpers: edges, edit locks and a stable tone', () => {
	const s = { kind: 'state', initial: 'draft', states: { draft: { to: ['submitted'] }, submitted: { edit: ['note'] }, ordered: { edit: 'none' } } } as const;
	assert.deepEqual(k.edgesFrom(s, 'draft'), ['submitted']);
	assert.equal(k.editable(s, 'draft', 'total'), true);
	assert.equal(k.editable(s, 'submitted', 'note'), true);
	assert.equal(k.editable(s, 'submitted', 'total'), false);
	assert.equal(k.editable(s, 'ordered', 'note'), false);
	assert.equal(k.tone('rejected'), 'danger');
	assert.equal(k.tone('approved'), 'success');
});

test('display text: dates never shift, masked values stay masked', () => {
	assert.equal(k.format({ kind: 'date' }, { $d: '2026-01-01' }, { locale: 'en-US' }), 'Jan 1, 2026');
	assert.equal(k.format({ kind: 'text' }, { $masked: true }), '•••');
	assert.equal(k.format({ kind: 'decimal', scale: 2 }, '1234.5', { locale: 'en' }), '1,234.50');
	assert.equal(k.format({ kind: 'enum', values: ['a', 'b'], many: true }, ['a', 'b']), 'a, b');
});

test('a picker searches on the server, patterned seq labels included, and sorts by its label unless told otherwise', () => {
	const target = { label: ['code', 'name'], fields: { code: { kind: 'seq', pattern: 'P-{0000}' }, name: { kind: 'text' }, n: { kind: 'seq' } } } as const;
	assert.deepEqual(k.pickerRead(target, ['code', 'name'], { limit: 20 }, ''), { select: { id: true, code: true, name: true }, limit: 20, orderBy: { code: 'asc' } });
	assert.deepEqual(k.pickerRead(target, ['code', 'name'], { where: { active: { eq: true } }, orderBy: { name: 'desc' }, limit: 20 }, ' P-00_1 ').where,
		{ and: [{ active: { eq: true } }, { or: [{ code: { like: '%P-00\\_1%' } }, { name: { like: '%P-00\\_1%' } }] }] });
	assert.equal(k.pickerRead(target, ['n'], { limit: 20 }, 'x').where, undefined); // an unpatterned seq is a number
	// a declared search ranks the typed text; with nothing typed the label sorts
	const indexed = { ...target, search: ['name'] };
	assert.deepEqual(k.pickerRead(indexed, ['name'], { limit: 20 }, 'acme'), { select: { id: true, name: true }, limit: 20, search: 'acme' });
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
	assert.deepEqual(p.unitPage('2026-09-26', 'year').map((d) => d.slice(0, 4)), ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027']);
	assert.equal(p.unitPage('2026-09-26', 'month')[11], '2026-12-01');
	// September 2026: the weeks from Mon 31 Aug to Mon 28 Sep, each by its Monday
	assert.deepEqual(p.unitPage('2026-09-26', 'week'), ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
	assert.equal(p.pageStep('2026-01-31', 'week', 1), '2026-02-01');
	assert.equal(p.pageStep('2026-09-26', 'year', -1).slice(0, 4), '2014');
	assert.equal(p.snapTime('09:41', 'hour'), '09:00');
	assert.equal(p.snapTime('09:41:07', undefined), '09:41');
	// a month-precision date shows as its month, never as its first day
	assert.equal(k.format({ kind: 'date', precision: 'month' }, '2026-09-01', { locale: 'en' }), 'September 2026');
	assert.equal(k.format({ kind: 'date', precision: 'year' }, '2026-01-01', { locale: 'en' }), '2026');
});
