import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A workspace with no browser replica has to be able to say so.
 *
 * `startLocalReplica` returns `serverOnlyReplica` as an ordinary success, so the host's failure
 * path never runs; the only thing that distinguishes "no replica at all" from a healthy one is
 * `onStorageTier`. That callback was declared and supplied by no caller anywhere, and every
 * refusal reached it as the bare word `server-only` with the reason computed and thrown away. A
 * Web Locks defect held every document in every browser at server-only, and the sole symptom was
 * a banner reading "Sync connection unverified".
 */
describe('replica fallback reporting', () => {
	const runtime = readFileSync(
		join(import.meta.dirname, '../../src/client/runtime.ts'),
		'utf8'
	);
	const generatedClient = readFileSync(
		join(import.meta.dirname, '../../src/compiler/sync.ts'),
		'utf8'
	);

	it('carries a reason alongside the tier', () => {
		expect(runtime).toMatch(
			/onStorageTier\?: \(tier: ReplicaStorageTier \| 'custom', reason\?: string\) => void/
		);
	});

	it('reports a reason at every server-only fallback', () => {
		const calls = [...runtime.matchAll(/options\.onStorageTier\?\.\(\s*'server-only'([^)]*)\)/gu)];
		expect(calls.length).toBeGreaterThanOrEqual(5);
		for (const [, rest = ''] of calls) expect(rest.trim()).not.toBe('');
	});

	it('passes the storage decision’s own reason through unchanged', () => {
		expect(runtime).toContain("options.onStorageTier?.('server-only', storage.reason)");
	});

	it('supplies the callback from the generated host seam', () => {
		expect(generatedClient).toContain('onStorageTier: (tier, reason) =>');
		expect(generatedClient).toContain('no browser replica: ');
		expect(generatedClient).toContain('onError: (cause) =>');
	});
});
