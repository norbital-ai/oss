import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RUNTIME_SNAPSHOT_FILENAME } from '@norbital-ai/platform-utils/tenant_workspace/build-output';

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
		expect(buildOutput).toContain(`export const RUNTIME_SNAPSHOT_FILENAME = '${RUNTIME_SNAPSHOT_FILENAME}'`);
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
});
