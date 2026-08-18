import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { failure, success, type TransportRequest } from '@norbital-ai/bolt-protocol';
import { Collections } from '../../src/runtime/collections/collections.js';
import { decodeWake, SYNC_TOPIC } from '../../src/runtime/sync/wake.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The announcement that replaced the poll.
 *
 * What matters here is not that a frame is produced but *what is in it* and *what it costs*: the
 * names of the collections that changed and nothing else, and never the ability to fail a write.
 */

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

type Published = { readonly topic: string; readonly collections: ReadonlyArray<string> };

/** A transport that records what was published, and answers as a host with nobody listening would. */
const recordingTransport = (published: Array<Published>) => ({
	call: async (_metadata: unknown, request: TransportRequest) => {
		if (request._tag === 'Publish') {
			published.push({ topic: request.topic, collections: decodeWake(request.bytes).collections });
		}
		return success({ delivered: 0 });
	}
});

describe('announcing a change on the sync topic', () => {
	it('names the collection that changed, on create, update and delete', async () => {
		const published: Array<Published> = [];
		harness = await makeBoltTestRuntime(undefined, {
			transport: recordingTransport(published) as never
		});
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
				yield* collections.update(effectId('update'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada Lovelace' }
				});
				yield* collections.delete(effectId('delete'), adminSubject, 'people', rid('p1'));
			})
		);

		expect(published).toHaveLength(3);
		expect(published.every((entry) => entry.topic === SYNC_TOPIC)).toBe(true);
		expect(published.map((entry) => entry.collections)).toEqual([
			['people'],
			['people'],
			['people']
		]);
	});

	it('carries only collection names, never the rows', async () => {
		const frames: Array<Uint8Array> = [];
		harness = await makeBoltTestRuntime(undefined, {
			transport: {
				call: async (_metadata: unknown, request: TransportRequest) => {
					if (request._tag === 'Publish') frames.push(request.bytes);
					return success({});
				}
			} as never
		});
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(harness!.effectId('c'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Katherine', team: 'flight' }
				});
			})
		);

		const body = new TextDecoder().decode(frames[0] ?? new Uint8Array());
		// The frame is a hint. Putting the row in it would create a second delivery path with no cursor
		// and no ordering, running beside the log and free to disagree with it.
		expect(body).not.toContain('Katherine');
		expect(body).not.toContain('flight');
		expect(decodeWake(frames[0] ?? new Uint8Array())).toEqual({ collections: ['people'] });
	});

	it('completes the write when the host has no transport bound at all', async () => {
		// The harness binds none by default, which is the environment this has to survive: the row is
		// already committed by the time anything is announced, so there is no outcome left to report.
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('c'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
			})
		);
		expect(await database.query('select name from people', [])).toEqual([{ name: 'Ada' }]);
	});

	it('does not fail the write when the transport itself refuses', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			transport: {
				call: async () =>
					failure({
						code: 'transport_missing',
						message: 'no connection',
						retryable: false,
						outcome: 'known' as const
					})
			} as never
		});
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('c'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Grace', team: 'core' }
				});
			})
		);
		// A host that cannot deliver the hint is not a reason to tell someone their save failed. The
		// replica converges on its next drain regardless.
		expect(await database.query('select name from people', [])).toEqual([{ name: 'Grace' }]);
	});
});
