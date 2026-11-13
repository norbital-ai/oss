/// <reference types="@vitest/browser-playwright" />
// The print route's view (`?record=<model>/<id>&print`, `ctx.convert.record`): the record alone, no sheet or footer
// controls, and `<html data-bolt-print="ready">` only once its reads have settled.
import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import type { UiContext } from '@norbital-ai/ui';
import { mount, unmount } from 'svelte';
import type { KindsHost } from '../../ui/src/kinds/context.ts';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import RecordPrint from '../src/shell/RecordPrint.svelte';
import './support/shell.css';

const catalog = {
	jobs: { label: ['title'], fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true } } }
} satisfies NonNullable<KindsHost['catalog']>;

it('renders the record view without chrome and signals ready when its reads settle', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const fixture = await scriptedBolt({
		catalog,
		answer: async (read) => {
			if (read.m !== 'query') return [];
			await held;
			return {
				jobs: { rows: [{ id: 'j1', revision: 1, title: 'Paint v3', crew: 'B' }], next: null, total: 1 }
			};
		}
	});
	const bolt = fixture.bolt;
	const ctx: UiContext = {
		ui: { bolt, kinds: { catalog, query: (request) => bolt.query(request) } }
	};
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(RecordPrint, { target, props: { ctx, model: 'jobs', id: 'j1' } });
	try {
		await expect.poll(() => target.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(document.documentElement.dataset['boltPrint']).toBeUndefined();
		release();
		await expect.poll(() => document.documentElement.dataset['boltPrint']).toBe('ready');
		expect(target.querySelector('[data-view=record]')?.textContent).toContain('Paint v3');
		expect(target.querySelector('[data-sheet-side]')).toBeNull();
		const foot = target.querySelector<HTMLElement>('[data-record-foot]');
		if (foot !== null) expect(getComputedStyle(foot).display).toBe('none');
	} finally {
		await unmount(view);
		await fixture.dispose();
		await dispose();
		target.remove();
	}
	expect(document.documentElement.dataset['boltPrint']).toBeUndefined();
});
