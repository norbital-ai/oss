import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { ComponentProps } from 'svelte';
import type { Kind, Value } from '../src/kinds/kind.ts';
import { dataEntries } from '../src/kinds/structured-data.ts';
import { browser, required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
const { mount, unmount, flushSync, tick } = await import('svelte');
const { default: Harness } = await import('./structured-data-view-harness.svelte');
const { default: Renderer } = await import('./packaging-renderer.svelte');
const disposals: (() => Promise<void>)[] = [];
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
};
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
	document.body.replaceChildren();
	window.localStorage.clear();
});
async function show(props: Omit<ComponentProps<typeof Harness>, 'changed'>) {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: Value[] = [];
	const app = mount(Harness, {
		target,
		props: { ...props, changed: (value) => changes.push(value) }
	});
	disposals.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return { target, changes };
}
async function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}
async function pick(trigger: HTMLElement, value: string) {
	trigger.click();
	await settle();
	element<HTMLButtonElement>(document, `[role=option][data-value="${value}"] button`).click();
	await settle();
}

it.live('the depth cap terminates structured viewing and preserves the remaining value', () =>
	browser(async () => {
		const { target } = await show({ initial: { deep: { text: 'kept at the limit' } }, depth: 24 });
		assert.ok(textOf(target).includes('kept at the limit'));
		assert.ok(target.querySelectorAll('[data-structured-data]').length < 4);
	})
);

it.live(
	'nullable structures distinguish missing and null, including whole-value replacements',
	() =>
		browser(async () => {
			for (const type of ['object', 'array']) {
				const schema =
					type === 'object'
						? { type: ['object', 'null'], properties: { note: { type: 'string' } } }
						: { type: ['array', 'null'], items: { type: 'string' } };
				const empty = await show({ schema, initial: null });
				assert.equal(textOf(empty.target).trim(), 'Null');
				const absent = await show({ schema });
				assert.equal(textOf(absent.target).trim(), 'Not set');
				const held: Value = type === 'object' ? { note: 'recorded' } : ['recorded'];
				const removed = await show({ schema, before: held, initial: null, mode: 'diff' });
				assert.ok(textOf(element(removed.target, 'del')).includes('recorded'));
				assert.equal(textOf(element(removed.target, 'ins')).trim(), 'Null');
				const added = await show({ schema, before: null, initial: held, mode: 'diff' });
				assert.equal(textOf(element(added.target, 'del')).trim(), 'Null');
				assert.ok(textOf(element(added.target, 'ins')).includes('recorded'));
			}
		})
);

it.live('lists of native date ranges retain one native Value column and editor', () =>
	browser(async () => {
		const { target } = await show({
			kind: { kind: 'list', of: { kind: 'period', of: 'date' } },
			initial: [{ from: '2026-10-01', to: '2026-10-31' }],
			mode: 'edit'
		});
		const table = element(target, '[data-view=table] table');
		assert.deepEqual(
			[...table.querySelectorAll('thead th')].map((cell) => textOf(cell).trim()),
			['Value']
		);
		assert.equal(table.querySelectorAll('[data-period-input]').length, 1);
		const view = await show({
			kind: { kind: 'list', of: { kind: 'period', of: 'date' } },
			initial: [{ from: '2026-01-01', to: '2026-02-01' }]
		});
		assert.equal(view.target.querySelector('.cm-editor'), null);
		assert.ok(textOf(view.target).includes('2026'));
		const enums = await show({
			kind: { kind: 'enum', many: true, values: ['one', 'two'] },
			initial: ['one', 'two']
		});
		assert.equal(enums.target.querySelectorAll('[data-enum-value]').length, 2);
	})
);

it.live(
	'switching a tagged native union rebuilds the arm instead of retaining obsolete fields',
	() =>
		browser(async () => {
			const { target, changes } = await show({
				kind: {
					kind: 'union',
					by: 'basis',
					arms: {
						hourly: { rate: { kind: 'number' } },
						fixed: { salary: { kind: 'number' } }
					}
				},
				initial: { basis: 'hourly', rate: 5 },
				mode: 'edit'
			});
			await pick(element(target, '[role=combobox]'), 'fixed');
			const next = required(dataEntries(changes.at(-1)));
			assert.equal(next.basis, 'fixed');
			assert.equal(Object.hasOwn(next, 'rate'), false);
			assert.equal(Object.hasOwn(next, 'salary'), true);
		})
);

