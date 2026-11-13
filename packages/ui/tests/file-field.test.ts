import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { browser } from './view-fixture.ts';
import { Effect, Schema } from 'effect';
// The built-in file field groups stored files in one preview control. Editing also offers upload and removal.
import './dom.ts';
import assert from 'node:assert/strict';
import type { FileRef, Value, Kind } from '@norbital-ai/store/kind';
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
	many: true
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
	file_url: (r) => (r.mime === 'application/pdf' ? PDF_URL : `/files/${r.id}`),
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
	h = host(),
	pending
}: {
	kind?: Kind;
	value?: Value;
	mode?: 'edit' | 'show';
	h?: KindsHost;
	pending?: (busy: boolean) => void;
} = {}) {
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
					on_change: (v) => changes.push(v)
				}
			: { mode, kind, value, name: 'documents' };
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { host: h, view, pending } });
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return { target, changes };
}
const collection = (t: ParentNode) => element<HTMLButtonElement>(t, '[data-file-collection]');
const adder = (t: ParentNode) => t.querySelector<HTMLElement>('[data-file-add]');
const drop = async (t: ParentNode, files: readonly File[]) => {
	const e = new Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(e, 'dataTransfer', { value: { files } });
	element<HTMLElement>(t, '[data-file-field]').dispatchEvent(e);
	await settle();
};

it.live(
	'multiple files share one control with a "+" to add more, and can be removed from preview',
	() =>
		Effect.gen(function* () {
			const { target, changes } = yield* browser(() => field({ value: [ref(0), ref(1), ref(2)] }));
			assert.equal(textOf(collection(target)).trim(), '3 files');
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
			collection(target).click();
			yield* browser(() => settle());
			element<HTMLButtonElement>(document, '[data-file-option]').click();
			yield* browser(() => settle());
			const preview = element(document, '[data-file-preview]');
			const remove = [...preview.querySelectorAll<HTMLButtonElement>('button')].find(
				(button) => textOf(button).trim() === 'Remove'
			);
			required(remove).click();
			yield* browser(() => settle());
			assert.deepEqual(changes.at(-1), [ref(1), ref(2)]);
		})
);

it.live(
	'the max count holds: a full field offers no "+", and a drop takes only what fits; refused types say why',
	() =>
		Effect.gen(function* () {
			const full = yield* browser(() =>
				field({ value: Array.from({ length: 20 }, (_, i) => ref(i)) })
			);
			assert.equal(textOf(collection(full.target)).trim(), '20 files');
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

it.live('read-only keeps every file reachable from one compact preview control', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			field({ mode: 'show', value: Array.from({ length: 8 }, (_, i) => ref(i)) })
		);
		const trigger = element<HTMLButtonElement>(target, '[data-file-collection]');
		assert.equal(textOf(trigger).trim(), '8 files');
		assert.equal(adder(target), null);
		assert.equal(document.querySelector('[data-file-option]'), null);
		trigger.click();
		yield* browser(() => settle());
		const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[data-file-option]')];
		assert.equal(choices().length, 6);
		element<HTMLButtonElement>(document, 'button[aria-label="Next"]').click();
		yield* browser(() => settle());
		assert.deepEqual(
			choices().map((button) => textOf(button).trim()),
			['doc-6.pdf', 'doc-7.pdf']
		);
		const last = required(choices().at(-1));
		last.click();
		yield* browser(() => settle());
		const pop = element<HTMLElement>(document, '[data-file-preview]');
		assert.match(textOf(pop), /doc-7\.pdf/);
		assert.ok(element<HTMLAnchorElement>(pop, 'a[download]'));
		assert.equal(
			[...pop.querySelectorAll<HTMLButtonElement>('button')].some(
				(b) => textOf(b).trim() === 'Remove'
			),
			false
		);
		const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => textOf(button).trim() === 'Back'
		);
		assert.equal(document.activeElement, back);
		required(back).click();
		yield* browser(() => settle());
		assert.equal(document.activeElement, choices().at(-1));
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		required(document.activeElement).dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
		);
		yield* browser(() => settle());
		assert.equal(document.querySelector('[data-file-option]'), null, 'Esc closes the popover');
		const empty = yield* browser(() => field({ mode: 'show', value: null }));
		assert.equal(textOf(empty.target).trim(), '—');
	})
);

// Standalone request forms must not save while evidence bytes are still being uploaded.
it.live('standalone evidence reports pending until the uploaded reference is delivered', () =>
	browser(async () => {
		const states: boolean[] = [];
		let finish: ((file: FileRef) => void) | undefined;
		const waiting = new Promise<FileRef>((resolve) => (finish = resolve));
		const { target, changes } = await field({
			kind: PHOTO,
			pending: (busy) => states.push(busy),
			h: host({ upload: () => Effect.promise(() => waiting) })
		});
		await drop(target, [
			new File(['MOCKED evidence'], 'MOCKED-evidence.png', { type: 'image/png' })
		]);
		assert.equal(states.at(-1), true);
		assert.equal(changes.length, 0);
		assert.ok(finish);
		finish(ref(9, 'image/png'));
		await settle();
		assert.equal(states.at(-1), false);
		assert.deepEqual(changes.at(-1), ref(9, 'image/png'));
	})
);
