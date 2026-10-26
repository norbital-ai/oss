// `bolt test`'s setup file. In a DOM test environment, Node's own `localStorage` and `sessionStorage` globals (undefined
// without `--localstorage-file`) shadow the environment's; the shell and its libraries read them on import, so an
// unbacked one becomes an in-memory store.
import { addCollection } from '@iconify/svelte/dist/functions';
import { icons as lucide } from '@iconify-json/lucide/index.js';
import { Result } from 'effect';

// A suite may import a model module for its declared fields and bodies; those bodies never run in the test process, so
// the same allowance the seed bundler's banner gives a build-time reader applies here.
const SEED_BUILD = Symbol.for('norbital.bolt.seedBuild');
(globalThis as { [SEED_BUILD]?: boolean })[SEED_BUILD] = true;

// UI icons use the library's local cache; DOM tests must not leave public-API fetches running at teardown.
if (typeof document !== 'undefined') addCollection(lucide);

const memory = (): Storage => {
	const m = new Map<string, string>();
	return {
		get length() {
			return m.size;
		},
		key: (i) => [...m.keys()][i] ?? null,
		getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		clear: () => m.clear()
	};
};
if (typeof document !== 'undefined')
	for (const k of ['localStorage', 'sessionStorage'] as const) {
		const own = Result.try(() => globalThis[k]);
		if (Result.isFailure(own) || own.success === undefined)
			Object.defineProperty(globalThis, k, { value: memory(), configurable: true, writable: true });
	}
export {};
