/**
 * Let `node --experimental-strip-types` follow the source graph.
 *
 * Every module in `src/` imports its neighbours as `./thing.js`, which is what the emitted build
 * resolves to and what TypeScript requires under NodeNext. Node's type stripping compiles a `.ts`
 * file in place but does not rewrite those specifiers, so a test that imports any module with
 * relative runtime imports fails to resolve before a single assertion runs.
 *
 * This hook rewrites a relative `.js` specifier to its `.ts` sibling only when the `.js` file does
 * not exist and the `.ts` one does — so a real emitted file, a dependency and a package specifier
 * are all left exactly as they were.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const exists = (url) => {
	try {
		return existsSync(fileURLToPath(url));
	} catch {
		return false;
	}
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			context.parentURL != null &&
			specifier.endsWith('.js') &&
			(specifier.startsWith('./') || specifier.startsWith('../'))
		) {
			const emitted = new URL(specifier, context.parentURL);
			const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			if (!exists(emitted) && exists(source))
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	}
});
