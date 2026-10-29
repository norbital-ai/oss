/// <reference types="node" />
// Bolt's own tree, which every build bundles from (the shell, the page SDK, the declaration edge): the published build
// this package resolves, or, when this compiler runs from source in the oss checkout, Bolt's source beside it. A path
// join, not `new URL(…, import.meta.url)`: a DOM test environment's transform rewrites that to an asset.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Source (`.ts`) in the checkout, emitted `.js` in the published package: Bolt's modules carry the same. */
export const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
/** Bolt's `src/` or `build/`: the directory its module paths (`shell/mount`, `decl/body`, …) are under. */
export const BOLT =
	EXT === '.ts'
		? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bolt', 'src')
		: dirname(createRequire(import.meta.url).resolve('@norbital-ai/bolt'));
/** Bolt's package directory (its `package.json`, the platform layer's root). */
export const BOLT_PACKAGE = join(BOLT, '..');
