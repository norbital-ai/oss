import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHostConfig, resolveDatabaseUrl, type HostConfigInput } from '../../src/host/config.js';
import { isIdentityDescriptor } from '../../src/host/types.js';

const temporaryRoots: string[] = [];

async function rootWith(config?: string): Promise<string> {
	const parent = path.resolve(import.meta.dirname, '../../../../.test-workspaces');
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, 'host-config-'));
	temporaryRoots.push(root);
	if (config) await writeFile(path.join(root, 'pod.host.mjs'), config);
	return root;
}

function input(root: string, development: boolean): HostConfigInput {
	return {
		root,
		development,
		databaseUrl: 'postgres://core-development',
		orgId: '11111111-1111-4111-8111-111111111111',
		orgName: 'Test Organization',
		adminId: '22222222-2222-4222-8222-222222222222',
		publicUrl: 'http://127.0.0.1:5173'
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('pod.host.ts deployment target', () => {
	it('emulates a Core host only for local development', async () => {
		const root = await rootWith(`export default { mode: 'core' };`);
		const resolved = await loadHostConfig(input(root, true));

		expect(resolved.source).toContain('Core development emulation');
		expect(resolved.config.mode).toBe('self-hosted');
		// A resolved development host always yields a live provider, never a descriptor — the narrowing
		// is the assertion, since a descriptor here would mean nothing bound the built-in provider.
		expect(isIdentityDescriptor(resolved.config.identity)).toBe(false);
		if (isIdentityDescriptor(resolved.config.identity)) throw new Error('expected a provider');
		expect(resolved.config.identity.name).toBe('dev');
		expect(resolved.config.db.connectionString).toBe('postgres://core-development');
		await expect(loadHostConfig(input(root, false))).rejects.toThrow(
			/targets Core and cannot run with `pod start`/
		);
	});

	it('uses a complete self-hosted config without merging implicit providers', async () => {
		const root = await rootWith(`
export default {
	mode: 'self-hosted',
	publicUrl: 'https://crm.acme.com',
	db: { connectionString: 'postgres://self-hosted', connect() { return {}; } },
	identity: { name: 'custom', authenticate() { return null; } }
};`);
		const resolved = await loadHostConfig(input(root, false));

		expect(resolved.config.mode).toBe('self-hosted');
		expect(resolved.config.publicUrl).toBe('https://crm.acme.com');
		expect(resolved.config.fileStorage).toBeUndefined();
		expect(await resolveDatabaseUrl(root, 'postgres://fallback')).toBe('postgres://self-hosted');
	});

	it('accepts a named identity descriptor as well as a constructed provider', async () => {
		// `emailOtp({ ... })` is data, so the shape check must not insist on an `authenticate` method.
		const root = await rootWith(`
export default {
	mode: 'self-hosted',
	publicUrl: 'https://crm.acme.com',
	db: { connectionString: 'postgres://self-hosted', connect() { return {}; } },
	identity: { provider: 'email-otp', secret: '${'a'.repeat(32)}' }
};`);
		const resolved = await loadHostConfig(input(root, false));
		expect(resolved.config.identity).toMatchObject({ provider: 'email-otp' });
	});

	it('refuses a self-hosted config with no publicUrl, naming what is missing', async () => {
		// Without it an invitation link cannot be absolute, and the token travels by email — so there is
		// no request to derive an origin from later. Failing at startup beats failing at the first invite.
		const root = await rootWith(`
export default {
	mode: 'self-hosted',
	db: { connectionString: 'postgres://self-hosted', connect() { return {}; } },
	identity: { name: 'custom', authenticate() { return null; } }
};`);
		await expect(loadHostConfig(input(root, false))).rejects.toThrow(/publicUrl/);
	});

	it('requires an explicit target and lets Core commands use the environment database', async () => {
		const coreRoot = await rootWith(`export default { mode: 'core' };`);
		expect(await resolveDatabaseUrl(coreRoot, 'postgres://core')).toBe('postgres://core');

		const missingRoot = await rootWith();
		await expect(loadHostConfig(input(missingRoot, true))).rejects.toThrow(/Missing pod.host.ts/);
		await expect(resolveDatabaseUrl(missingRoot, 'postgres://fallback')).rejects.toThrow(
			/Missing pod.host.ts/
		);
	});
});
