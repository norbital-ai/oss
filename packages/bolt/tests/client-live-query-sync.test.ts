import type {
	CollectionMutationGraph,
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	StoredRecord,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { syncRetainedPrefixBytes } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { project } from '../src/client/live-query/project.js';
import { stableKey } from '../src/client/live-query/stable-key.js';
import {
	DETACH_GRACE_MS,
	STALE_WRITE_MS,
	initialClientState,
	step
} from '../src/client/sync/machine.js';

const query = (
	limit = 3,
	orderBy: Record<string, string> = { created_at: 'desc', id: 'asc' }
) => ({ kind: 'findMany', collection: 'tasks', limit, orderBy }) as SyncQueryInput;

const writeId = (value: string): CollectionMutationIdempotencyKey =>
	value as CollectionMutationIdempotencyKey;

const mutationRequest = (
	id: CollectionMutationIdempotencyKey,
	graph: CollectionMutationGraph
): CollectionMutateRequest => ({
	protocolVersion: 2,
	idempotencyKey: id,
	issuedAtEpochMs: 1,
	partitionKey: 'partition',
	schemaFingerprint: 'schema',
	graph,
	baseVersions: []
});

const registeredPrefix = (queryKey: string, version: number, rows: StoredRecord[]) => ({
	queries: [
		{
			queryKey,
			version,
			rows,
			retainedBytes: syncRetainedPrefixBytes(rows)
		}
	],
	outcomes: []
});

describe('live query identity and projection', () => {
	it('deduplicates ordinary object key order but preserves SQL order precedence', () => {
		expect(stableKey({ kind: 'findMany', collection: 'tasks', limit: 20 } as SyncQueryInput)).toBe(
			stableKey({ limit: 20, collection: 'tasks', kind: 'findMany' } as SyncQueryInput)
		);
		expect(stableKey(query(3, { created_at: 'desc', id: 'asc' }))).not.toBe(
			stableKey(query(3, { id: 'asc', created_at: 'desc' }))
		);
	});

	it('patches held rows in place and paints a pending create without rewriting unchanged objects', () => {
		const first = { id: 'a', title: 'first' };
		const second = { id: 'b', title: 'second' };
		const result = project(
			[first, second],
			[
				{
					graph: {
						action: 'update',
						collection: 'tasks',
						values: { id: 'b', title: 'changed' }
					}
				},
				{
					graph: {
						action: 'create',
						collection: 'tasks',
						values: { id: 'outside', title: 'pending create' }
					}
				}
			],
			'tasks'
		);
		expect(result).toEqual([
			first,
			{ id: 'b', title: 'changed' },
			{ id: 'outside', title: 'pending create' }
		]);
		expect(result[0]).toBe(first);
	});
});

describe('Sync v2 prefix Machine', () => {
	it('registers a mounted prefix from current database truth', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		const [registering, effects] = step(state, { kind: 'tick', now: 0 });

		expect(registering.queries.get(key)).toMatchObject({
			requestedPrefix: 3,
			phase: 'pending',
			validating: true,
			subscribers: 1
		});
		expect(effects).toEqual([
			{
				kind: 'register',
				request: {
					queries: [{ queryKey: key, input, requestedPrefix: 3 }],
					detached: [],
					pending: []
				}
			}
		]);
	});

	it('retains an authoritative empty prefix instead of inventing a null answer arm', () => {
		const input = { kind: 'findFirst', collection: 'tasks', limit: 1 } as SyncQueryInput;
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 4, [])
		});

		expect(state.link).toBe('live');
		expect(state.queries.get(key)).toMatchObject({
			phase: 'fresh',
			validating: false,
			prefix: { version: 4, rows: [], retainedBytes: syncRetainedPrefixBytes([]) }
		});
	});

	it('applies one version transition and settles its matching write atomically', () => {
		const input = query();
		const key = stableKey(input);
		const original = [{ id: 'a', title: 'old' }];
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 7, original)
		});
		const id = writeId('w1');
		[state] = step(state, {
			kind: 'writeEnqueued',
			at: 2,
			request: mutationRequest(id, {
				action: 'update',
				collection: 'tasks',
				values: { id: 'a', title: 'new' }
			})
		});

		const [next, effects] = step(state, {
			kind: 'frame',
			at: 3,
			payload: {
				updates: [
					{
						queryKey: key,
						fromVersion: 7,
						toVersion: 8,
						delta: {
							removeIds: [],
							put: [{ id: 'a', index: 0, row: { id: 'a', title: 'new' } }]
						}
					}
				],
				resets: [],
				outcomes: [{ id, status: { resolution: 'accepted', schemaFingerprint: 'schema' } }]
			}
		});

		expect(next.queries.get(key)?.prefix).toMatchObject({
			version: 8,
			rows: [{ id: 'a', title: 'new' }]
		});
		expect(next.writes.has(id)).toBe(false);
		expect(effects).toEqual([]);
	});

	it('restarts from current truth when an update does not continue the retained version', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 7, [{ id: 'a' }])
		});

		const [next, effects] = step(state, {
			kind: 'frame',
			at: 2,
			payload: {
				updates: [
					{
						queryKey: key,
						fromVersion: 6,
						toVersion: 7,
						delta: { removeIds: [], put: [] }
					}
				],
				resets: [],
				outcomes: []
			}
		});

		expect(next.link).toBe('reconnecting');
		expect(next.queries.get(key)?.prefix).toBeUndefined();
		expect(effects).toEqual([
			{ kind: 'restart', message: 'Sync frame does not continue every retained query version' }
		]);
	});

	it('re-registers a reset prefix and never applies a second transition arm', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 2, [{ id: 'a' }])
		});

		const [next, effects] = step(state, {
			kind: 'frame',
			at: 2,
			payload: {
				updates: [],
				resets: [{ queryKey: key, reason: 'plan-changed' }],
				outcomes: []
			}
		});

		expect(next.queries.get(key)).toMatchObject({
			phase: 'pending',
			validating: true,
			extending: false
		});
		expect(next.queries.get(key)?.prefix).toBeUndefined();
		expect(effects).toMatchObject([
			{ kind: 'register', request: { queries: [{ queryKey: key }], detached: [] } }
		]);
	});

	it('extends only a same-version contiguous prefix', () => {
		const input = query(1);
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 5, [{ id: 'a' }])
		});
		let effects: ReturnType<typeof step>[1];
		[state, effects] = step(state, { kind: 'extendRequested', key, requestedPrefix: 3 });
		expect(effects).toEqual([
			{
				kind: 'extend',
				request: { queryKey: key, version: 5, loadedPrefix: 1, requestedPrefix: 3 }
			}
		]);

		const rows = [{ id: 'a' }, { id: 'b' }];
		[state, effects] = step(state, {
			kind: 'extensionAccepted',
			response: {
				queryKey: key,
				version: 5,
				fromPrefix: 1,
				toPrefix: 2,
				rows: [{ id: 'b' }],
				retainedBytes: syncRetainedPrefixBytes(rows)
			}
		});
		expect(state.queries.get(key)?.prefix).toMatchObject({ version: 5, rows });
		expect(effects).toEqual([
			{
				kind: 'extend',
				request: { queryKey: key, version: 5, loadedPrefix: 2, requestedPrefix: 3 }
			}
		]);
	});

	it('detaches after the grace window and reports the exact query key to the host', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 1, [{ id: 'a' }])
		});
		[state] = step(state, { kind: 'detached', key, at: 10 });
		const [next, effects] = step(state, { kind: 'tick', now: 10 + DETACH_GRACE_MS });

		expect(next.queries.has(key)).toBe(false);
		expect(effects).toEqual([
			{
				kind: 'register',
				request: { queries: [], detached: [key], pending: [] }
			}
		]);
	});

	it('fails pending reads and stops reconnecting after a terminal disconnect', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		const [next, effects] = step(state, {
			kind: 'disconnected',
			cause: { kind: 'terminal', message: 'release changed', at: 5 }
		});

		expect(next.link).toBe('closed');
		expect(next.queries.get(key)).toMatchObject({
			phase: 'failed',
			error: 'release changed'
		});
		expect(effects).toEqual([]);
	});

	it('re-pushes a stale write while the connection remains live', () => {
		const input = query();
		const key = stableKey(input);
		const id = writeId('w1');
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [key],
			response: registeredPrefix(key, 1, [])
		});
		[state] = step(state, {
			kind: 'writeEnqueued',
			at: 10,
			request: mutationRequest(id, { action: 'delete', collection: 'tasks', ids: ['a'] })
		});
		const [, effects] = step(state, { kind: 'tick', now: 10 + STALE_WRITE_MS });

		expect(effects).toContainEqual({ kind: 'push', writeId: id });
	});
});
