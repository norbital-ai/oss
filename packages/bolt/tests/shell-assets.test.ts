// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { afterEach, expect, it, vi } from '@effect/vitest';
import { initializeShellAssets, INITIAL_MODULES_ID } from '../src/shell/mount.ts';

afterEach(() => {
	document.getElementById(INITIAL_MODULES_ID)?.remove();
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
		if (link.href === 'http://localhost/release/assets/readiness.css') link.remove();
});

const initial = (css = ['assets/readiness.css'], nativeModules: string[] = []) => {
	const inventory = document.createElement('script');
	inventory.id = INITIAL_MODULES_ID;
	inventory.type = 'application/json';
	inventory.textContent = JSON.stringify({ css, nativeModules });
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

it('warms the optional module inventory only in the native mobile app', async () => {
	initial([], ['../outside-release.js']);
	const entry = 'http://localhost/release/assets/shell.js';
	await expect(initializeShellAssets(entry)).resolves.toBeUndefined();
	Object.defineProperty(window, 'boltDevice', { configurable: true, value: { platform: 'ios' } });
	try {
		await expect(initializeShellAssets(entry)).rejects.toHaveProperty(
			'cause.message',
			'Initial workspace asset is outside this release.'
		);
	} finally {
		Reflect.deleteProperty(window, 'boltDevice');
	}
});
