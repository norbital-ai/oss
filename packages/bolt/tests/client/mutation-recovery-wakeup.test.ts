import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A lost mutation response has two possible authority facts: the write arrived or it did not. Either
 * way, replaying the same idempotency key after its exact owner lease is safe. Pending identities ride
 * the one workspace stream for reconnect confirmation; they must never create a second polling path.
 */
describe('interrupted mutation recovery wakeups', () => {
	const runtime = readFileSync(join(import.meta.dirname, '../../src/client/runtime.ts'), 'utf8');

	it('carries pending identities on the workspace stream without a status poll', () => {
		expect(runtime).toContain('pendingMutationIds,\n\t\t\t\t\t\trehydration');
		expect(runtime).not.toContain('pollWriteOnlyMutationStatus');
		expect(runtime).not.toMatch(
			/transport\.command\('sync\.partition', \{ pendingMutationIds:/u
		);
	});

	it('replays the same idempotent mutation at its one owner-lease deadline', () => {
		expect(runtime).toContain('.pipe(Effect.timeout(MUTATION_PUSH_STALE_AFTER_MS))');
		expect(runtime).toContain(
			'(lastAttemptAtEpochMs ?? Date.now()) + MUTATION_PUSH_STALE_AFTER_MS + 1'
		);
		expect(runtime).toContain('scheduleMutationPushAt(Date.now() + 2_000)');
	});
});
