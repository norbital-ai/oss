/**
 * happy-dom test doubles for workspace shell mounts.
 *
 * Node 26 may expose a broken global `localStorage`; mode-watcher reads it at import time.
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

if (!('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
}

if (!document.fonts) {
	Object.defineProperty(document, 'fonts', {
		value: { ready: Promise.resolve() },
		configurable: true
	});
}
