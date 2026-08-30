import type {
	CollectionMutationIdempotencyKey,
	SyncApplyFrame,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { project } from '../../src/client/live-query/project.js';
import { stableKey } from '../../src/client/live-query/stable-key.js';
import {
	RETAIN_MS,
	STALE_WRITE_MS,
	initialClientState,
	step
} from '../../src/client/sync/machine.js';

const query = (orderBy: Record<string, string> = { created_at: 'desc', id: 'asc' }) =>
	({ kind: 'findMany', collection: 'tasks', orderBy }) as SyncQueryInput;

const writeId = (value: string): CollectionMutationIdempotencyKey =>
	value as CollectionMutationIdempotencyKey;

describe('live query identity and projection', () => {
	it('deduplicates ordinary object key order but preserves SQL order precedence', () => {
		expect(stableKey({ kind: 'findMany', collection: 'tasks', limit: 20 } as SyncQueryInput)).toBe(
			stableKey({ limit: 20, collection: 'tasks', kind: 'findMany' } as SyncQueryInput)
		);
		expect(stableKey(query({ created_at: 'desc', id: 'asc' }))).not.toBe(
			stableKey(query({ id: 'asc', created_at: 'desc' }))
		);
	});

	it('changes only rows already held and preserves every unchanged row object', () => {
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
						values: { id: 'outside', title: 'waits for authority' }
					}
				}
			],
			'tasks'
		);
		expect(result).toEqual([first, { id: 'b', title: 'changed' }]);
		expect(result[0]).toBe(first);
		expect(result).not.toContainEqual({ id: 'outside', title: 'waits for authority' });
	});
});

