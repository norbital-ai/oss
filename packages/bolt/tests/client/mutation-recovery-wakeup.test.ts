import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A lost mutation response has two possible authority facts: the write arrived and can be confirmed,
 * or it never arrived and must be retried under the same idempotency key. The stream only wakes the
 * first case, so pending identities must also keep the exact status probe and stale-owner scheduler
 * alive for the second.
 */
describe('interrupted mutation recovery wakeups', () => {
	const runtime = readFileSync(join(import.meta.dirname, '../../src/client/runtime.ts'), 'utf8');

	it('starts exact status polling while a live stream carries pending mutation identities', () => {
		expect(runtime).toMatch(
			/else subscription\.update\(collections, position, pendingMutationIds, rehydration\);[\s\S]{0,600}if \(ids\.length > 0\) requestMutationStatus\(\);/u
		);
	});

	it('lets each exact status probe wake stale-owner recovery', () => {
		expect(runtime).toMatch(
			/const pollWriteOnlyMutationStatus[\s\S]+?accessState\?\.scheduleMutationPush\?\.\(\);[\s\S]+?finally \{/u
		);
	});
});
