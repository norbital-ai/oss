/**
 * Let `node --experimental-strip-types` follow the source graph.
 *
 * Package modules import neighbours as `./thing.js`. Type stripping does not rewrite those
 * specifiers, so tests that load `src/*.ts` resolve the `.ts` sibling when the `.js` is absent.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const exists = (url) => {
	if (url.protocol !== 'file:') return false;
	return existsSync(fileURLToPath(url));
};

const sourceSibling = (specifier, parentURL) => {
	if (parentURL == null || !specifier.endsWith('.js')) return null;
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
	if (exists(new URL(specifier, parentURL))) return null;
	const candidate = `${specifier.slice(0, -3)}.ts`;
	return exists(new URL(candidate, parentURL)) ? candidate : null;
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(sourceSibling(specifier, context.parentURL) ?? specifier, context);
	}
});
