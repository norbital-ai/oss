import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { browser, required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import type { ComponentProps } from 'svelte';
import type { Value, Kind } from '../src/kinds/kind.ts';
const { mount, flushSync, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./json-schema-harness.svelte');
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
};
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of mounted.splice(0).reverse()) await done();
	window.localStorage.clear();
});
async function show(props: Omit<ComponentProps<typeof Harness>, 'changed'>) {
	const target = document.createElement('div');
	document.body.append(target);
	const changes: Value[] = [];
	const app = mount(Harness, {
		target,
		props: { ...props, changed: (v: Value) => changes.push(v) }
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return { target, changes };
}
it.live(
	'Editor JSON schema entry point edits nested inputs without deleting unknown properties',
	() =>
		browser(async () => {
			const { target, changes } = await show({
				editor: true,
				schema: {
					type: 'object',
					required: ['name'],
					additionalProperties: false,
					properties: { name: { type: 'string' }, notes: { type: 'string' } }
				},
				initial: { name: 'A', legacy: 9 },
				errors: new Map([['input.notes', 'Required by payroll']])
			});
			const input = element<HTMLInputElement>(target, '[data-schema-field="input.name"] input');
			input.value = 'B';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			await settle();
			assert.deepEqual(changes.at(-1), { name: 'B', legacy: 9 });
			assert.ok(
				textOf(element(target, '[data-schema-field="input.notes"]')).includes('Required by payroll')
			);
		})
);
it.live('a create editor fills defaults, while an edit offers the default beside the control', () =>
	browser(async () => {
		const schema = {
			type: 'object',
			properties: { flag: { type: 'boolean', default: false } }
		};
		const created = await show({ schema, initial: {}, create: true });
		assert.deepEqual(created.changes.at(-1), { flag: false });
		assert.equal(created.target.querySelector('[aria-label="Use default"]'), null);

		const edited = await show({ schema, initial: {} });
		const widget = required(
			edited.target.querySelector<HTMLButtonElement>('[aria-label="Use default"]')
		);
		assert.equal(
			widget.closest('[data-schema-field]')?.getAttribute('data-schema-field'),
			'input.flag'
		);
		widget.click();
		await settle();
		assert.deepEqual(edited.changes.at(-1), { flag: false });
	})
);

const pick = async (trigger: HTMLElement, value: string) => {
	trigger.click();
	flushSync();
	await tick();
	element<HTMLButtonElement>(document, `[role=option][data-value="${value}"] button`).click();
	flushSync();
};

it.live('numeric and boolean enum options retain JSON types', () =>
	browser(async () => {
		const cases: { type: 'integer' | 'boolean'; values: (number | boolean)[] }[] = [
			{ type: 'integer', values: [1, 2] },
			{ type: 'boolean', values: [false, true] }
		];
		for (const { type, values } of cases) {
			const { target, changes } = await show({
				schema: { type, enum: values },
				initial: values[0]
			});
			await pick(element<HTMLElement>(target, '[role=combobox]'), '1');
			await settle();
			assert.equal(changes.at(-1), values[1]);
		}
	})
);
it.live('array add/remove limits and readonly controls work', () =>
	browser(async () => {
		const schema = {
			type: 'array',
			items: { type: 'string', default: 'new' },
			minItems: 1,
			maxItems: 2
		};
		const { target, changes } = await show({ schema, initial: ['existing'] });
		assert.equal(
			required([...target.querySelectorAll('button')].find((b) => textOf(b).includes('Remove')))
				.disabled,
			true
		);
		required([...target.querySelectorAll('button')].find((b) => textOf(b).includes('Add'))).click();
		await settle();
		assert.deepEqual(changes.at(-1), ['existing', 'new']);
		assert.equal(
			required([...target.querySelectorAll('button')].find((b) => textOf(b).includes('Add')))
				.disabled,
			true
		);
		const read = await show({ schema, initial: ['existing'], readonly: true });
		assert.equal(read.target.querySelectorAll('input,textarea,select').length, 0);
		assert.equal(
			[...read.target.querySelectorAll('button')].some((b) => /Add|Remove/.test(textOf(b))),
			false
		);
	})
);
it.live('tenant custom shapes and built-in phone resolve through the host registry', () =>
	browser(async () => {
		const tenant = await show({
			schema: { type: 'string', 'x-norbital': { datatype: 'reference' } },
			initial: 'A',
			host: { customFields: { reference: { shape: { kind: 'text' } } } }
		});
		assert.ok(tenant.target.querySelector('input'));
		const phone = await show({
			schema: { type: 'string', 'x-norbital': { datatype: 'phone' } },
			initial: '+6591234567'
		});
		assert.ok(phone.target.querySelector('input'));
	})
);

it.live(
	'dynamic-property errors open their section and array scalar controls have associated labels',
	() =>
		browser(async () => {
			const extra = await show({
				schema: { type: 'object', properties: { name: { type: 'string' } } },
				initial: { extra: 4 },
				errors: new Map([['input.extra', 'Use a positive amount']])
			});
			const section = element(extra.target, '[data-section$=":properties"]');
			assert.equal(section.getAttribute('data-open'), 'true');
			assert.ok(textOf(section).includes('Use a positive amount'));
			const array = await show({
				schema: { type: 'array', items: { type: 'string' } },
				initial: ['one']
			});
			const input = element<HTMLInputElement>(array.target, 'input');
			assert.ok(array.target.querySelector(`label[for="${input.id}"]`));
		})
);
it.live('unknown custom datatypes preserve their initial JSON in inferred fields', () =>
	browser(async () => {
		const { target } = await show({
			schema: { type: 'object', 'x-norbital': { datatype: 'missing' } },
			initial: { reference: 'kept' }
		});
		assert.equal(target.querySelector<HTMLInputElement>('input')?.value, 'kept');
	})
);
it.live(
	"a text field's `format: 'cel'` is a wrapped code editor, inside a json shape too, and the viewer shows it the same way, read-only",
	() =>
		browser(async () => {
			const cel: Kind = { kind: 'text', format: 'cel' };
			const { target, changes } = await show({
				kind: {
					kind: 'json',
					shape: { kind: 'object', fields: { label: { kind: 'text' }, when: cel } }
				},
				initial: { label: 'A', when: 'a > 1' }
			});
			const code = target.querySelector('[data-code-editor=javascript]');
			assert.ok(code, 'the CEL leaf is a code editor');
			assert.ok(code.querySelector('.cm-lineWrapping'), 'its lines wrap');
			assert.equal(textOf(code).includes('a > 1'), true);
			assert.equal(
				target.querySelectorAll('[data-code-editor]').length,
				1,
				'the plain text field stays an input'
			);
			assert.deepEqual(changes, []);
			const shown = await show({ kind: cel, initial: 'size(rows) > 0', view: true });
			const ro = element(shown.target, '[data-code-editor=javascript]');
			assert.ok(ro.querySelector('.cm-lineWrapping'));
			assert.equal(element(ro, '.cm-content').getAttribute('contenteditable'), 'false');
		})
);
it.live(
	'an array of flat objects edits as one table, and a cleared non-nullable field is absent, not null',
	() =>
		browser(async () => {
			const { target, changes } = await show({
				schema: {
					type: 'array',
					items: {
						type: 'object',
						required: ['code'],
						properties: {
							code: { type: 'string', title: 'Code' },
							note: { type: 'string' },
							until: { type: ['string', 'null'] }
						}
					}
				},
				initial: [{ code: 'A', note: 'x', until: 'y', kept: 1 }]
			});
			const table = element(target, 'table');
			assert.deepEqual(
				[...table.querySelectorAll('thead th')].map((th) => textOf(th).trim()),
				['Code*', 'Note', 'Until', 'Kept']
			);
			assert.equal(table.querySelectorAll('tbody tr').length, 1);
			const cells = table.querySelectorAll<HTMLInputElement>('tbody input');
			const note = required(cells[1]);
			note.value = '';
			note.dispatchEvent(new Event('input', { bubbles: true }));
			await settle();
			assert.deepEqual(changes.at(-1), [{ code: 'A', until: 'y', kept: 1 }]);
			required(
				[...target.querySelectorAll('button')].find((b) => textOf(b).includes('Add'))
			).click();
			await settle();
			assert.equal(element(target, 'table').querySelectorAll('tbody tr').length, 2);
		})
);
