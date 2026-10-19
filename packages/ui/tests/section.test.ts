import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { Effect } from 'effect';
// Progressive disclosure: a titled section collapses from its heading, remembers the viewer's choice, shows a summary
// while closed, opens itself over an error, and keeps its fields mounted so a collapsed field still saves.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { viewFixture, jsonRecord, browser, type ViewScript } from './view-fixture.ts';
import type { Json } from '@norbital-ai/std/wire';
import type { KindsHost } from '../src/kinds/context.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./section-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			notes: { kind: 'text', optional: true },
			kind: { kind: 'enum', values: ['a', 'b'], optional: true }
		},
		create: { columns: ['title', 'notes', 'kind'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
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
async function show(
	act: ViewScript['act'] = () => ({ kind: 'committed', output: null, records: [] })
) {
	const sent: [string, Json][] = [];
	const { bolt } = await viewFixture({
		act: (c, input, options) => {
			sent.push([c, input]);
			return act(c, input, options);
		}
	});
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog } });
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return { target, sent };
}
const section = (t: ParentNode, name: string) =>
	element<HTMLElement>(t, `[data-section="${name}"]`);
const header = (t: ParentNode, name: string) =>
	element<HTMLButtonElement>(section(t, name), 'h3 button');
const body = (t: ParentNode, name: string) =>
	element<HTMLElement>(
		t,
		`#${CSS.escape(required(header(t, name).getAttribute('aria-controls')))}`
	);
const type = (t: ParentNode, field: string, value: string) => {
	const input = element<HTMLInputElement | HTMLTextAreaElement>(
		t,
		`[data-field=${field}] input, [data-field=${field}] textarea`
	);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
};

it.live(
	'the heading is a button that toggles the body; aria-expanded and aria-controls follow',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => show());
			const b = header(target, 'Job');
			assert.equal(b.type, 'button', 'a native button: Enter and Space work');
			assert.equal(b.getAttribute('aria-expanded'), 'true');
			assert.equal(body(target, 'Job').hidden, false);
			b.click();
			flushSync();
			assert.equal(b.getAttribute('aria-expanded'), 'false');
			assert.equal(body(target, 'Job').hidden, true);
			assert.ok(
				element<HTMLElement>(target, '[data-field=title]'),
				'collapsed, the field stays mounted'
			);
		})
);

it.live(
	'defaultOpen={false} starts closed with its summary in the heading; opening hides the summary',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => show());
			const b = header(target, 'Notes');
			assert.equal(b.getAttribute('aria-expanded'), 'false');
			assert.equal(
				textOf(element<HTMLElement>(section(target, 'Notes'), '[data-section-summary]')),
				'Not set'
			);
			assert.equal(
				section(target, 'Job').querySelector('[data-section-summary]'),
				null,
				'an open section shows no summary'
			);
			b.click();
			flushSync();
			assert.equal(section(target, 'Notes').querySelector('[data-section-summary]'), null);
		})
);

it.live("the viewer's choice is remembered per collection and section", () =>
	Effect.gen(function* () {
		const first = yield* browser(() => show());
		header(first.target, 'Notes').click();
		header(first.target, 'Job').click();
		flushSync();
		assert.equal(localStorage.getItem('norbital.section:jobs:Notes'), '1');
		{
			const close = mounted.pop();
			assert.ok(close);
			yield* browser(close);
		}
		const again = yield* browser(() => show());
		assert.equal(header(again.target, 'Notes').getAttribute('aria-expanded'), 'true');
		assert.equal(header(again.target, 'Job').getAttribute('aria-expanded'), 'false');
	})
);

it.live('storage that throws: sections still render and toggle', () =>
	Effect.gen(function* () {
		const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			get() {
				throw new Error('blocked');
			},
			configurable: true
		});
		try {
			const { target } = yield* browser(() => show());
			header(target, 'Notes').click();
			flushSync();
			assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'true');
		} finally {
			assert.ok(real);
			Object.defineProperty(globalThis, 'localStorage', real);
		}
	})
);

it.live('a section that does not opt in, or opts out of collapsing, stays open', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() => show());
		assert.equal(header(target, 'Job').getAttribute('aria-expanded'), 'true');
		assert.equal(
			section(target, 'Fixed').querySelector('h3 button'),
			null,
			'collapsible={false}: no toggle'
		);
		assert.equal(section(target, 'Fixed').querySelector('[hidden]'), null);
	})
);

it.live('a collapsed section with a field error opens itself', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() =>
			show(() => ({ kind: 'refused', code: 'check', message: 'Too long', field: 'notes' }))
		);
		type(target, 'title', 'Paint');
		flushSync();
		assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'false');
		element<HTMLFormElement>(target, 'form').requestSubmit();
		yield* browser(() => settle());
		assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'true');
		assert.equal(body(target, 'Notes').hidden, false);
		assert.match(textOf(section(target, 'Notes')), /Too long/);
	})
);

it.live('a form with collapsed sections still saves every field', () =>
	Effect.gen(function* () {
		const { target, sent } = yield* browser(() => show());
		type(target, 'title', 'Paint');
		type(target, 'notes', 'Back door');
		header(target, 'Job').click();
		flushSync();
		assert.equal(body(target, 'Job').hidden, true);
		assert.equal(body(target, 'Notes').hidden, true);
		element<HTMLFormElement>(target, 'form').requestSubmit();
		yield* browser(() => settle());
		assert.equal(sent.length, 1);
		assert.equal(required(sent[0])[0], 'jobs.create');
		assert.equal(jsonRecord(required(sent[0])[1]).title, 'Paint');
		assert.equal(jsonRecord(required(sent[0])[1]).notes, 'Back door');
	})
);
