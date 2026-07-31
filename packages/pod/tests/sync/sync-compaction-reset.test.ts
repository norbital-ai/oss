import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dockerAvailable } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';
import { pickCollection, serverInsert, type ProbeCollection } from '../support/collection-probe.js';

/**
 * What an open stream does when the feed is pruned out from under it.
 *
 * The compaction boundary is the one thing standing between retention and a permanently wrong
 * replica: below it the changes are gone, so a cursor below it cannot be served a diff — only a
 * reset. The failure it guards against is silent by construction. Reading `seq > cursor` from a
 * pruned feed still returns rows; they are just the wrong rows, missing everything discarded, and
 * every party involved reports success.
 *
 * Connect time is not the only moment a cursor can fall below the boundary. A stream that stays
 * open while its client stops draining — a sleeping laptop that keeps the socket, a throttled tab —
 * sits at a fixed cursor while pruning walks past it. So the boundary is re-read before every batch,
 * and this test moves it under a live stream rather than a reconnecting one.
 */

const hasDocker = dockerAvailable();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

/** A live SSE reader: frames accumulate in the background so the test can await one at a time. */
function frameReader(response: Response) {
	const frames: string[] = [];
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let failed: unknown = null;

	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let split = buffer.indexOf('\n\n');
				while (split !== -1) {
					frames.push(buffer.slice(0, split));
					buffer = buffer.slice(split + 2);
					split = buffer.indexOf('\n\n');
				}
			}
		} catch (cause) {
			failed = cause;
		}
	})();

	return {
		frames,
		async waitFor(predicate: (frames: string[]) => boolean, budgetMs: number): Promise<void> {
			const deadline = Date.now() + budgetMs;
			while (Date.now() < deadline) {
				if (failed) throw failed;
				if (predicate(frames)) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`timed out waiting on the stream; frames so far: ${JSON.stringify(frames)}`);
		},
		async close(): Promise<void> {
			await reader.cancel().catch(() => undefined);
			await pump;
		}
	};
}

describe.skipIf(!hasDocker)('change feed resets a cursor below the compaction boundary', () => {
	let harness: PodRuntimeHarness;
	let collection: ProbeCollection;

	beforeAll(async () => {
		harness = await bootPodRuntime('construction');
		collection = await pickCollection(harness);
	}, 180_000);

	afterAll(async () => {
		await harness?.pool
			.query(`UPDATE _norbital_sync_compaction SET pruned_through_seq = 0 WHERE singleton = TRUE`)
			.catch(() => undefined);
		await harness?.stop();
	});

	it('resets a stream that falls behind retention while it is still connected', async () => {
		const abort = new AbortController();
		const response = await harness.request(
			{ method: 'GET', path: 'sync/stream?since=0', signal: abort.signal },
			admin
		);
		expect(response.status).toBe(200);
		const stream = frameReader(response);

		try {
			// Let it catch up first. A heartbeat means the loop reached its idle wait, so the cursor
			// now sits at the head of the feed and everything after this is the case under test.
			await stream.waitFor((frames) => frames.includes(': heartbeat'), 30_000);
			const delivered = stream.frames.filter((frame) => frame.startsWith('data: ')).length;

			// Retention overtakes the live stream. The boundary is what a prune leaves behind, and the
			// only part of pruning a stream can observe, so moving it is the whole of the condition.
			await harness.pool.query(
				`UPDATE _norbital_sync_compaction
				    SET pruned_through_seq = (SELECT COALESCE(MAX(seq), 0) + 1000 FROM sync_outbox),
				        pruned_at = CURRENT_TIMESTAMP
				  WHERE singleton = TRUE`
			);
			// Any commit wakes the stream, which is how this is noticed in practice: the prune is
			// silent, and the next write is what walks into the hole it left.
			await serverInsert(harness, collection);

			await stream.waitFor(
				(frames) => frames.some((frame) => frame.startsWith('event: reset')),
				30_000
			);
			expect(stream.frames.find((frame) => frame.startsWith('event: reset'))).toContain(
				'cursor_too_old'
			);
			// And nothing was served from the truncated feed. A diff after the boundary moved would be
			// the exact bug: a client applying post-prune changes onto a replica missing the pruned
			// ones, with no sign anything is absent.
			expect(stream.frames.filter((frame) => frame.startsWith('data: ')).length).toBe(delivered);
		} finally {
			await stream.close();
			abort.abort();
		}
	}, 120_000);
});
