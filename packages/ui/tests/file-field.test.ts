// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The built-in `file` field: one input-height trigger when empty, chips when filled, a "+" while there is room, and a
// popover per chip with a preview, the stored file's metadata, Download, and Remove only when edited.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./file-harness.svelte');

const PDF = { kind: 'file', accept: ['application/pdf'], max: '20MiB', multiple: true };
const PHOTO = { kind: 'file', accept: ['image/*'], max: '5MiB' };
const ref = (i, mime = 'application/pdf') => ({ id: `f${i}`, name: `doc-${i}.pdf`, mime, size: 1234 * (i + 1) });
const SYS_FILE = { size: 5000, sha256: 'ab12cd34'.repeat(8), created_at: '2026-09-30T02:00:00Z', created_by: 'u1' };
const reads = [];
const host = (over = {}) => ({
	upload: async (file) => ({ id: `up-${file.name}`, name: file.name, mime: file.type, size: file.size }),
	fileUrl: (r) => `/files/${r.id}`,
	read: async (c, o) => { reads.push([c, o]); return { rows: [c === 'sys_file' ? { id: o.where.id.eq, ...SYS_FILE } : { id: 'u1', name: 'Ana Tan' }], next: null }; },
	...over,
});
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); document.body.innerHTML = ''; reads.length = 0; });
const settle = async () => { flushSync(); for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); } };
async function field({ kind = PDF, value = null, mode = 'edit', h = host() } = {}) {
	const changes = [];
	const view = mode === 'edit'
		? { mode, kind, value, name: 'documents', id: 'documents', disabled: false, onChange: (v) => changes.push(v) }
		: { mode, kind, value, name: 'documents' };
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { host: h, view } });
	await settle();
	mounted.push(() => { unmount(app); target.remove(); });
	return { target, changes };
}
const chips = (t) => [...t.querySelectorAll('button[data-file-chip]')];
const adder = (t) => t.querySelector('[data-file-add]');
const drop = async (t, files) => {
	const e = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(e, 'dataTransfer', { value: { files } });
	t.querySelector('[data-file-field]').dispatchEvent(e);
	await settle();
};

test('empty, the field is one input-height trigger that names the action; the limits are its hint, not a drop zone', async () => {
	const { target } = await field();
	const add = adder(target);
	assert.ok(add);
	assert.match(add.textContent, /^\s*Add files\s*Up to 20 files/);
	assert.match(add.getAttribute('title'), /Up to 20 files · 20MB each · PDF/);
	assert.equal(target.querySelector('input[type=file]').id, 'documents');
	assert.equal(target.querySelector('input[type=file]').multiple, true);
	assert.doesNotMatch(target.textContent, /Drop files|click to browse/);
	assert.equal(chips(target).length, 0);
	const single = await field({ kind: PHOTO });
	assert.match(adder(single.target).textContent, /^\s*Add file\s*5MB/);
	assert.match(adder(single.target).getAttribute('title'), /^5MB · IMAGE$/);
});

test('multiple files read as chips with a "+" to add more; drag over the field highlights it', async () => {
	const { target } = await field({ value: [ref(0), ref(1), ref(2)] });
	assert.deepEqual(chips(target).map((c) => c.textContent.trim()), ['doc-0.pdf', 'doc-1.pdf', 'doc-2.pdf']);
	const add = adder(target);
	assert.equal(add.querySelector('.sr-only').textContent, 'Add files', 'the "+" is named for a screen reader');
	const zone = target.querySelector('[data-file-field]');
	zone.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
	flushSync();
	assert.equal(zone.dataset.over, 'true');
	zone.dispatchEvent(new Event('dragleave', { bubbles: true }));
	flushSync();
	assert.equal(zone.dataset.over, undefined);
});

