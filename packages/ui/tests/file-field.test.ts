import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { browser } from './view-fixture.ts';
import { Effect, Schema } from 'effect';
// The built-in `file` field: one input-height trigger when empty, chips when filled, a "+" while there is room, and a
// popover per chip with a preview, the stored file's metadata, Download, and Remove only when edited.
import './dom.ts';
import assert from 'node:assert/strict';
import type { FileRef, Value, Kind } from '@norbital-ai/std/kind';
import type { KindsHost, KindView } from '../src/kinds/context.ts';
import type { Row } from '../src/model/types.ts';
import { jsonRecord } from './view-fixture.ts';
import { it, afterEach } from '@effect/vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./file-harness.svelte');

const PDF = {
	kind: 'file',
	accept: ['application/pdf'],
	max: '20MiB',
	multiple: true
} satisfies Kind;
const PHOTO = { kind: 'file', accept: ['image/*'], max: '5MiB' } satisfies Kind;
// A complete blank PDF lets the fixture host serve previews without an HTTP server.
const PDF_URL = `data:application/pdf,${encodeURIComponent(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>
endobj
xref
0 4
0000000000 65535 f\r
0000000009 00000 n\r
0000000058 00000 n\r
0000000115 00000 n\r
trailer
<< /Size 4 /Root 1 0 R >>
startxref
186
%%EOF
`)}`;
const ref = (i: number, mime = 'application/pdf'): FileRef => ({
	id: `f${i}`,
	name: `doc-${i}.pdf`,
	mime,
	size: 1234 * (i + 1)
});
const SYS_FILE = {
	size: 5000,
	sha256: 'ab12cd34'.repeat(8),
	created_at: '2026-09-30T02:00:00Z',
	created_by: 'u1'
};
const reads: [string, Value][] = [];
const host = (over: Partial<KindsHost> = {}): KindsHost => ({
	upload: (file) =>
		Effect.succeed({ id: `up-${file.name}`, name: file.name, mime: file.type, size: file.size }),
	fileUrl: (r) => (r.mime === 'application/pdf' ? PDF_URL : `/files/${r.id}`),
	query: (request) =>
		Effect.sync(() =>
			Object.fromEntries(
				Object.entries(request).map(([c, o]) => {
					reads.push([c, o]);
					const id = jsonRecord(jsonRecord(jsonRecord(o).where).id).eq;
					assert.equal(typeof id, 'string');
					const row: Row =
						c === 'sys_file'
							? { id: Schema.decodeUnknownSync(Schema.String)(id), ...SYS_FILE }
							: { id: 'u1', name: 'Ana Tan' };
					return [c, { rows: [row], next: null }];
				})
			)
		),
	...over
});
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	document.body.innerHTML = '';
	reads.length = 0;
});
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
};
async function field({
	kind = PDF,
	value = null,
	mode = 'edit',
	h = host()
}: { kind?: Kind; value?: Value; mode?: 'edit' | 'show'; h?: KindsHost } = {}) {
	const changes: Value[] = [];
	const view: KindView =
		mode === 'edit'
			? {
					mode,
					kind,
					value,
					name: 'documents',
					id: 'documents',
					disabled: false,
					onChange: (v) => changes.push(v)
				}
			: { mode, kind, value, name: 'documents' };
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { host: h, view } });
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return { target, changes };
}
const chips = (t: ParentNode) => [
	...t.querySelectorAll<HTMLButtonElement>('button[data-file-chip]')
];
const adder = (t: ParentNode) => t.querySelector<HTMLElement>('[data-file-add]');
const drop = async (t: ParentNode, files: readonly File[]) => {
	const e = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(e, 'dataTransfer', { value: { files } });
	element<HTMLElement>(t, '[data-file-field]').dispatchEvent(e);
	await settle();
};

it.live(
	'empty, the field is one input-height trigger that names the action; the limits are its hint, not a drop zone',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => field());
			const add = required(adder(target));
			assert.ok(add);
			assert.match(textOf(add), /^\s*Add files\s*Up to 20 files/);
			assert.match(required(add.getAttribute('title')), /Up to 20 files · 20MB each · PDF/);
			assert.equal(element<HTMLInputElement>(target, 'input[type=file]').id, 'documents');
			assert.equal(element<HTMLInputElement>(target, 'input[type=file]').multiple, true);
			assert.doesNotMatch(textOf(target), /Drop files|click to browse/);
			assert.equal(chips(target).length, 0);
			const single = yield* browser(() => field({ kind: PHOTO }));
			assert.match(textOf(adder(single.target)), /^\s*Add file\s*5MB/);
			assert.match(required(required(adder(single.target)).getAttribute('title')), /^5MB · IMAGE$/);
		})
);

it.live(
	'multiple files read as chips with a "+" to add more; drag over the field highlights it',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => field({ value: [ref(0), ref(1), ref(2)] }));
			assert.deepEqual(
				chips(target).map((c) => textOf(c).trim()),
				['doc-0.pdf', 'doc-1.pdf', 'doc-2.pdf']
			);
			const add = required(adder(target));
			assert.equal(
				textOf(element<HTMLElement>(add, '.sr-only')),
				'Add files',
				'the "+" is named for a screen reader'
			);
			const zone = element<HTMLElement>(target, '[data-file-field]');
			zone.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
			flushSync();
			assert.equal(zone.dataset.over, 'true');
			zone.dispatchEvent(new Event('dragleave', { bubbles: true }));
			flushSync();
			assert.equal(zone.dataset.over, undefined);
		})
);

it.live(
	'the max count holds: a full field offers no "+", and a drop takes only what fits; refused types say why',
	() =>
		Effect.gen(function* () {
			const full = yield* browser(() =>
				field({ value: Array.from({ length: 20 }, (_, i) => ref(i)) })
			);
			assert.equal(chips(full.target).length, 20);
			assert.equal(adder(full.target), null);
			const one = yield* browser(() => field({ kind: PHOTO, value: ref(0, 'image/png') }));
			assert.equal(adder(one.target), null);

			const room = yield* browser(() =>
				field({ value: Array.from({ length: 19 }, (_, i) => ref(i)) })
			);
			yield* browser(() =>
				drop(room.target, [
					new File(['a'], 'a.pdf', { type: 'application/pdf' }),
					new File(['b'], 'b.pdf', { type: 'application/pdf' })
				])
			);
			assert.equal(room.changes.length, 1);
			const uploadedFiles = required(room.changes[0]);
			assert.ok(Array.isArray(uploadedFiles));
			assert.equal(uploadedFiles.length, 20);
			assert.equal(jsonRecord(required(uploadedFiles.at(-1))).name, 'a.pdf');

			const wrong = yield* browser(() => field());
			yield* browser(() =>
				drop(wrong.target, [new File(['x'], 'notes.txt', { type: 'text/plain' })])
			);
			assert.equal(wrong.changes.length, 0);
			assert.match(textOf(wrong.target), /notes\.txt: expected application\/pdf/);
		})
);

it.live(
	'a chip opens a popover: preview, size, type, uploaded at and by, SHA-256, Download and Remove when edited',
	() =>
		Effect.gen(function* () {
			const img = { id: 'p1', name: 'plaque.png', mime: 'image/png', size: 2048 };
			const { target, changes } = yield* browser(() => field({ value: [ref(0), img] }));
			required(chips(target)[1]).click();
			yield* browser(() => settle());
			const pop = element<HTMLElement>(document, '[data-file-preview]');
			assert.ok(pop, 'the popover opened');
			assert.equal(element<HTMLImageElement>(pop, 'img').getAttribute('src'), '/files/p1');
			const text = textOf(pop);
			for (const s of ['plaque.png', '2.0 KB', 'image/png', 'Ana Tan', SYS_FILE.sha256])
				assert.ok(text.includes(s), `shows ${s}`);
			assert.deepEqual(
				reads.map(([c, o]) => [c, jsonRecord(jsonRecord(jsonRecord(o).where).id).eq]),
				[
					['sys_file', 'p1'],
					['sys_user', 'u1']
				]
			);
			const download = element<HTMLAnchorElement>(pop, 'a[download]');
			assert.equal(download.getAttribute('href'), '/files/p1');
			assert.equal(download.getAttribute('download'), 'plaque.png');
			const remove = [...pop.querySelectorAll<HTMLButtonElement>('button')].find(
				(b) => textOf(b).trim() === 'Remove'
			);
			assert.ok(remove);
			remove.click();
			yield* browser(() => settle());
			assert.deepEqual(changes, [[ref(0)]]);
		})
);

it.live(
	'a PDF previews in an embedded viewer; a file without a URL or metadata still shows its name and size',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => field({ value: [ref(0)] }));
			required(chips(target)[0]).click();
			flushSync();
			const preview = element<HTMLIFrameElement>(document, '[data-file-preview] iframe');
			yield* browser(
				() =>
					new Promise<void>((resolve, reject) => {
						preview.addEventListener('load', () => resolve(), { once: true });
						preview.addEventListener(
							'error',
							() => reject(new Error('Fixture PDF failed to load')),
							{
								once: true
							}
						);
					})
			);
			yield* browser(() => settle());
			assert.equal(preview.getAttribute('src'), `${PDF_URL}#page=1&view=FitH`);
			{
				const close = mounted.pop();
				assert.ok(close);
				yield* browser(close);
			}
			document.body.innerHTML = '';
			const { fileUrl: _fileUrl, query: _query, ...withoutMetadata } = host();
			const bare = yield* browser(() => field({ value: [ref(0)], h: withoutMetadata }));
			required(chips(bare.target)[0]).click();
			yield* browser(() => settle());
			const pop = element<HTMLElement>(document, '[data-file-preview]');
			assert.match(textOf(pop), /doc-0\.pdf/);
			assert.match(textOf(pop), /1\.2 KB/);
			assert.equal(pop.querySelector('a[download]'), null);
			{
				const close = mounted.pop();
				assert.ok(close);
				yield* browser(close);
			}
			document.body.innerHTML = '';
			const sized = yield* browser(() =>
				field({ value: [{ id: 'z', name: 'z.pdf', mime: 'application/pdf' }] })
			);
			required(chips(sized.target)[0]).click();
			yield* browser(() => settle());
			assert.match(
				textOf(element<HTMLElement>(document, '[data-file-preview]')),
				/4\.9 KB/,
				"a ref without a size takes the stored row's"
			);
			assert.doesNotMatch(textOf(pop), /SHA-256/);
		})
);

