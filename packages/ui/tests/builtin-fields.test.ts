// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// Built-in custom fields (money, file, point, phone) and a workspace's custom field go through one registry and one
// renderer contract: the stored kinds render through their built-in by default, `{ kind: 'custom', of }` resolves either
// by name, and a host's entry of the same name wins.
import './dom.ts';
import './resolve.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./packaging-harness.svelte');
const { default: Renderer } = await import('./packaging-renderer.svelte');
const k = await import('../src/kinds/kind.ts');
const phone = await import('../src/kinds/phone.ts');

const JOB = { id: 'j1', revision: 1, title: 'Paint', fee: '1234.5', mobile: '+6591234567' };
const catalog = { jobs: { label: ['title'], fields: { title: { kind: 'text' }, fee: { kind: 'money', currency: 'SGD' }, mobile: { kind: 'text', format: 'phone', optional: true } },
	update: { columns: ['title', 'fee', 'mobile'] } } };
const q = (v) => Object.assign(Promise.resolve(v), { read: {} });
const bolt = {
	t: (x) => x, locale: 'en', actor: null,
	read: () => q({ rows: [JOB], next: null }), get: () => q(JOB), aggregate: () => q([{ count: 1 }]), history: () => q([]),
	live: (x) => { let v; x.then((r) => (v = r)); return { get current() { return v; }, error: undefined, subscribe(run) { x.then((r) => run(r)); return () => {}; } }; },
	act: async () => ({ kind: 'committed', output: null, records: [] }), fileUrl: () => '', approvals: {},
};
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); });
async function show(props) {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, ...props } });
	flushSync();
	for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); }
	mounted.push(() => { unmount(app); target.remove(); });
	return target;
}

test('a stored kind names its built-in; a custom reference names a built-in or a workspace field alike', () => {
	assert.equal(k.fieldName({ kind: 'money' }), 'money');
	assert.equal(k.fieldName({ kind: 'file', accept: ['*/*'], max: '1MiB' }), 'file');
	assert.equal(k.fieldName({ kind: 'point' }), 'point');
	assert.equal(k.fieldName({ kind: 'text', format: 'phone' }), 'phone');
	assert.equal(k.fieldName({ kind: 'text', format: 'phone', many: true }), undefined);
	assert.equal(k.fieldName({ kind: 'text' }), undefined);
	assert.equal(k.fieldName({ kind: 'custom', of: 'phone' }), 'phone');
	assert.equal(k.fieldName({ kind: 'custom', of: 'bank_account' }), 'bank_account');
});

test('phone numbers are stored E.164 and read grouped with their calling code', () => {
	assert.equal(phone.toE164('9123 4567', 'SG'), '+6591234567');
	assert.equal(phone.toE164('012-345 6789', 'MY'), '+60123456789');
	assert.equal(phone.toE164('+44 20 7946 0958', 'SG'), '+442079460958');
	assert.equal(phone.toE164('12', 'SG'), null);
	assert.deepEqual(phone.splitPhone('+6591234567'), { code: '65', region: 'SG', national: '91234567' });
	assert.equal(phone.splitPhone('+14165550123', 'CA')?.region, 'CA');
	assert.equal(phone.formatPhone('+6591234567'), '+65 9123 4567');
	assert.equal(phone.formatPhone('+12025550123'), '+1 202 555 0123');
	assert.equal(phone.formatPhone('9123 4567'), '9123 4567');
	assert.equal(phone.regionOf('en-SG'), 'SG');
});

test('a sender or recipient handle reads per transport: a WhatsApp number JID as its phone, the rest as given', () => {
	assert.equal(phone.formatHandle('whatsapp', '6591234567@s.whatsapp.net'), '+65 9123 4567');
	assert.equal(phone.formatHandle('whatsapp', '6591234567:14@s.whatsapp.net'), '+65 9123 4567');
	assert.equal(phone.formatHandle(null, '6591234567@s.whatsapp.net'), '+65 9123 4567');
	assert.equal(phone.formatHandle('whatsapp', '6591234567'), '+65 9123 4567');
	assert.equal(phone.formatHandle(null, 'whatsapp:+6591234567'), '+65 9123 4567');
	assert.equal(phone.formatHandle('whatsapp', '8881234567@s.whatsapp.net'), '+8881234567');
	assert.equal(phone.formatHandle('whatsapp', '120363041234567890@g.us'), '120363041234567890@g.us');
	assert.equal(phone.formatHandle('whatsapp', '123456789012345@lid'), '123456789012345@lid');
	assert.equal(phone.formatHandle('whatsapp', '6591234567@s.whatsapp.net', 'Wei Jie'), 'Wei Jie');
	assert.equal(phone.formatHandle('email', 'hello@riverstone.example.test'), 'hello@riverstone.example.test');
	assert.equal(phone.formatHandle('telegram', '123456789'), '123456789');
	assert.equal(phone.formatHandle('telegram', '123456789', 'Ana'), 'Ana');
	assert.equal(phone.formatHandle('slack', 'U0123ABCD', ' '), 'U0123ABCD');
});

test('built-ins render by default in a cell: money in tabular figures, phone as a formatted tel: link, by kind or by reference', async () => {
	const money = await show({ part: 'show', props: { kind: { kind: 'money', currency: 'SGD' }, value: '1234.5' } });
	assert.equal(money.querySelector('.tabular-nums')?.textContent, 'SGD 1,234.50');
	for (const kind of [{ kind: 'text', format: 'phone' }, { kind: 'custom', of: 'phone' }]) {
		const t = await show({ part: 'show', props: { kind, value: '+6591234567' } });
		const a = t.querySelector('a[href^="tel:"]');
		assert.equal(a?.getAttribute('href'), 'tel:+6591234567');
		assert.equal(a?.textContent, '+65 9123 4567');
	}
});

test('a workspace custom field renders through its renderer, and a host entry of a built-in name wins', async () => {
	const customFields = { sign: { shape: { kind: 'text' }, renderer: Renderer }, phone: { shape: { kind: 'text', format: 'phone' }, renderer: Renderer } };
	const own = await show({ part: 'show', customFields, props: { kind: { kind: 'custom', of: 'sign' }, value: 'A. Tan' } });
	assert.equal(own.querySelector('[data-renderer=show]')?.textContent, 'A. Tan');
	const over = await show({ part: 'show', customFields, props: { kind: { kind: 'text', format: 'phone' }, value: '+6591234567' } });
	assert.equal(over.querySelector('[data-renderer=show]')?.textContent, '+6591234567');
});

test('a form edits built-ins with their own editors: money with its currency affix, phone with a calling code', async () => {
	const t = await show({ part: 'form', props: { of: 'jobs', id: 'j1', record: JOB } });
	const fee = t.querySelector('[data-field=fee]');
	assert.ok(fee?.querySelector('input[inputmode=decimal]'));
	assert.ok(fee?.textContent.includes('SGD'));
	const mobile = t.querySelector('[data-field=mobile]');
	assert.equal(mobile?.querySelector('input[type=tel]')?.value, '9123 4567');
	assert.ok(mobile?.querySelector('[aria-label="Country code"]')?.textContent.includes('+65'));
});
