// `bolt test`'s setup file. In a DOM test environment, Node's own `localStorage` and `sessionStorage` globals (undefined
// without `--localstorage-file`) shadow the environment's; the shell and its libraries read them on import, so an
// unbacked one becomes an in-memory store.
const memory = (): Storage => {
	const m = new Map<string, string>();
	return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear() };
};
if (typeof document !== 'undefined')
	for (const k of ['localStorage', 'sessionStorage'] as const) {
		let own: Storage | undefined;
		try { own = globalThis[k]; } catch { /* an unbacked accessor */ }
		if (own === undefined) Object.defineProperty(globalThis, k, { value: memory(), configurable: true, writable: true });
	}
export {};
