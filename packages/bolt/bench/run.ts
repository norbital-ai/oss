// `pnpm --dir packages/bolt bench:resources`: the resource benchmark (`resources.ts`) over this checkout's source. As the
// suite's Vitest alias does, `@norbital-ai/bolt` and its subpaths resolve to `src/`, so the test kit and the engine are
// one copy of the source; sibling packages load from their builds.
import { registerHooks } from 'node:module';

const PACKAGE = '@norbital-ai/bolt';
const SOURCE: Readonly<Record<string, string>> = {
	'': 'index',
	'/artifact': 'engine/artifact/index',
	'/engine': 'engine/index',
	'/errors': 'decl/errors',
	'/host-api': 'host-api',
	'/protocol': 'protocol/index',
	'/tooling': 'tooling/index'
};
registerHooks({
	resolve: (specifier, context, next) => {
		const file = specifier.startsWith(PACKAGE) ? SOURCE[specifier.slice(PACKAGE.length)] : undefined;
		return next(file === undefined ? specifier : new URL(`../src/${file}.ts`, import.meta.url).href, context);
	}
});
const { main } = await import('./resources.ts');
main(process.argv.slice(2));
