import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ARTIFACT_ASSET_DIRECTORY,
	ARTIFACT_ASSET_INDEX_FILE,
	ARTIFACT_BUNDLE_FILE,
	ARTIFACT_DIRECTORY,
	BOLT_TENANT_PUBLIC_PREFIX,
	BOLT_TENANT_REQUEST_PREFIX,
	BOLT_TENANT_STATIC_PREFIX,
	SERVER_ASSET_DECLARATION_FILE_NAME,
	WORKSPACE_ENTRY_FILE_NAME
} from '../../src/compiler/client-entry.js';

const compilerSource = readFileSync(new URL('../../src/compiler/sync.ts', import.meta.url), 'utf8');
const compilerRoot = new URL('../../src/compiler/', import.meta.url);

describe('public Bolt tenant asset paths', () => {
	it('keeps browser assets under the explicit Bolt namespace on every origin', () => {
		expect(BOLT_TENANT_PUBLIC_PREFIX).toBe('/__bolt');
		expect(BOLT_TENANT_STATIC_PREFIX).toBe('/__bolt/static');
		expect(BOLT_TENANT_REQUEST_PREFIX).toBe('/__bolt/request');
		expect(`${BOLT_TENANT_STATIC_PREFIX}/${WORKSPACE_ENTRY_FILE_NAME}`).toBe(
			'/__bolt/static/workspace.js'
		);
		expect(compilerSource).toContain("build({ root, base: './', mode: 'production'");
	});

	it('embeds authored media at the Bolt tenant request surface with no legacy alias', () => {
		expect(compilerSource).toContain(
			'`${BOLT_TENANT_REQUEST_PREFIX}/api/template-seed-assets/${workspaceKey}/'
		);
		expect(compilerSource).not.toContain('`/api/template-seed-assets/${workspaceKey}/');
	});
});

describe('artifact sidecar layout', () => {
	it('names the one place a blob and its index are written', () => {
		expect(ARTIFACT_DIRECTORY).toBe('.norbital/artifact');
		expect(ARTIFACT_BUNDLE_FILE).toBe('bundle.mjs');
		expect(ARTIFACT_ASSET_DIRECTORY).toBe('assets');
		expect(ARTIFACT_ASSET_INDEX_FILE).toBe('asset-index.json');
		expect(SERVER_ASSET_DECLARATION_FILE_NAME).toBe('.bolt-server-assets.json');
	});

	/**
	 * The base64 path is gone from the compiler, not merely unused by it.
	 *
	 * A workspace that ships PGlite compiled to a 33 MB `bundle.mjs` whose two largest lines were
	 * 13.4 MB and 8.4 MB of encoded WebAssembly. The isolate parsed all of it before answering
	 * anything. Reintroducing an encoder anywhere in `src` puts those lines back, and the symptom —
	 * a slow cold start — points nowhere near the line that caused it, so the ban is asserted on the
	 * source text rather than on a measurement nobody runs.
	 */
	it('leaves no encoder anywhere in the compiler', () => {
		const files = readdirSync(compilerRoot, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
		for (const source of files) {
			expect(source).not.toContain('encodedAssets');
			expect(source).not.toContain('Uint8Array.from(atob(');
			expect(source).not.toContain("toString('base64')");
		}
	});

	it('writes bytes to a digest-named blob instead of into the module graph', () => {
		expect(compilerSource).toContain('join(blobDirectory, sha256)');
		expect(compilerSource).toContain('const browserAssets = ${JSON.stringify(assetIndex.browser)}');
		expect(compilerSource).toContain('const serverAssets = ${JSON.stringify(assetIndex.server)}');
	});
});
