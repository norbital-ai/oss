import './dom.ts';
import assert from 'node:assert/strict';
import { it as test, afterEach } from '@effect/vitest';
import type { Component } from 'svelte';
import type { Value } from '@norbital-ai/std/kind';
import { element } from './elements.ts';
const { mount, unmount, flushSync, tick } = await import('svelte');
const { default: TimeInput } = await import('../src/kinds/time-input.svelte');
const { default: TimeRangeInput } = await import('../src/kinds/time-range-input.svelte');
const mounted: (() => Promise<void>)[] = [];
const settle = async () => {
	for (let i = 0; i < 4; i++) {
		flushSync();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
};
afterEach(async () => {
	for (const dispose of mounted.splice(0)) await dispose();
	document.body.replaceChildren();
});
async function show<Props extends Record<string, unknown>>(
	component: Component<Props>,
	props: Props
) {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(component, { target, props });
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return target;
}
test('a day picker opens on its first activation after its native mount completes', async () => {
	const changes: Value[] = [];
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(TimeInput, {
		target,
		props: {
			id: 'report-day',
			value: '2026-10-15',
			onChange: (next: Value) => changes.push(next)
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await tick();
	const trigger = element<HTMLButtonElement>(target, '[data-segment="trigger"]');
	trigger.click();
	await tick();
	assert.equal(trigger.getAttribute('aria-expanded'), 'true');
	element(document, '[data-value="2026-10-01"][role="button"]').click();
	await tick();
	assert.deepEqual(changes, ['2026-10-01']);
});
test('a date range commits only after both dates are chosen', async () => {
	const changes: Value[] = [];
	const target = await show(TimeRangeInput, {
		of: 'date',
		precision: 'day',
		value: { from: '2026-10-01', to: '2026-10-10' },
		onChange: (v: Value) => changes.push(v)
	});
	assert.ok(target.textContent?.includes('2026'));
	element(target, '[data-period-input]').click();
	await settle();
	element(document, '[data-value="2026-10-03"][role="button"]').click();
	await settle();
	assert.equal(changes.length, 0, 'a partial range must not refresh a live report');
	element(document, '[data-value="2026-10-08"][role="button"]').click();
	await settle();
	assert.deepEqual(changes.at(-1), { from: '2026-10-03', to: '2026-10-08' });
});
test('time values accept arrays and expose add/remove only when editable', async () => {
	const changes: Value[] = [];
	const target = await show(TimeInput, {
		of: 'date',
		precision: 'month',
		value: ['2026-10-01', '2026-11-01'],
		onChange: (v: Value) => changes.push(v)
	});
	assert.equal(target.querySelectorAll('[data-unit-picker="month"]').length, 2);
	const remove = [...target.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
	assert.ok(remove);
	remove.click();
	await settle();
	assert.deepEqual(changes.at(-1), ['2026-11-01']);
	const readonly = await show(TimeInput, {
		of: 'date',
		precision: 'month',
		value: ['2026-10-01'],
		readonly: true,
		onChange: () => assert.fail('readonly')
	});
	assert.ok(
		![...readonly.querySelectorAll('button')].some((b) =>
			['Add', 'Remove'].includes(b.textContent ?? '')
		)
	);
});
test('range arrays preserve the other ranges when removing an entry', async () => {
	const first = { from: '2026-10-01', to: '2026-10-10' },
		second = { from: '2026-11-01', to: null };
	let next: Value | undefined;
	const target = await show(TimeRangeInput, {
		of: 'date',
		precision: 'day',
		value: [first, second],
		onChange: (v: Value) => (next = v)
	});
	assert.equal(target.querySelectorAll('[data-period-input]').length, 2);
	const remove = [...target.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
	assert.ok(remove);
	remove.click();
	await settle();
	assert.deepEqual(next, [second]);
});

test('month ranges can move beyond the old end and commit whole units', async () => {
	const changes: Value[] = [];
	const target = await show(TimeRangeInput, {
		of: 'date',
		precision: 'month',
		value: { from: '2026-10-01', to: '2026-10-31' },
		onChange: (v: Value) => changes.push(v)
	});
	element(target, '[data-period-input]').click();
	await settle();
	element(document, '[data-unit="2026-11-01"]').click();
	await settle();
	assert.equal(changes.length, 0);
	element(document, '[data-unit="2026-12-01"]').dispatchEvent(new Event('pointerenter'));
	await settle();

	element(document, '[data-unit="2026-12-01"]').click();
	await settle();
	assert.deepEqual(changes.at(-1), { from: '2026-11-01', to: '2026-12-31' });
});

test('month ranges expose selected intermediate units', async () => {
	const target = await show(TimeRangeInput, {
		of: 'date',
		precision: 'month',
		value: { from: '2026-09-01', to: '2026-11-30' },
		onChange: () => {}
	});
	element(target, '[data-period-input]').click();
	await settle();
	const middle = element(document, '[data-unit="2026-10-01"]');
	assert.equal(middle.getAttribute('aria-selected'), 'true');
	assert.equal(document.querySelectorAll('[data-unit-picker="month"]').length, 0);
});
