// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { afterEach, expect, it, vi } from '@effect/vitest';
import { initializeShellAssets, INITIAL_MODULES_ID } from '../src/shell/mount.ts';

afterEach(() => {
	document.getElementById(INITIAL_MODULES_ID)?.remove();
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
		if (link.href === 'http://localhost/release/assets/readiness.css') link.remove();
});

const initial = () => {
	const inventory = document.createElement('script');
	inventory.id = INITIAL_MODULES_ID;
	inventory.type = 'application/json';
	inventory.textContent = JSON.stringify({ modules: [], css: ['assets/readiness.css'] });
	document.head.append(inventory);
};
const requested = () =>
	[...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(
		(link) => link.href === 'http://localhost/release/assets/readiness.css'
	);

it('keeps target asset readiness pending until the declared stylesheet loads', async () => {
	initial();
	let settled = false;
	const ready = initializeShellAssets('http://localhost/release/assets/shell.js').then(() => {
		settled = true;
	});
	await vi.waitFor(() => expect(requested()).not.toBeUndefined());
	const link = requested();
	if (link === undefined) throw new Error('Declared workspace stylesheet was not requested.');
	expect(settled).toBe(false);
	link.dispatchEvent(new Event('load'));
	await ready;
	expect(settled).toBe(true);
});

it('rejects target asset readiness on a stylesheet failure instead of exposing a partial workspace', async () => {
	initial();
	const ready = initializeShellAssets('http://localhost/release/assets/shell.js');
	const refused = expect(ready).rejects.toThrow('Workspace stylesheet failed to load');
	await vi.waitFor(() => expect(requested()).not.toBeUndefined());
	const link = requested();
	if (link === undefined) throw new Error('Declared workspace stylesheet was not requested.');
	link.dispatchEvent(new Event('error'));
	await refused;
});
