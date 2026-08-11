import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RUNTIME_SNAPSHOT_FILENAME } from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import {
	generateRuntimeSnapshot,
	makeSnapshotBundleVmCompatible
} from '../../src/vite/snapshot.ts';

function source(relativePath: string): string {
	return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

/**
 * The V8 startup snapshot is a boot-time optimisation with a hard serialisation constraint: a
 * snapshot can only capture a heap whose live objects are serialisable, and `node:http`'s native
 * HTTPParser handle is not. These source-shape assertions pin the two properties that keep the
 * snapshot buildable — the serve source never touches `node:http` at module scope, and the
 * snapshot builder produces the exact boot entry the runtime expects.
 */
describe('the runtime startup snapshot stays buildable', () => {
	it('loads node:http lazily, never at module scope', () => {
		const server = source('serve/server.ts');
		// The one runtime import is the lazy one inside `createPodHttpServer`.
		expect(server).toMatch(/await import\('node:http'\)/);
		// Module-scope imports from node:http must be type-only (erased at compile time).
		const moduleScopeImport = server.match(/^import \{([^}]*)\} from 'node:http';/m);
		if (moduleScopeImport) {
			const specifiers = moduleScopeImport[1].split(',').map((s) => s.trim());
			expect(specifiers.every((s) => s.startsWith('type '))).toBe(true);
		}
	});

	it('names the snapshot file on the bundle contract', () => {
		const buildOutput = source('../../platform-utils/src/tenant_workspace/build-output.ts');
		expect(buildOutput).toContain(
			`export const RUNTIME_SNAPSHOT_FILENAME = '${RUNTIME_SNAPSHOT_FILENAME}'`
		);
	});

	it('snapshot builder guards stdout then starts the server on deserialise', () => {
		const snapshot = source('vite/snapshot.ts');
		// The deserialize main must install the frame guard BEFORE the server starts, exactly as
		// serve.mjs does, or the first stdout write would corrupt the RPC stream. Order in the
		// source template is the guarantee: the guard string precedes the deserialize registration.
		const guardIndex = snapshot.indexOf('STDIO_FRAME_GUARD_SOURCE');
		const mainIndex = snapshot.indexOf('setDeserializeMainFunction');
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		expect(mainIndex).toBeGreaterThan(guardIndex);
	});

	it('keeps node:http external in the re-bundled single file', () => {
		const snapshot = source('vite/snapshot.ts');
		expect(snapshot).toMatch(/id !== 'node:http'/);
	});

	it('rewrites the lazy built-in import for Node startup-snapshot VM restore', () => {
		const bundled = `async function boot() { return await import('node:http'); }`;
		const compatible = makeSnapshotBundleVmCompatible(bundled);
		expect(compatible).not.toContain("import('node:http')");
		expect(compatible).toContain("require('node:http')");
	});

	it('boots a generated snapshot without a dynamic-import callback', async () => {
		const artifactRoot = await mkdtemp(path.join(tmpdir(), 'norbital-snapshot-contract-'));
		try {
			const serverDir = path.join(artifactRoot, 'output', 'server');
			await mkdir(serverDir, { recursive: true });
			await writeFile(
				path.join(serverDir, 'index.js'),
				`export async function startPodHttpServer() {
	const { createServer } = await import('node:http');
	if (typeof createServer !== 'function') throw new Error('node:http did not load');
}
`
			);
			expect(await generateRuntimeSnapshot({ artifactRoot, log: () => {} })).toBe(true);
			execFileSync(
				process.execPath,
				[`--snapshot-blob=${path.join(artifactRoot, RUNTIME_SNAPSHOT_FILENAME)}`],
				{ stdio: 'pipe', timeout: 10_000 }
			);
		} finally {
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});
});
