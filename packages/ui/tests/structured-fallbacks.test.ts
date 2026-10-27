import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import type { ComponentProps } from 'svelte';
import type { Value } from '../src/kinds/kind.ts';
import { browser, required } from './view-fixture.ts';
const { mount, flushSync, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./json-schema-harness.svelte');
const { default: Renderer } = await import('./packaging-renderer.svelte');
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
};
async function show(props: Omit<ComponentProps<typeof Harness>, 'changed'>) {
	const target = document.createElement('div');
	document.body.append(target);
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

it.live('untyped structured JSON edits inferred native fields without losing other values', () =>
	browser(async () => {
		const { target, changes } = await show({
			kind: { kind: 'json' },
			initial: { name: 'A', enabled: false, count: 0 }
		});
		assert.equal(target.querySelector('.cm-editor'), null);
		const name = required(
			[...target.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value === 'A')
		);
		name.value = 'B';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		assert.deepEqual(changes.at(-1), { name: 'B', enabled: false, count: 0 });
	})
);

it.live(
	'structured read-only fallback preserves native kinds and never reveals hidden fields or masks',
	() =>
		browser(async () => {
			const { target } = await show({
				view: true,
				kind: {
					kind: 'object',
					fields: {
						name: { kind: 'text' },
						secret: { kind: 'text', hidden: true },
						restricted: { kind: 'json' }
					}
				},
				initial: { name: 'Shown', secret: 'private value', restricted: { $masked: true } }
			});
			assert.ok(target.textContent?.includes('Shown'));
			assert.ok(target.textContent?.includes('•••'));
			assert.equal(target.textContent?.includes('private value'), false);
			assert.equal(target.textContent?.includes('$masked'), false);
		})
);

it.live(
	'model fallback opens the same native table and keeps hidden fields out of its preview',
	() =>
		browser(async () => {
			const { target } = await show({
				cell: true,
				kind: {
					kind: 'object',
					fields: {
						name: { kind: 'text' },
						secret: { kind: 'text', hidden: true },
						rows: {
							kind: 'list',
							of: { kind: 'object', fields: { code: { kind: 'text' }, paid: { kind: 'bool' } } }
						}
					}
				},
				initial: {
					name: 'Annual leave',
					secret: 'private value',
					rows: [{ code: 'annual', paid: false }]
				}
			});
			const trigger = required(
				target.querySelector<HTMLButtonElement>('[data-structured-preview]')
			);
			assert.ok(trigger.textContent?.includes('Annual leave'));
			assert.equal(trigger.textContent?.includes('private value'), false);
			assert.equal(trigger.querySelector('button'), null);
			trigger.click();
			await settle();
			const inspector = required(document.querySelector('[data-structured-inspector]'));
			assert.ok(inspector.querySelector('[data-view=table]'));
			assert.equal(inspector.textContent?.includes('private value'), false);
			assert.ok(inspector.querySelector('[role=checkbox][aria-checked=false]'));
		})
);

it.live('a model custom datatype keeps its authored renderer ahead of the fallback', () =>
	browser(async () => {
		const { target } = await show({
			cell: true,
			kind: { kind: 'custom', of: 'sign' },
			host: { customFields: { sign: { shape: { kind: 'text' }, renderer: Renderer } } },
			initial: 'A. Tan'
		});
		assert.equal(target.querySelector('[data-renderer=show]')?.textContent, 'A. Tan');
		assert.equal(target.querySelector('[data-structured-preview]'), null);
	})
);

it.live('model summaries respect hidden fields through nested JSON and custom shapes', () =>
	browser(async () => {
		const hidden = {
			kind: 'object',
			fields: { visible: { kind: 'text' }, secret: { kind: 'text', hidden: true } }
		} as const;
		for (const props of [
			{ kind: { kind: 'json', shape: { kind: 'json', shape: hidden } } },
			{
				kind: { kind: 'custom', of: 'nested' },
				host: {
					customFields: {
						nested: { shape: { kind: 'json', shape: { kind: 'json', shape: hidden } } }
					}
				}
			}
		] satisfies Omit<ComponentProps<typeof Harness>, 'changed' | 'initial'>[]) {
			const { target } = await show({
				...props,
				cell: true,
				initial: { visible: 'Public', secret: 'private value' }
			});
			const trigger = required(target.querySelector('[data-structured-preview]'));
			assert.ok(trigger.textContent?.includes('Public'));
			assert.equal(trigger.textContent?.includes('private value'), false);
		}
	})
);

it.live('untyped scalar JSON uses native inferred controls and keeps edit masks opaque', () =>
	browser(async () => {
		const boolean = await show({ kind: { kind: 'json' }, initial: false });
		assert.equal(boolean.target.querySelector('.cm-editor'), null);
		required(boolean.target.querySelector<HTMLButtonElement>('[role=checkbox]')).click();
		await settle();
		assert.equal(boolean.changes.at(-1), true);
		const text = await show({ kind: { kind: 'custom', of: 'unregistered' }, initial: 'kept' });
		assert.equal(text.target.querySelector<HTMLInputElement>('input')?.value, 'kept');
		const masked = await show({
			kind: { kind: 'json' },
			initial: { $masked: true },
			rawJson: true
		});
		assert.equal(masked.target.querySelector('.cm-editor,input,textarea'), null);
		assert.ok(masked.target.textContent?.includes('•••'));
		assert.deepEqual(masked.changes, []);
	})
);

it.live('a registered boolean shape uses the unified read-only checkbox fallback', () =>
	browser(async () => {
		const { target } = await show({
			view: true,
			kind: { kind: 'custom', of: 'toggle' },
			initial: false,
			host: { customFields: { toggle: { shape: { kind: 'bool' } } } }
		});
		assert.ok(target.querySelector('[role=checkbox][aria-checked=false]'));
	})
);