it.live('read-only shows the same chips and popover, without Remove or "+"', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() => field({ mode: 'show', value: [ref(0), ref(1)] }));
		assert.equal(chips(target).length, 2);
		assert.equal(adder(target), null);
		required(chips(target)[0]).click();
		yield* browser(() => settle());
		const pop = element<HTMLElement>(document, '[data-file-preview]');
		assert.ok(pop);
		assert.ok(element<HTMLAnchorElement>(pop, 'a[download]'));
		assert.equal(
			[...pop.querySelectorAll<HTMLButtonElement>('button')].some(
				(b) => textOf(b).trim() === 'Remove'
			),
			false
		);
		assert.equal(required(chips(target)[0]).getAttribute('aria-expanded'), 'true');
		required(document.activeElement).dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
		);
		yield* browser(() => settle());
		assert.equal(document.querySelector('[data-file-preview]'), null, 'Esc closes the popover');
		const empty = yield* browser(() => field({ mode: 'show', value: null }));
		assert.equal(textOf(empty.target).trim(), '—');
	})
);

it.live('a dense cell shows the first chip and how many more', () =>
	Effect.gen(function* () {
		const target = document.createElement('div');
		document.body.append(target);
		const app = mount(Harness, {
			target,
			props: {
				host: host(),
				view: {
					mode: 'show',
					dense: true,
					kind: PDF,
					value: [ref(0), ref(1), ref(2)],
					name: 'documents'
				}
			}
		});
		yield* browser(() => settle());
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		assert.deepEqual(
			chips(target).map((c) => textOf(c).trim()),
			['doc-0.pdf']
		);
		assert.match(textOf(target), /\+2/);
	})
);
