import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string): string =>
	readFileSync(new URL(`../../src/client/${path}`, import.meta.url), 'utf8');

describe('workspace initial load', () => {
	it('opens the code step before delivery settles and keeps verification truthful', () => {
		const signIn = source('ui/identity/sign-in.svelte');
		const showCode = signIn.indexOf("step = 'code'");
		const send = signIn.indexOf('transport.sendCode(recipient)');

		expect(showCode).toBeGreaterThan(-1);
		expect(send).toBeGreaterThan(showCode);
		expect(signIn).toContain("if (delivery !== 'sent' || verifying || code.length !== 6)");
		expect(signIn).toContain("disabled={delivery !== 'sent' || verifying || code.length !== 6}");
		expect(signIn).toContain("{#if delivery === 'sent'}");
		expect(signIn).toContain("{#if delivery === 'failed'}");
		expect(signIn).toContain('onclick={() => void Effect.runPromise(send())}');
	});

	it('keeps the proven administrator app set visible while runtime revalidation starts', () => {
		const workspace = source('ui/shell/workspace.svelte');

		expect(workspace).toContain("view.user.admin && replicaAccessScope === 'operator'");
		expect(workspace).toContain('visibleAppsQuery.current?.apps ?? administratorInitialApps');
		// A team preview must wait for its own narrowed runtime answer and may never borrow this set.
		expect(workspace).toContain("!replicaAccessScope.startsWith('team:')");
	});

	it('loads only the exact presentation module a rendered surface requests', () => {
		const workspace = source('ui/shell/workspace.svelte');

		expect(workspace).not.toContain('Object.entries(workspace.representationLoaders)');
		expect(workspace).not.toContain('Object.entries(workspace.customTypeRendererLoaders)');
		expect(workspace).toContain('workspace.representationLoaders[property]');
		expect(workspace).toContain('workspace.customTypeRendererLoaders[property]');
		expect(workspace).toContain('requestedCollectionSurfaces.add(property)');
		expect(workspace).toContain('requestedCustomTypeRenderers.add(property)');
	});

	it('keeps PGlite out of the initial and selected-app dependency race', () => {
		const workspace = source('ui/shell/workspace.svelte');
		const interaction = workspace.indexOf("window.addEventListener('pointerdown', requestReplica");
		const replica = workspace.indexOf('workspace.startLocalReplica(accessScope)');

		expect(interaction).toBeGreaterThan(-1);
		expect(replica).toBeGreaterThan(interaction);
		expect(workspace).toContain('replicaRequestedScope !== accessScope');
		expect(workspace).toContain('appMount.loading');
	});

	it('keeps PGlite out of the generated client static dependency graph', () => {
		const runtime = source('runtime.ts');
		const loader = source('replica/pglite-loader.ts');

		expect(runtime).not.toMatch(/^import .*pglite-loader/m);
		expect(runtime).toContain("import('#lib/client/replica/pglite-loader.js')");
		expect(loader).not.toMatch(/^import .*PGliteWorker.*@electric-sql\/pglite\/worker/m);
		expect(loader).toContain("import('@electric-sql/pglite/worker')");
	});
});
