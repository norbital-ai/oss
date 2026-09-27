// A DOM for `node --test`: happy-dom (bolt's dev dependency; ui declares none) as globals, the `browser` condition so
// `svelte` resolves to its client runtime, and `.svelte` / `.svelte.ts` compiled on load. Import it first.
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile, compileModule } from 'svelte/compiler';

const { Window } = createRequire(new URL('../../bolt/package.json', import.meta.url))('happy-dom');
const window = new Window({ url: 'http://localhost/' });
for (const key of Object.getOwnPropertyNames(window)) {
	if (key in globalThis || key.startsWith('_')) continue;
	try {
		Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
	} catch {
		// a getter happy-dom refuses outside its window: not needed here
	}
}
for (const key of ['window', 'document', 'navigator', 'location', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'EventTarget', 'localStorage', 'sessionStorage']) // node 26 has its own (file-less, undefined) storage
	Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });

registerHooks({
	resolve(specifier, context, next) {
		const ctx = { ...context, conditions: [...context.conditions, 'browser', 'svelte'] };
		try {
			return next(specifier, ctx);
		} catch (error) {
			if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(`${specifier.slice(0, -3)}.ts`, ctx);
			throw error;
		}
	},
	load(url, context, next) {
		if (!url.startsWith('file:')) return next(url, context);
		const path = fileURLToPath(url);
		if (path.endsWith('.svelte')) {
			const { js } = compile(readFileSync(path, 'utf8'), { filename: path, generate: 'client', dev: false });
			return { format: 'module', source: js.code, shortCircuit: true };
		}
		if (/\.svelte\.(ts|js)$/.test(path)) {
			const text = readFileSync(path, 'utf8');
			const { js } = compileModule(path.endsWith('.ts') ? stripTypeScriptTypes(text) : text, { filename: path, generate: 'client' });
			return { format: 'module', source: js.code, shortCircuit: true };
		}
		return next(url, context);
	}
});
