// @vitest-environment happy-dom
import { mount, tick, unmount } from 'svelte';
import Icon from '@iconify/svelte';
import { _api, getIcon } from '@iconify/svelte/dist/functions';
import { expect, it, vi } from '@effect/vitest';
import './setup-happy-dom.ts';

it.each([
	'lucide:circle-check',
	'vscode-icons:default-file',
	'vscode-icons:default-folder',
	'vscode-icons:default-folder-opened',
	'vscode-icons:file-type-npm',
	'vscode-icons:file-type-tsconfig',
	'vscode-icons:file-type-svelte',
	'vscode-icons:file-type-typescript',
	'vscode-icons:file-type-js',
	'vscode-icons:file-type-json',
	'vscode-icons:file-type-markdown',
	'vscode-icons:file-type-css',
	'vscode-icons:file-type-sql',
	'vscode-icons:file-type-yaml',
	'vscode-icons:file-type-svg'
])('renders %s from local data without starting an API request', async (icon) => {
	const original = _api.getFetch();
	if (original === undefined) throw new Error('DOM fetch is unavailable');
	const fetch = vi.fn(async () => {
		throw new Error('unexpected icon API request');
	});
	_api.setFetch(fetch);
	const target = document.createElement('div');
	document.body.append(target);
	let view: ReturnType<typeof mount> | undefined;
	try {
		expect(getIcon(icon)?.body).toContain('<');
		view = mount(Icon, { target, props: { icon } });
		await tick();
		expect(target.querySelector('svg')).not.toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		if (view !== undefined) await unmount(view);
		target.remove();
		_api.setFetch(original);
	}
});