test('the max count holds: a full field offers no "+", and a drop takes only what fits; refused types say why', async () => {
	const full = await field({ value: Array.from({ length: 20 }, (_, i) => ref(i)) });
	assert.equal(chips(full.target).length, 20);
	assert.equal(adder(full.target), null);
	const one = await field({ kind: PHOTO, value: ref(0, 'image/png') });
	assert.equal(adder(one.target), null);

	const room = await field({ value: Array.from({ length: 19 }, (_, i) => ref(i)) });
	await drop(room.target, [new File(['a'], 'a.pdf', { type: 'application/pdf' }), new File(['b'], 'b.pdf', { type: 'application/pdf' })]);
	assert.equal(room.changes.length, 1);
	assert.equal(room.changes[0].length, 20);
	assert.equal(room.changes[0].at(-1).name, 'a.pdf');

	const wrong = await field();
	await drop(wrong.target, [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
	assert.equal(wrong.changes.length, 0);
	assert.match(wrong.target.textContent, /notes\.txt: expected application\/pdf/);
});

test('a chip opens a popover: preview, size, type, uploaded at and by, SHA-256, Download and Remove when edited', async () => {
	const img = { id: 'p1', name: 'plaque.png', mime: 'image/png', size: 2048 };
	const { target, changes } = await field({ value: [ref(0), img] });
	chips(target)[1].click();
	await settle();
	const pop = document.querySelector('[data-file-preview]');
	assert.ok(pop, 'the popover opened');
	assert.equal(pop.querySelector('img').getAttribute('src'), '/files/p1');
	const text = pop.textContent;
	for (const s of ['plaque.png', '2.0 KB', 'image/png', 'Ana Tan', SYS_FILE.sha256]) assert.ok(text.includes(s), `shows ${s}`);
	assert.deepEqual(reads.map(([c, o]) => [c, o.where.id.eq]), [['sys_file', 'p1'], ['sys_user', 'u1']]);
	const download = pop.querySelector('a[download]');
	assert.equal(download.getAttribute('href'), '/files/p1');
	assert.equal(download.getAttribute('download'), 'plaque.png');
	const remove = [...pop.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove');
	assert.ok(remove);
	remove.click();
	await settle();
	assert.deepEqual(changes, [[ref(0)]]);
});

test('a PDF previews in an embedded viewer; a file without a URL or metadata still shows its name and size', async () => {
	const { target } = await field({ value: [ref(0)] });
	chips(target)[0].click();
	await settle();
	assert.equal(document.querySelector('[data-file-preview] iframe').getAttribute('src'), '/files/f0#page=1&view=FitH');
	mounted.pop()(); document.body.innerHTML = "";
	const bare = await field({ value: [ref(0)], h: host({ fileUrl: undefined, read: undefined }) });
	chips(bare.target)[0].click();
	await settle();
	const pop = document.querySelector('[data-file-preview]');
	assert.match(pop.textContent, /doc-0\.pdf/);
	assert.match(pop.textContent, /1\.2 KB/);
	assert.equal(pop.querySelector('a[download]'), null);
	mounted.pop()(); document.body.innerHTML = "";
	const sized = await field({ value: [{ id: 'z', name: 'z.pdf', mime: 'application/pdf' }] });
	chips(sized.target)[0].click();
	await settle();
	assert.match(document.querySelector('[data-file-preview]').textContent, /4\.9 KB/, 'a ref without a size takes the stored row\'s');
	assert.doesNotMatch(pop.textContent, /SHA-256/);
});

test('read-only shows the same chips and popover, without Remove or "+"', async () => {
	const { target } = await field({ mode: 'show', value: [ref(0), ref(1)] });
	assert.equal(chips(target).length, 2);
	assert.equal(adder(target), null);
	chips(target)[0].click();
	await settle();
	const pop = document.querySelector('[data-file-preview]');
	assert.ok(pop);
	assert.ok(pop.querySelector('a[download]'));
	assert.equal([...pop.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove'), false);
	assert.equal(chips(target)[0].getAttribute('aria-expanded'), 'true');
	document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await settle();
	assert.equal(document.querySelector('[data-file-preview]'), null, 'Esc closes the popover');
	const empty = await field({ mode: 'show', value: null });
	assert.equal(empty.target.textContent.trim(), '—');
});

test('a dense cell shows the first chip and how many more', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { host: host(), view: { mode: 'show', dense: true, kind: PDF, value: [ref(0), ref(1), ref(2)], name: 'documents' } } });
	await settle();
	mounted.push(() => { unmount(app); target.remove(); });
	assert.deepEqual(chips(target).map((c) => c.textContent.trim()), ['doc-0.pdf']);
	assert.match(target.textContent, /\+2/);
});
