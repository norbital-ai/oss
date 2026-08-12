import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NeonTenantDbProvider as NeonProviderType } from '../src/tenant_db/neon-provider.ts';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
			const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	}
});

const { NeonTenantDbProvider } = await import('../src/tenant_db/neon-provider.ts');

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

type TestableProvider = NeonProviderType & {
	awaitBranchUsable(input: unknown): Promise<void>;
};

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 201,
		headers: { 'content-type': 'application/json' }
	});
}

function projectResponse() {
	return {
		project: { id: 'project-1', pg_version: 18 },
		branch: {
			id: 'branch-main',
			name: 'main',
			project_id: 'project-1',
			parent_id: null,
			current_state: 'ready'
		},
		connection_uris: [{ connection_uri: 'postgres://role:password@example.test/neondb' }],
		endpoints: [{ id: 'endpoint-main', host: 'example.test', current_state: 'ready' }]
	};
}

function branchResponse() {
	return {
		branch: {
			id: 'branch-preview',
			name: 'preview',
			project_id: 'project-1',
			parent_id: 'branch-main',
			current_state: 'ready'
		},
		connection_uris: [{ connection_uri: 'postgres://role:password@example.test/neondb' }],
		endpoints: [{ id: 'endpoint-preview', host: 'example.test', current_state: 'ready' }]
	};
}

function providerWithoutConnectionProbe(): NeonProviderType {
	const provider = new NeonTenantDbProvider('test-api-key');
	(provider as TestableProvider).awaitBranchUsable = async () => undefined;
	return provider;
}

describe('NeonTenantDbProvider scale-to-zero policy', () => {
	it('sets the five-minute project default without replacing autoscaling sizing', async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = async (_url, init) => {
			request = init;
			return response(projectResponse());
		};

		await providerWithoutConnectionProbe().createOrgProject('org-1', 'Norbital test');
		const body = JSON.parse(String(request?.body)) as {
			project: Record<string, unknown>;
		};
		assert.deepEqual(body.project.default_endpoint_settings, {
			suspend_timeout_seconds: 300
		});
		assert.equal('autoscaling_limit_min_cu' in body.project, false);
		assert.equal('autoscaling_limit_max_cu' in body.project, false);
		assert.equal(body.project.provisioner, 'k8s-neonvm');
	});

	it('sets the five-minute timeout explicitly on every created branch endpoint', async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = async (_url, init) => {
			request = init;
			return response(branchResponse());
		};

		await providerWithoutConnectionProbe().createBranch('project-1', 'branch-main', {
			name: 'preview'
		});
		const body = JSON.parse(String(request?.body)) as {
			branch: Record<string, unknown>;
			endpoints: Array<Record<string, unknown>>;
		};
		assert.deepEqual(body.endpoints, [{ type: 'read_write', suspend_timeout_seconds: 300 }]);
		assert.equal('autoscaling_limit_min_cu' in body.endpoints[0]!, false);
		assert.equal('autoscaling_limit_max_cu' in body.endpoints[0]!, false);
		assert.deepEqual(body.branch, { parent_id: 'branch-main', name: 'preview' });
	});
});
