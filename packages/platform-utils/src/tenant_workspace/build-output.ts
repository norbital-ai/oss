/**
 * The bundle contract.
 *
 * A checkpoint used to be namespaced `vite-2-<64-hex build contract>`, hashed from a curated
 * package union and two image digests. Everything that identified now lives in the tenant's own
 * committed `pnpm-lock.yaml`, so there is no build contract to parse here — Core keys a bundle by
 * tree hash plus its own pipeline generation. What remains is the shape of the bundle itself,
 * which is the only cross-version contract between a Core replica and a tenant runtime.
 */

/** Bundle-root file holding the precomputed NorbitalManifest projection. */
export const CHECKPOINT_MANIFEST_FILENAME = 'manifest.json';

/**
 * Bundle-root entry point the tenant container executes. `.mjs` so it needs no `package.json`
 * of its own at the bundle root.
 */
export const SERVE_ENTRY_FILENAME = 'serve.mjs';

/**
 * V8 startup-snapshot blob of the server bundle, produced at build time in the build sandbox.
 *
 * The runtime guest boots with `node --snapshot-blob=<this file>` instead of importing `serve.mjs`:
 * the snapshot carries the whole server bundle already parsed and compiled, so a cold guest pays
 * the deserialize cost instead of a 3.3 MB module-graph parse. The blob is node-version-specific,
 * which is safe here because the build and runtime templates run the same node image.
 *
 * A checkpoint without this file is still valid: the guest falls back to `serve.mjs`, which is the
 * same behaviour every checkpoint had before snapshots existed.
 */
export const RUNTIME_SNAPSHOT_FILENAME = 'runtime.snap';

export const CHECKPOINT_BUILD_REQUIRED_PATHS = [
	CHECKPOINT_MANIFEST_FILENAME,
	'dist/index.html',
	SERVE_ENTRY_FILENAME,
	'output/server/index.js',
	'schema-functions.sql',
	'schema-post-ddl.sql'
] as const;

/** Content-Type for a checkpoint static asset based on its file extension. */
export function staticAssetContentType(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
	switch (extension) {
		case '.css':
			return 'text/css; charset=utf-8';
		case '.gif':
			return 'image/gif';
		// Core serves the SPA shell itself, so an unmapped `.html` would make a browser download
		// the workspace instead of rendering it.
		case '.html':
			return 'text/html; charset=utf-8';
		case '.ico':
			return 'image/x-icon';
		case '.jpeg':
		case '.jpg':
			return 'image/jpeg';
		case '.js':
			return 'text/javascript; charset=utf-8';
		case '.json':
		case '.map':
			return 'application/json';
		case '.png':
			return 'image/png';
		case '.svg':
			return 'image/svg+xml';
		case '.txt':
			return 'text/plain';
		case '.wasm':
			return 'application/wasm';
		case '.webp':
			return 'image/webp';
		case '.woff':
			return 'font/woff';
		case '.woff2':
			return 'font/woff2';
		default:
			return 'application/octet-stream';
	}
}
