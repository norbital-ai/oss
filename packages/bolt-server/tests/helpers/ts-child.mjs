// `node --import ./tests/helpers/ts-child.mjs entry.mjs` runs this package's TypeScript sources in
// a child process: Node strips the types itself; this hook only points a `./x.js` import at the
// `./x.ts` beside it when no `.js` exists. Sibling workspace packages resolve to their builds.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
	resolve: (specifier, context, next) => {
		if (
			(specifier.startsWith('./') || specifier.startsWith('../')) &&
			specifier.endsWith('.js') &&
			context.parentURL?.startsWith('file:') === true
		) {
			const typescript = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			const path = fileURLToPath(typescript);
			if (!path.includes('/node_modules/') && existsSync(path))
				return { url: typescript.href, shortCircuit: true, format: 'module-typescript' };
		}
		return next(specifier, context);
	}
});
