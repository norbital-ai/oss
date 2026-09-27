// Node runs `src` modules as written: their relative imports name `.js` (what svelte-package emits) while the
// source is `.ts`. This hook resolves the one to the other for tests only; import it before the module under test.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(`${specifier.slice(0, -3)}.ts`, context);
			throw error;
		}
	}
});
