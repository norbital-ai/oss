/// <reference types="@vitest/browser-playwright" />
import { expect, it, vi } from '@effect/vitest';
import { page } from 'vitest/browser';
import { Effect } from 'effect';
import { mount, tick, unmount } from 'svelte';
import ChangePane from '../src/shell/studio/ChangePane.svelte';
import type { StudioChangeSet, StudioView } from '../src/shell/studio/model.ts';
import './support/shell.css';

const t = (key: string) => key;
const preview = (stale: boolean) => ({
	url: 'about:blank',
	commit: 'head2222',
	artifact: 'artifact',
	stale
});
const view: StudioView = {
	commit: 'head2222',
	files: {},
	changes: [],
	sections: null,
	log: [],
	preview: null,
	releases: [],
	change: '1',
	changeSets: []
};
const change = (stale: boolean): StudioChangeSet => ({
	id: '1',
	title: 'Edit src/+workspace.ts',
	state: 'open',
	openedBy: 'dion.neo@norbital.ai',
	contributors: [],
	branch: 'change/1',
	base: 'base1111',
	head: 'head2222',
	behind: 0,
	preview: preview(stale),
	log: [],
	createdAt: '2026-11-01T00:00:00Z',
	updatedAt: '2026-11-01T00:00:00Z'
});

async function mountPane(c: StudioChangeSet) {
	const target = document.body.appendChild(document.createElement('div'));
	target.style.height = '700px';
	const onpreview = vi.fn();
	const instance = mount(ChangePane, {
		target,
		props: {
			view,
			change: c,
			busy: false,
			onopen: () => {},
			onpreview,
			onrelease: () => {},
			run: () => Effect.succeed(true),
			t
		}
	});
	await tick();
	return { target, onpreview, instance };
}

it('Preview opens the change’s preview and builds a stale one', async () => {
	const { target, onpreview, instance } = await mountPane(change(true));
	try {
		expect(document.querySelector('[data-tabs-variant="underline"]')).not.toBeNull();
		await page.getByRole('tab', { name: 'Preview', exact: true }).click();
		expect(onpreview).toHaveBeenCalledTimes(1);
		await expect.element(page.getByText('Preview is out of date.', { exact: true })).toBeVisible();
	} finally {
		await unmount(instance);
		target.remove();
	}
});

it('Preview shows the build that already serves the head without building it again', async () => {
	const { target, onpreview, instance } = await mountPane(change(false));
	try {
		await page.getByRole('tab', { name: 'Preview', exact: true }).click();
		expect(onpreview).not.toHaveBeenCalled();
		await expect.element(page.getByRole('tab', { name: 'Tests', exact: true })).toBeVisible();
	} finally {
		await unmount(instance);
		target.remove();
	}
});