it.live('an untagged union retains the matching native arm and its hidden-field policy', () =>
	browser(async () => {
		const { target } = await show({
			kind: {
				kind: 'union',
				of: [
					{
						kind: 'object',
						fields: { code: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
					},
					{ kind: 'text' }
				]
			},
			initial: { code: 'visible record', secret: 'private arm value' }
		});
		assert.ok(textOf(target).includes('visible record'));
		assert.equal(textOf(target).includes('private arm value'), false);
	})
);

it.live(
	'native clearing preserves explicit null while nonnullable JSON Schema clearing omits the key',
	() =>
		browser(async () => {
			const native: Kind = {
				kind: 'object',
				fields: { count: { kind: 'number', optional: true } }
			};
			const direct = await show({ kind: native, initial: { count: 3 }, mode: 'edit' });
			await type(
				element<HTMLInputElement>(direct.target, '[data-schema-field="input.count"] input'),
				''
			);
			assert.deepEqual(direct.changes.at(-1), { count: null });
			const list = await show({
				kind: { kind: 'list', of: native },
				initial: [{ count: 3 }],
				mode: 'edit'
			});
			await type(element<HTMLInputElement>(list.target, 'tbody input'), '');
			assert.deepEqual(list.changes.at(-1), [{ count: null }]);
			const schema = {
				type: 'object',
				properties: { count: { type: 'number' } },
				additionalProperties: false
			};
			const form = await show({ schema, initial: { count: 3 }, mode: 'edit' });
			await type(
				element<HTMLInputElement>(form.target, '[data-schema-field="input.count"] input'),
				''
			);
			assert.deepEqual(form.changes.at(-1), {});
		})
);

it.live('inferred Decimal edits retain exact values beyond the safe integer range', () =>
	browser(async () => {
		const { target, changes } = await show({
			initial: { amount: Decimal.of('9007199254740993.01') },
			mode: 'edit'
		});
		await type(
			element<HTMLInputElement>(target, '[data-schema-field="input.amount"] input'),
			'9007199254740993.02'
		);
		const amount = required(dataEntries(changes.at(-1))).amount;
		assert.ok(amount instanceof Decimal);
		assert.equal(amount.toString(), '9007199254740993.02');
	})
);

it.live('custom renderers retain precedence for false and empty string values', () =>
	browser(async () => {
		for (const value of [false, '']) {
			const { target } = await show({
				kind: { kind: 'custom', of: 'status' },
				initial: value,
				host: {
					customFields: {
						status: {
							shape: typeof value === 'boolean' ? { kind: 'bool' } : { kind: 'text' },
							renderer: Renderer
						}
					}
				}
			});
			assert.equal(textOf(element(target, '[data-renderer=show]')), String(value));
		}
	})
);

it.live('empty container additions and removals remain visible as inline changes', () =>
	browser(async () => {
		const { target } = await show({
			before: { removedObject: {}, removedArray: [] },
			initial: { addedObject: {}, addedArray: [] },
			mode: 'diff',
			changesOnly: true
		});
		const removed = [...target.querySelectorAll('del')].map(textOf).join(' ');
		const added = [...target.querySelectorAll('ins')].map(textOf).join(' ');
		assert.ok(removed.includes('Empty object') && removed.includes('Empty array'));
		assert.ok(added.includes('Empty object') && added.includes('Empty array'));
	})
);

it.live('masked fields remain opaque while neighboring fields are edited', () =>
	browser(async () => {
		const { target, changes } = await show({
			initial: { restricted: { $masked: true }, name: 'Allowed' },
			mode: 'edit'
		});
		const field = element(target, '[data-schema-field="input.restricted"]');
		assert.ok(textOf(field).includes('•••'));
		assert.equal(textOf(field).includes('$masked'), false);
		assert.equal(field.querySelector('input, textarea, .cm-editor'), null);
		assert.deepEqual(changes, []);
	})
);

it.live(
	'schema authoring uses the native table and preserves unedited keywords while changing fields',
	() =>
		browser(async () => {
			const schema = {
				$schema: 'https://json-schema.org/draft/2020-12/schema',
				$id: 'schema-author-preserved',
				type: 'object',
				additionalProperties: false,
				properties: {
					count: {
						type: 'number',
						title: 'Old count',
						minimum: 0,
						maximum: 100,
						'x-vendor': { code: 'kept' }
					},
					contact: {
						type: 'string',
						title: 'Contact',
						format: 'email',
						maxLength: 120,
						pattern: '@example\\.com$'
					}
				}
			};
			const { target, changes } = await show({ schema, mode: 'schema', author: true });
			const table = element(target, '[data-view=table][data-source=local] table');
			assert.deepEqual(
				[...table.querySelectorAll('thead th')].map((cell) => textOf(cell).trim()),
				['Key*', 'Type*', 'Label', 'Required', 'Allowed values', 'Description']
			);
			const label = required(
				[...table.querySelectorAll<HTMLInputElement>('input')].find(
					(input) => input.value === 'Old count'
				)
			);
			await type(label, 'Changed count');
			await pick(element(table, 'tbody tr [role=combobox]'), 'integer');
			element<HTMLButtonElement>(table, 'tbody tr [role=checkbox]').click();
			await settle();
			const result = required(dataEntries(changes.at(-1)));
			const properties = required(dataEntries(result.properties));
			assert.deepEqual(properties.count, {
				...schema.properties.count,
				type: 'integer',
				title: 'Changed count'
			});
			assert.deepEqual(properties.contact, schema.properties.contact);
			assert.deepEqual(result.required, ['count']);
			assert.equal(result.$schema, schema.$schema);
			assert.equal(result.$id, schema.$id);
			assert.equal(result.additionalProperties, false);
		})
);

it.live(
	'the depth-cap JSON retains registered shape visibility and opaque renderer boundaries',
	() =>
		browser(async () => {
			const { target } = await show({
				depth: 24,
				kind: {
					kind: 'object',
					fields: {
						shaped: { kind: 'custom', of: 'privateShape' },
						rendered: { kind: 'custom', of: 'privateRenderer' }
					}
				},
				initial: {
					shaped: { public: 'Visible custom value', secret: 'hidden custom shape value' },
					rendered: { raw: 'private renderer payload' }
				},
				host: {
					customFields: {
						privateShape: {
							shape: {
								kind: 'object',
								fields: { public: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
							}
						},
						privateRenderer: {
							label: 'Rendered details',
							shape: { kind: 'object', fields: { raw: { kind: 'text' } } },
							renderer: Renderer
						}
					}
				}
			});
			const text = textOf(target);
			assert.ok(text.includes('Visible custom value'));
			assert.equal(text.includes('hidden custom shape value'), false);
			assert.equal(text.includes('private renderer payload'), false);
		})
);

it.live(
	'schema units stay visible once in field and native table labels while zero remains zero',
	() =>
		browser(async () => {
			const reading = { type: 'number', title: 'Reading', unit: 'MΩ' };
			const record = await show({
				schema: { type: 'object', properties: { reading } },
				initial: { reading: 0 }
			});
			assert.ok(textOf(record.target).includes('Reading (MΩ)'));
			assert.ok(textOf(record.target).includes('0'));
			const list = await show({
				schema: {
					type: 'array',
					items: { type: 'object', properties: { reading: { ...reading, title: 'Reading (MΩ)' } } }
				},
				initial: [{ reading: 0 }]
			});
			const header = textOf(element(list.target, 'thead th'));
			assert.equal(header.match(/MΩ/g)?.length, 1);
			assert.ok(textOf(list.target).includes('0'));
		})
);

it.live(
	'record-shaped union and registered schema datatype items keep native Value cells and hidden-field boundaries',
	() =>
		browser(async () => {
			const union = await show({
				kind: {
					kind: 'list',
					of: {
						kind: 'union',
						by: 'basis',
						arms: {
							employee: { code: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
						}
					}
				},
				initial: [{ basis: 'employee', code: 'Visible union item', secret: 'private union item' }]
			});
			const unionTable = element(union.target, '[data-view=table] table');
			assert.deepEqual(
				[...unionTable.querySelectorAll('thead th')].map((cell) => textOf(cell).trim()),
				['Value']
			);
			assert.ok(textOf(union.target).includes('Visible union item'));
			assert.equal(textOf(union.target).includes('private union item'), false);
			for (const rendered of [false, true]) {
				const custom = await show({
					schema: {
						type: 'array',
						items: { type: 'object', 'x-norbital': { datatype: 'confidential' } }
					},
					initial: [{ public: 'Visible schema item', secret: 'private schema item' }],
					host: {
						customFields: {
							confidential: {
								shape: {
									kind: 'object',
									fields: { public: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
								},
								...(rendered ? { renderer: Renderer } : {})
							}
						}
					}
				});
				const table = element(custom.target, '[data-view=table] table');
				assert.deepEqual(
					[...table.querySelectorAll('thead th')].map((cell) => textOf(cell).trim()),
					['Value']
				);
				assert.equal(textOf(custom.target).includes('private schema item'), false);
				if (rendered) assert.ok(custom.target.querySelector('[data-renderer=show]'));
				else assert.ok(textOf(custom.target).includes('Visible schema item'));
			}
		})
);

it.live('inline native money differences retain each version currency context', () =>
	browser(async () => {
		const { target } = await show({
			kind: {
				kind: 'object',
				fields: { currency: { kind: 'text' }, amount: { kind: 'money', currency: 'currency' } }
			},
			before: { currency: 'USD', amount: Decimal.of('1.00') },
			initial: { currency: 'EUR', amount: Decimal.of('2.00') },
			mode: 'diff',
			host: { locale: 'en-US' }
		});
		const amount = element(target, '[data-schema-field="input.amount"]');
		assert.ok(textOf(element(amount, 'del')).includes('USD 1.00'));
		assert.ok(textOf(element(amount, 'ins')).includes('EUR 2.00'));
	})
);

it.live('a schema variant switch preserves the prior nested custom visibility rules', () =>
	browser(async () => {
		const { target } = await show({
			schema: {
				type: 'object',
				oneOf: [
					{
						properties: {
							type: { const: 'restricted' },
							payload: { type: 'object', 'x-norbital': { datatype: 'confidential' } }
						}
					},
					{
						properties: {
							type: { const: 'public' },
							payload: { type: 'object', properties: { public: { type: 'string' } } }
						}
					}
				]
			},
			before: {
				type: 'restricted',
				payload: { public: 'Prior visible', secret: 'prior private variant' }
			},
			initial: { type: 'public', payload: { public: 'Current visible' } },
			mode: 'diff',
			host: {
				customFields: {
					confidential: {
						shape: {
							kind: 'object',
							fields: { public: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
						}
					}
				}
			}
		});
		assert.ok(textOf(target).includes('Prior visible'));
		assert.ok(textOf(target).includes('Current visible'));
		assert.equal(textOf(target).includes('prior private variant'), false);
	})
);

it.live(
	'an unconstrained JSON kind retains schema controls, inference and exact Decimal editing',
	() =>
		browser(async () => {
			const date = await show({
				kind: { kind: 'json' },
				schema: { type: 'string', format: 'date' },
				initial: '2026-01-01',
				mode: 'edit'
			});
			assert.ok(date.target.querySelector('[data-date-input]'));
			const inferred = await show({
				kind: { kind: 'json' },
				initial: { count: 0 },
				mode: 'schema'
			});
			assert.ok(textOf(inferred.target).includes('integer'));
			const decimal = await show({
				kind: { kind: 'json' },
				initial: Decimal.of('9007199254740993.20'),
				mode: 'edit'
			});
			const input = element<HTMLInputElement>(decimal.target, 'input');
			await type(input, '9007199254740993.21');
			const next = required(decimal.changes.at(-1));
			assert.ok(next instanceof Decimal);
			assert.equal(next.toString(), '9007199254740993.21');
		})
);

it.live(
	'structured enum choices and constants retain their native constrained editing behavior',
	() =>
		browser(async () => {
			const enumeration = await show({
				schema: { type: 'array', enum: [[0], [1]] },
				initial: [0],
				mode: 'edit'
			});
			await pick(element(enumeration.target, '[role=combobox]'), '1');
			assert.deepEqual(enumeration.changes.at(-1), [1]);
			const fixed = await show({
				schema: { type: 'object', const: { ready: false } },
				initial: { ready: true },
				mode: 'edit'
			});
			required(
				[...fixed.target.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
					textOf(button).includes('Use fixed value')
				)
			).click();
			await settle();
			assert.deepEqual(fixed.changes.at(-1), { ready: false });
		})
);