describe('live query Machine', () => {
	it('distinguishes an authoritative null answer from an unchanged handshake', () => {
		const input = {
			kind: 'findFirst',
			collection: 'tasks',
			limit: 1
		} as SyncQueryInput;
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'connected',
			at: 1,
			response: {
				head: { sequence: 1 },
				results: [
					{
						key,
						digestOnly: false,
						digest: 'empty',
						changed: true,
						answer: null
					}
				],
				outcomes: []
			}
		});
		expect(state.queries.get(key)).toMatchObject({
			answer: null,
			digest: 'empty',
			phase: 'fresh'
		});
	});

	it('presents a malformed handshake error and retries on the connection backoff', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'connected',
			at: 10,
			response: {
				head: { sequence: 1 },
				results: [{ key, digestOnly: false, digest: 'd1', changed: false }],
				outcomes: []
			}
		});
		expect(state.link).toBe('reconnecting');
		expect(state.queries.get(key)).toMatchObject({
			phase: 'failed',
			error: 'Sync handshake claimed an unchanged query without a local answer'
		});
		const reconnectAt = state.reconnectAt;
		const [, earlyEffects] = step(state, { kind: 'tick', now: reconnectAt - 1 });
		expect(earlyEffects).toEqual([]);
		const [, retryEffects] = step(state, { kind: 'tick', now: reconnectAt });
		expect(retryEffects).toMatchObject([{ kind: 'connect', queries: [{ key }] }]);
	});

	it('applies rows and retires the matching overlay in one reducer step', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, {
			kind: 'mounted',
			key,
			input,
			seed: { answer: [{ id: 'a', title: 'old' }], digest: 'd1' }
		});
		[state] = step(state, {
			kind: 'connected',
			at: 1,
			response: { head: { sequence: 1 }, results: [], outcomes: [] }
		});
		const id = writeId('w1');
		[state] = step(state, {
			kind: 'writeEnqueued',
			id,
			at: 2,
			graph: { action: 'update', collection: 'tasks', values: { id: 'a', title: 'new' } }
		});
		const frame: SyncApplyFrame = {
			head: { sequence: 2 },
			patches: [
				{
					key,
					from: 'd1',
					to: 'd2',
					patch: { op: 'replace', recordId: 'a', row: { id: 'a', title: 'new' } }
				}
			],
			outcomes: [{ id, status: { resolution: 'accepted', schemaFingerprint: 'schema' } }]
		};
		const [next, effects] = step(state, { kind: 'frame', payload: frame });
		expect(next.queries.get(key)).toMatchObject({
			answer: [{ id: 'a', title: 'new' }],
			digest: 'd2'
		});
		expect(next.writes.has(id)).toBe(false);
		expect(effects).toEqual([]);
	});

	it('refuses a broken digest chain and requests exactly one full revalidation', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, {
			kind: 'mounted',
			key,
			input,
			seed: { answer: [{ id: 'a' }], digest: 'd1' }
		});
		[state] = step(state, {
			kind: 'connected',
			at: 1,
			response: { head: { sequence: 1 }, results: [], outcomes: [] }
		});
		const [next, effects] = step(state, {
			kind: 'frame',
			payload: {
				head: { sequence: 3 },
				patches: [
					{
						key,
						from: 'missing-d2',
						to: 'd3',
						patch: { op: 'remove', recordId: 'a' }
					}
				],
				outcomes: []
			}
		});
		expect(next.queries.get(key)?.answer).toEqual([{ id: 'a' }]);
		expect(effects).toMatchObject([{ kind: 'revalidate', query: { key, digest: 'd1' } }]);
	});

	it('applies a boundary seat change: the entrant takes the displaced row’s seat', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, {
			kind: 'mounted',
			key,
			input,
			seed: { answer: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], digest: 'd1' }
		});
		[state] = step(state, {
			kind: 'connected',
			at: 1,
			response: { head: { sequence: 1 }, results: [], outcomes: [] }
		});
		const [next, effects] = step(state, {
			kind: 'frame',
			payload: {
				head: { sequence: 2 },
				patches: [
					{
						key,
						from: 'd1',
						to: 'd2',
						patch: {
							op: 'replace',
							recordId: 'd',
							displaces: 'c',
							row: { id: 'd', title: 'entrant' }
						}
					}
				],
				outcomes: []
			}
		});
		expect(next.queries.get(key)).toMatchObject({
			answer: [{ id: 'a' }, { id: 'b' }, { id: 'd', title: 'entrant' }],
			digest: 'd2',
			phase: 'fresh'
		});
		expect(effects).toEqual([]);
	});

	it('refuses a seat change whose displaced row the answer does not hold', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, {
			kind: 'mounted',
			key,
			input,
			seed: { answer: [{ id: 'a' }], digest: 'd1' }
		});
		[state] = step(state, {
			kind: 'connected',
			at: 1,
			response: { head: { sequence: 1 }, results: [], outcomes: [] }
		});
		const [next, effects] = step(state, {
			kind: 'frame',
			payload: {
				head: { sequence: 2 },
				patches: [
					{
						key,
						from: 'd1',
						to: 'd2',
						patch: {
							op: 'replace',
							recordId: 'x',
							displaces: 'missing',
							row: { id: 'x' }
						}
					}
				],
				outcomes: []
			}
		});
		expect(next.queries.get(key)?.answer).toEqual([{ id: 'a' }]);
		expect(effects).toMatchObject([{ kind: 'revalidate', query: { key, digest: 'd1' } }]);
	});

	it('fails pending reads when the link needs a reload instead of stranding them', () => {
		const input = query();
		const key = stableKey(input);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		const [next] = step(state, {
			kind: 'disconnected',
			cause: { kind: 'release-mismatch', message: 'release changed', at: 5 }
		});
		expect(next.link).toBe('needsReload');
		expect(next.queries.get(key)).toMatchObject({
			phase: 'failed',
			error: 'release changed'
		});
	});

	it('retains unmounted answers briefly, releases them, and re-pushes stale writes', () => {
		const input = query();
		const key = stableKey(input);
		const id = writeId('w1');
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key, input });
		[state] = step(state, {
			kind: 'connected',
			at: 0,
			response: { head: { sequence: 0 }, results: [], outcomes: [] }
		});
		[state] = step(state, { kind: 'unmounted', key, at: 10 });
		[state] = step(state, {
			kind: 'writeEnqueued',
			id,
			at: 10,
			graph: { action: 'delete', collection: 'tasks', id: 'a' }
		});
		const [next, effects] = step(state, {
			kind: 'tick',
			now: Math.max(10 + RETAIN_MS, 10 + STALE_WRITE_MS)
		});
		expect(next.queries.has(key)).toBe(false);
		expect(effects).toContainEqual(expect.objectContaining({ kind: 'connect', released: [key] }));
		expect(effects).toContainEqual({ kind: 'push', writeId: id });
	});
});
