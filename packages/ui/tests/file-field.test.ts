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
