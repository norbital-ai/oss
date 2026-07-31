import { afterEach } from 'vitest';

/**
 * happy-dom implements the DOM, not a rendering engine.
 *
 * `ResizeObserver` is the one omission these surfaces actually hit: the sidebar and the popover are
 * built on floating-ui, which observes its anchor. A no-op is the honest stand-in — there is no
 * layout to observe here, so an observer that never fires reports exactly as much as this
 * environment knows.
 */
if (!('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
}

/**
 * Node 26 declares a global `localStorage` that is undefined unless the process was started with
 * `--localstorage-file`, and that declaration wins over the one happy-dom installs. `mode-watcher`
 * reads it at import time, so a sidebar that only wanted a theme preference takes the whole module
 * graph down with it. An in-memory store is what a fresh browser profile has anyway.
 */
function memoryStorage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: (key: string) => entries.get(key) ?? null,
		key: (index: number) => [...entries.keys()][index] ?? null,
		removeItem: (key: string) => void entries.delete(key),
		setItem: (key: string, value: string) => void entries.set(key, String(value))
	};
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
	let present = false;
	try {
		present = Boolean(globalThis[name]);
	} catch {
		present = false;
	}
	if (!present) {
		Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true });
	}
}

afterEach(() => {
	document.body.replaceChildren();
});
