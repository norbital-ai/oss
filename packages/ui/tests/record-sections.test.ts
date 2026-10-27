import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { Effect } from 'effect';
// Record sections keep unlisted fields readable, derive summaries from the row and preserve collapsed edits.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { viewFixture, browser } from './view-fixture.ts';
import type { Json } from '@norbital-ai/std/wire';
import type { RecordShellProps } from '../src/record/RecordShell.svelte';
import type { RecordSection } from '../src/form/section.svelte';
import type { KindsHost } from '../src/kinds/context.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			crew: { kind: 'text', optional: true },
			notes: { kind: 'text', optional: true },
			site: { kind: 'text', optional: true }
		},
		update: { columns: ['title', 'crew', 'notes', 'site'] },
		create: { columns: ['title', 'crew', 'notes', 'site'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const ROW = { id: 'j1', revision: 1, title: 'Paint', crew: 'B', notes: 'Back door', site: 'North' };
const SECTIONS: readonly RecordSection[] = [
	{ name: 'core', title: 'Job', fields: ['site', 'title'] },
	{
		name: 'more',
		title: 'More',
		fields: ['notes', 'nope'],
		defaultOpen: false,
		summary: (r) => `Notes: ${r.notes ?? '—'}`
	}
];
const settle = async () => {
	for (let i = 0; i < 5; i++) {
		flushSync();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	localStorage.clear();
});
async function show(props: Omit<RecordShellProps, 'of'>) {
	const sent: [string, Json][] = [];
	const warned: string[] = [];
	const warn = console.warn;
	console.warn = (m) => warned.push(String(m));
	const { bolt } = await viewFixture({
		get: (c) => (c === 'jobs' ? ROW : null),
		act: (c, input) => {
			sent.push([c, input]);
			return { kind: 'committed', output: null, records: [] };
		}
	});
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: { bolt, catalog, part: 'record', props: { of: 'jobs', ...props } }
	});
	await settle();
	console.warn = warn;
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return { target, sent, warned };
}
const section = (t: ParentNode, name: string) =>
	element<HTMLElement>(t, `[data-section="${name}"]`);
const fieldsIn = (el: ParentNode) =>
	[...el.querySelectorAll<HTMLElement>('[data-field]')].map((f) => f.dataset.field);
const edit = (t: ParentNode) =>
	[...t.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).trim() === 'Edit');

it.live('read: unlisted fields stay readable and unknown section fields warn', () =>
	Effect.gen(function* () {
		const { target, warned } = yield* browser(() => show({ id: 'j1', sections: SECTIONS }));
		assert.deepEqual(fieldsIn(target).sort(), ['crew', 'notes', 'site', 'title']);
		assert.ok(warned.some((w) => /nope/.test(w)));
	})
);

it.live('read: defaultOpen false starts closed, its summary a function of the row', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() => show({ id: 'j1', sections: SECTIONS }));
		assert.equal(
			element<HTMLButtonElement>(section(target, 'more'), 'h3 button').getAttribute(
				'aria-expanded'
			),
			'false'
		);
		assert.equal(
			textOf(element<HTMLElement>(section(target, 'more'), '[data-section-summary]')),
			'Notes: Back door'
		);
		assert.ok(
			element<HTMLElement>(section(target, 'more'), '[data-field=notes]'),
			'collapsed, still mounted'
		);
	})
);

it.live('a string summary shows while closed', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			show({
				id: 'j1',
				sections: [
					{
						name: 'more',
						title: 'More',
						fields: ['notes'],
						defaultOpen: false,
						summary: 'Optional'
					}
				]
			})
		);
		assert.equal(
			textOf(element<HTMLElement>(section(target, 'more'), '[data-section-summary]')),
			'Optional'
		);
	})
);

it.live('edit: the form is sectioned and a collapsed field still saves', () =>
	Effect.gen(function* () {
		const { target, sent } = yield* browser(() => show({ id: 'j1', sections: SECTIONS }));
		required(edit(target)).click();
		yield* browser(() => settle());
		const form = element<HTMLFormElement>(target, 'form');
		assert.equal(
			element<HTMLButtonElement>(section(form, 'more'), 'h3 button').getAttribute('aria-expanded'),
			'false'
		);
		const notes = element<HTMLInputElement>(
			form,
			'[data-field=notes] input, [data-field=notes] textarea'
		);
		notes.value = 'Front gate';
		notes.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() => settle());
		assert.equal(
			textOf(element<HTMLElement>(section(form, 'more'), '[data-section-summary]')),
			'Notes: Front gate',
			'the summary reads the draft'
		);
		const save = [...target.querySelectorAll<HTMLButtonElement>('[data-record-head] button')].find(
			(button) => textOf(button).trim() === 'Save'
		);
		assert.ok(save);
		save.click();
		yield* browser(() => settle());
		assert.equal(sent.length, 1);
		assert.deepEqual(required(sent[0])[1], [{ target: 'j1', set: { notes: 'Front gate' } }]);
	})
);
