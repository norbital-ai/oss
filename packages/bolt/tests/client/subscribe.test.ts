import { beforeEach, describe, expect, it } from 'vitest';
import { setWorkspaceSession } from '../../src/client/session.js';
import {
	subscribeToPartition,
	type EventSourceLike
} from '../../src/client/replica/subscribe.js';

const session = () =>
	setWorkspaceSession({
		tenantId: 'tenant',
		environment: 'development',
		releaseId: 'release',
		principal: 'principal',
		accessScope: 'operator',
		credential: 'credential',
		transport: { command: async () => null },
		syncStreamUrl: '/api/bolt/sync/stream',
		files: { store: async () => '', remove: async () => undefined, urlFor: (key) => key },
		chatDocuments: {
			store: async (_conversation, key, file) => ({
				storage_key: key,
				file_name: file.name,
				file_size: file.size,
				mime_type: file.type
			}),
			remove: async () => undefined,
			urlFor: (_conversation, key) => key
		},
		operations: { read: async () => null, run: async () => null }
	});

const source = () => {
	const listeners = new Map<string, (event: { data?: string }) => void>();
	let closed = 0;
	const value: EventSourceLike = {
		addEventListener: (type, listener) => listeners.set(type, listener),
		close: () => {
			closed += 1;
		},
		onerror: null
	};
	return {
		value,
		emit: (type: string, data?: string) =>
			listeners.get(type)?.(data === undefined ? {} : { data }),
		closed: () => closed
	};
};

beforeEach(session);

describe('partition dependency subscription', () => {
	it('opens one stream for the distinct dependency union and replaces it on change', () => {
		const first = source();
		const second = source();
		const opened = [first, second];
		const urls: Array<string> = [];
		const subscription = subscribeToPartition({
			collections: ['teams', 'jobs', 'jobs'],
			position: { cursor: { xid: 1, sequence: 2 }, generations: { jobs: 3 } },
			pendingMutationIds: ['mutation-2', 'mutation-1'],
			rehydration: { activeWindows: 1, rowsPerWindow: 20, estimatedBytesPerRow: 128 },
			source: (url) => {
				urls.push(url);
				return opened.shift()?.value ?? second.value;
			},
			onDeltas: () => undefined,
			onRecovery: () => undefined
		});
		expect(new URL(urls[0] ?? '', 'https://bolt.local').searchParams.getAll('collection')).toEqual([
			'jobs',
			'teams'
		]);
		expect(
			new URL(urls[0] ?? '', 'https://bolt.local').searchParams.getAll('pendingMutationId')
		).toEqual(['mutation-1', 'mutation-2']);

		subscription.update(
			['jobs'],
			{ cursor: { xid: 1, sequence: 4 }, generations: { jobs: 4 } },
			['mutation-2'],
			{ activeWindows: 1, rowsPerWindow: 20, estimatedBytesPerRow: 128 }
		);
		expect(first.closed()).toBe(1);
		expect(urls).toHaveLength(2);
		expect(new URL(urls[1] ?? '', 'https://bolt.local').searchParams.getAll('collection')).toEqual([
			'jobs'
		]);
		subscription.stop();
	});

	it('decodes full-row batches and M3 recovery advice without inventing progress', () => {
		const partition = {
			key: 'partition',
			tenantId: 'tenant',
			environment: 'development',
			effectivePolicyHolder: 'principal',
			impersonationTarget: null,
			authorityGeneration: 1,
			schemaFingerprint: 'schema-v1'
		};
		const opened = source();
		const cost = {
			replayEvents: 1,
			replayEstimateComplete: true,
			estimatedBytesPerEvent: 128,
			estimatedReplayBytes: 128,
			estimatedRehydrateBytes: 256
		};
		const batches: Array<unknown> = [];
		const recovery: Array<unknown> = [];
		const ready: Array<unknown> = [];
		subscribeToPartition({
			collections: ['jobs'],
			position: { cursor: { xid: 1, sequence: 1 }, generations: { jobs: 1 } },
			source: () => opened.value,
			onDeltas: (batch) => batches.push(batch),
			onRecovery: (advice) => recovery.push(advice),
			onReady: (value) => ready.push(value)
		});
		opened.emit(
			'ready',
			JSON.stringify({
				connectionId: 'connection',
				partition,
				cursor: { xid: 1, sequence: 1 },
				generations: { jobs: 1 }
			})
		);
		opened.emit(
			'deltas',
			JSON.stringify({
				partition,
				kind: 'delta',
				deltas: [
					{
						cursor: { xid: 1, sequence: 2 },
						collection: 'jobs',
						op: 'upsert',
						recordId: 'job-1',
						rowVersion: 2,
						mutationId: null,
						row: { id: 'job-1', row_version: 2 }
					}
				],
				headCursor: { xid: 1, sequence: 2 },
				cursor: { xid: 1, sequence: 2 },
				generations: { jobs: 2 },
				affectedCollections: ['jobs'],
				refillCollections: [],
				cost,
				mutationConfirmations: [],
				mutationRejections: [],
				complete: true
			})
		);
		opened.emit(
			'cursor-expired',
			JSON.stringify({
				partition,
				kind: 'cursorExpired',
				deltas: [],
				headCursor: { xid: 2, sequence: 0 },
				cursor: { xid: 2, sequence: 0 },
				generations: { jobs: 7 },
				affectedCollections: ['jobs'],
				refillCollections: ['jobs'],
				cost,
				mutationConfirmations: [],
				mutationRejections: [],
				complete: true
			})
		);

		expect(ready).toHaveLength(1);
		expect(batches).toMatchObject([
			{
				kind: 'delta',
				deltas: [{ op: 'upsert', rowVersion: 2 }]
			}
		]);
		expect(recovery).toEqual([
			{
				kind: 'cursorExpired',
				partition,
				deltas: [],
				cursor: { xid: 2, sequence: 0 },
				headCursor: { xid: 2, sequence: 0 },
				generations: { jobs: 7 },
				affectedCollections: ['jobs'],
				refillCollections: ['jobs'],
				cost,
				mutationConfirmations: [],
				mutationRejections: [],
				complete: true
			}
		]);
	});
});
