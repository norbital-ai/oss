/**
 * Let `node` run the engine sources directly.
 *
 * Node strips TypeScript types on its own, but the source uses `.js` specifiers
 * — the convention the Pod toolchain and `tsc` expect — and Node will not map
 * those onto the `.ts` file that actually exists. This hook does only that, and
 * only when the `.ts` file is there.
 *
 * Registered by `pnpm verify`; nothing at runtime depends on it.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { registerHooks } from 'node:module';

function resolve(specifier, context, next) {
	if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
		const candidate = resolvePath(
			dirname(fileURLToPath(context.parentURL)),
			`${specifier.slice(0, -3)}.ts`
		);
		if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
	}
	return next(specifier, context);
}

registerHooks({ resolve });
