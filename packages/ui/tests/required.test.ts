// The required marker is derived, never authored: a field's label shows `*` and its control `aria-required` when its
// exposed kind (or relation) must be given, whether the kind's editor or an `editor` snippet renders the control.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { Effect } from 'effect';
import { viewFixture, browser } from './view-fixture.ts';
import { element } from './elements.ts';
import type { KindsHost } from '../src/kinds/context.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./required-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			notes: { kind: 'text', optional: true },
			status: { kind: 'enum', values: ['open', 'done'], default: 'open' },
			urgent: { kind: 'bool' },
			code: { kind: 'text' }
		},
		relations: {
			customer_id: { targets: ['customers'] },
			owner_id: { targets: ['owners'], optional: true }
		},
		create: {
			columns: ['title', 'notes', 'status', 'urgent', 'customer_id', 'owner_id', 'code']
		},
		update: {
			columns: ['title', 'notes', 'status', 'urgent', 'customer_id', 'owner_id', 'code']
		}
	},
	customers: { label: ['name'], fields: { name: { kind: 'text' } } },
	owners: { label: ['name'], fields: { name: { kind: 'text' } } }
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
});
async function show(record?: Record<string, string | boolean> & { id: string }) {
	const { bolt } = await viewFixture({});
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: { bolt, catalog, ...(record === undefined ? {} : { record }) }
	});
	await settle();
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	return target;
}
const marked = (t: ParentNode, field: string) =>
	element(t, `[data-field=${field}] label`).querySelector('span[aria-label]')?.textContent === '*';
const control = (t: ParentNode, field: string) =>
	element(
		t,
		`#${CSS.escape(element(t, `[data-field=${field}] label`).getAttribute('for') ?? '')}`
	).getAttribute('aria-required');

it.live('a required scalar, relation and snippet-rendered field are marked; others are not', () =>
	Effect.gen(function* () {
		const target = yield* browser(() => show());
		for (const field of ['title', 'customer_id', 'code']) {
			assert.ok(marked(target, field), `${field} shows *`);
			assert.equal(control(target, field), 'true', `${field}'s control is aria-required`);
		}
		for (const field of ['notes', 'status', 'urgent', 'owner_id'])
			assert.ok(!marked(target, field), `${field} shows no *`);
		for (const field of ['notes', 'owner_id'])
			assert.equal(control(target, field), null, `${field}'s control is not aria-required`);
	})
);

it.live(
	"a viewed record's fields are readonly, an `editor` snippet included: nothing is editable before Edit",
	() =>
		Effect.gen(function* () {
			const target = yield* browser(() =>
				show({
					id: 'j1',
					title: 'Pipe',
					code: 'X1',
					status: 'open',
					urgent: false,
					customer_id: 'c1'
				})
			);
			for (const field of ['title', 'code', 'customer_id'])
				assert.ok(element(target, `[data-field=${field}]`).hasAttribute('data-readonly'), field);
			assert.equal(
				target.querySelector('input, select, textarea, [role=combobox]'),
				null,
				'no editor'
			);
		})
);
