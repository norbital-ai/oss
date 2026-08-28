import { createHash } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	failure,
	success,
	type AIRequest,
	type AIResponse,
	type FacilityBinding,
	type TransportRequest,
	type TransportResponse
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { Transport } from '../../src/runtime/facilities/services.js';
import {
	decodeWake,
	layer as syncWakeLayer,
	Service as SyncWakeService,
	SYNC_TOPIC
} from '../../src/runtime/sync/wake.js';
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
	it('gives repeated announcements distinct transport identities', async () => {
		const effectIds: Array<string> = [];
		const transport: FacilityBinding<TransportRequest, TransportResponse> = {
			call: async (metadata) => {
				effectIds.push(String(metadata.effectId));
				return success({ delivered: 0 });
			}
		};
		harness = await makeBoltTestRuntime(undefined, { transport });
		const wake = await harness.runtime.runPromise(SyncWakeService);
		const effectId = EffectId.make('repeated-wake');

		await harness.runtime.runPromise(wake.announce(effectId, ['automation_run']));
		await harness.runtime.runPromise(wake.announce(effectId, ['automation_run']));

		expect(effectIds).toEqual(['repeated-wake', 'repeated-wake#1']);
	});

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

	it('publishes each committed agent chat step through the same sync stream', async () => {
		const published: Array<Published> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async () => success({ output: { text: 'The live transcript is ready.' } })
		};
		harness = await makeBoltTestRuntime(undefined, {
			ai,
			transport: recordingTransport(published) as never
		});

		const agents = await harness.runtime.runPromise(Agents.Service);
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('agent-live:enqueue'),
				adminSubject,
				'web',
				'conversation-live',
				'turn-live',
				{
					kind: 'user_message',
					text: 'Show me the current state.'
				}
			)
		);
		await harness.runtime.runPromise(
			agents.execute(
				harness.effectId('agent-live:execute'),
				'conversation-live',
				admitted.turnId
			)
		);

		const announced = published.flatMap(({ collections }) => collections);
		expect(announced).toContain('chat_session');
		expect(announced.filter((name) => name === 'chat_message').length).toBeGreaterThanOrEqual(3);
		expect(
			await harness.database.query(
				"select distinct collection_name from bolt_sync_outbox where collection_name like 'chat_%' order by collection_name"
			)
		).toEqual([{ collection_name: 'chat_message' }, { collection_name: 'chat_session' }]);
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

	it('does not fail when publishing dies with a transport defect', async () => {
		const defectiveTransport = Layer.succeed(
			Transport.Service,
			Transport.Service.of({
				execute: () => Effect.die(new Error('transport response schema defect'))
			})
		);
		const program = Effect.gen(function* () {
			const wake = yield* SyncWakeService;
			yield* wake.announce(EffectId.make('wake-defect'), ['people']);
		}).pipe(Effect.provide(syncWakeLayer.pipe(Layer.provide(defectiveTransport))));

		// `announce` happens after commit. Even a defect at the host boundary is only a missed hint;
		// replicas still converge from the ordered change log on their next drain.
		await expect(Effect.runPromise(program)).resolves.toBeUndefined();
	});

	it('does not wait forever for a transport that never answers', async () => {
		const stalledTransport = Layer.succeed(
			Transport.Service,
			Transport.Service.of({ execute: () => Effect.never })
		);
		const program = Effect.gen(function* () {
			const wake = yield* SyncWakeService;
			yield* wake.announce(EffectId.make('wake-stalled'), ['people']);
		}).pipe(Effect.provide(syncWakeLayer.pipe(Layer.provide(stalledTransport))));

		await expect(Effect.runPromise(program)).resolves.toBeUndefined();
	});
});
