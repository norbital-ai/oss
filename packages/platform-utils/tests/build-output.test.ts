import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	CHECKPOINT_BUILD_REQUIRED_PATHS,
	CHECKPOINT_MANIFEST_FILENAME,
	SERVE_ENTRY_FILENAME,
	staticAssetContentType
} from '../src/tenant_workspace/build-output.ts';

describe('the bundle contract', () => {
	it('requires the entry point and manifest a runtime cannot boot without', () => {
		// The bundle is the only cross-version contract between a Core replica and a tenant
		// runtime now that there are no images, so its required shape is asserted, not assumed.
		assert.ok(!CHECKPOINT_BUILD_REQUIRED_PATHS.includes(SERVE_ENTRY_FILENAME));
		assert.ok(CHECKPOINT_BUILD_REQUIRED_PATHS.includes(CHECKPOINT_MANIFEST_FILENAME));
		assert.deepEqual(
			[...CHECKPOINT_BUILD_REQUIRED_PATHS],
			[
				'manifest.json',
				'dist/index.html',
				'output/server/index.js',
				'schema-functions.sql',
				'schema-post-ddl.sql'
			]
		);
	});

	it('carries no build contract identity — the tenant tree already covers dependencies', async () => {
		// A checkpoint used to be namespaced `vite-2-<64-hex>`, hashed from a curated package
		// union and two image digests. All of that is now the tenant's own lockfile.
		const module = await import('../src/tenant_workspace/build-output.ts');
		assert.deepEqual(
			Object.keys(module).filter((name) => /contract|packageKey|BUILD_FORMAT/i.test(name)),
			[]
		);
	});

	it('serves the SPA shell as html rather than a download', () => {
		assert.equal(staticAssetContentType('index.html'), 'text/html; charset=utf-8');
		assert.equal(staticAssetContentType('app-a1b2.js'), 'text/javascript; charset=utf-8');
		assert.equal(staticAssetContentType('style.css'), 'text/css; charset=utf-8');
		assert.equal(staticAssetContentType('font.woff2'), 'font/woff2');
		assert.equal(staticAssetContentType('unknown.bin'), 'application/octet-stream');
	});
});
