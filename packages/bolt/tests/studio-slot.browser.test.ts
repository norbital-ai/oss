/// <reference types="@vitest/browser-playwright" />
// Studio's place in the shell: the host's bundle is imported by URL, shares nothing with the page, follows the URL through
// `update`, unmounts on leave, and a bundle that cannot be loaded says so plainly.
import { expect, it } from '@effect/vitest';
import { mountEdge } from '@norbital-ai/ui/effect';
import { Layer, ManagedRuntime } from 'effect';
import { mount, tick, unmount } from 'svelte';
import { page } from 'vitest/browser';
import StudioSlot from '../src/shell/studio/StudioSlot.svelte';
import type { StudioProps } from '../src/shell/studio/slot.ts';
import { reactive } from './support/reactive.svelte.ts';
import './support/shell.css';

const props: StudioProps = {
	t: (key) => key,
	locale: 'en',
	uiText: {},
	tab: 'workbench',
	onTab: () => {},
	file: null,
	onFile: () => {},
	admin: true,
	onAsk: null
};
const moduleUrl = (source: string) =>
	URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
const bundle = moduleUrl(`export const mountStudio = (target, props) => {
	target.textContent = 'tab ' + props.tab;
	return {
		update: (next) => { target.textContent = 'tab ' + next.tab; },
		unmount: async () => { document.body.dataset.studioUnmounted = 'yes'; }
	};
};`);
const withSlot = async (url: string | undefined, check: (state: { props: StudioProps }) => Promise<void>) => {
	const target = document.body.appendChild(document.createElement('div'));
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	const state = reactive({ bundle: url, props });
	const view = mount(StudioSlot, { target, props: state });
	try {
		await check(state);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
	}
};

it('mounts the bundle, carries a moved URL in, and unmounts on leave', async () => {
	delete document.body.dataset.studioUnmounted;
	await withSlot(bundle, async (state) => {
		await expect.element(page.getByText('tab workbench')).toBeInTheDocument();
		state.props = { ...props, tab: 'versions' };
		await tick();
		await expect.element(page.getByText('tab versions')).toBeInTheDocument();
	});
	await expect.poll(() => document.body.dataset.studioUnmounted).toBe('yes');
});

it('says so when the host serves no bundle, or one that cannot be used', async () => {
	await withSlot(undefined, async () => {
		await expect.element(page.getByText('Workspace Studio could not be loaded.')).toBeVisible();
	});
	await withSlot(moduleUrl('export const nothing = 1;'), async () => {
		await expect.element(page.getByText('Workspace Studio could not be loaded.')).toBeVisible();
	});
	const gone = moduleUrl('');
	URL.revokeObjectURL(gone);
	await withSlot(gone, async () => {
		await expect.element(page.getByText('Workspace Studio could not be loaded.')).toBeVisible();
	});
});
