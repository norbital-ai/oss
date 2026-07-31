import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
	restrictAfterHookApi,
	restrictBeforeHookApi
} from '$lib/server/collection/hook-api.server.js';

/**
 * What a tenant-authored hook can reach.
 *
 * `sharedBuiltinApi` is the full server-side capability set, and it grows — it already carries file
 * storage reads, and `createElevatedAfterApi` layers a permission-BYPASSING `mutate` on top of it.
 * The only thing standing between that surface and code written inside a tenant workspace is
 * `restrictBeforeHookApi` / `restrictAfterHookApi`, which rebuild a new object from named fields.
 *
 * That shape is the security property, so it is asserted as a shape. A test that merely checked
 * "db is present" would pass just as happily on the day someone returns `{ ...api }` for
 * convenience and hands every future builtin to tenant code along with it.
 */

const hookApiSource = fileURLToPath(
	new URL('../../src/lib/server/collection/hook-api.server.ts', import.meta.url)
);

/** A stand-in carrying one legitimate field plus capabilities that must not survive narrowing. */
function capabilityRichApi() {
	return {
		db: { marker: 'db' },
		readFileAsset: () => 'asset',
		// Everything below exists on the real builtin API or its elevated variant.
		fetch: () => 'network',
		requireRuntimeFacility: () => 'facility',
		mutate: () => 'permission-bypassing write',
		secrets: { token: 'must-not-leak' }
	};
}

describe('hook API boundary', () => {
	it('narrows the before-hook API to exactly db and readFileAsset', () => {
		const restricted = restrictBeforeHookApi(
			capabilityRichApi() as unknown as Parameters<typeof restrictBeforeHookApi>[0]
		);
		expect(Object.keys(restricted).sort()).toEqual(['db', 'readFileAsset']);
	});

	it('narrows the after-hook API to exactly db and readFileAsset', () => {
		const restricted = restrictAfterHookApi(
			capabilityRichApi() as unknown as Parameters<typeof restrictAfterHookApi>[0]
		);
		expect(Object.keys(restricted).sort()).toEqual(['db', 'readFileAsset']);
	});

	it('carries the real db through rather than a copy, so behaviours are not silently dropped', () => {
		const api = capabilityRichApi();
		const restricted = restrictBeforeHookApi(
			api as unknown as Parameters<typeof restrictBeforeHookApi>[0]
		);
		// Identity, not deep-equality: the db surface is built with collection behaviours attached,
		// and a structural copy would strip the function members that make `api.db.x.update` exist.
		expect(restricted.db).toBe(api.db);
	});

	it('builds the restricted API by naming fields, never by spreading the source', async () => {
		const source = await readFile(hookApiSource, 'utf8');
		for (const fn of ['restrictBeforeHookApi', 'restrictAfterHookApi']) {
			const [body = ''] = new RegExp(`export function ${fn}\\([\\s\\S]*?\\n}`).exec(source) ?? [];
			expect(body, `${fn} should be present`).not.toBe('');
			// `return { ...api }` would satisfy every assertion above while re-widening the surface
			// the moment a new builtin is added. The allowlist has to stay written out.
			expect(body, `${fn} must not spread the source API`).not.toMatch(/\.\.\.\s*api\b/);
		}
	});
});
