import type { StoredRecord, SyncPrefixUpdate, SyncQueryInput } from '@norbital-ai/bolt-protocol';
import { syncJsonByteLength, syncRetainedPrefixBytes } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { stableKey } from '../../src/client/live-query/stable-key.js';
import {
	DETACH_GRACE_MS,
	applyPrefixDelta,
	applyPrefixUpdate,
	applyPrefixUpdates,
	extendRetainedPrefix,
	initialClientState,
	step,
	type ClientState,
	type QueryState,
	type VersionedPrefixState
} from '../../src/client/sync/machine.js';

const queryInput = (collection: string): SyncQueryInput => ({
	kind: 'findMany',
	collection,
	orderBy: { position: 'asc', id: 'asc' }
});

const retained = (
	version: number,
	rows: ReadonlyArray<StoredRecord>
): VersionedPrefixState => ({ version, rows, retainedBytes: syncRetainedPrefixBytes(rows) });

const heldQuery = (
	input: SyncQueryInput,
	prefix: VersionedPrefixState,
	overrides: Partial<QueryState> = {}
): QueryState => ({
	input,
	prefix,
	requestedPrefix: 100,
	phase: 'fresh',
	validating: false,
	extending: false,
	subscribers: 1,
	...overrides
});

describe('sync engine registration ownership', () => {
	it('registers every pending stable key omitted from the opening snapshot', () => {
		const firstInput = queryInput('steps');
		const secondInput = queryInput('tasks');
		const first = stableKey(firstInput);
		const second = stableKey(secondInput);
		let state = initialClientState(0);
		[state] = step(state, { kind: 'mounted', key: first, input: firstInput });
		const opening = step(state, { kind: 'tick', now: 0 });
		state = opening[0];
		const openingEffects = opening[1];
		expect(openingEffects).toMatchObject([
			{ kind: 'register', request: { queries: [{ queryKey: first }] } }
		]);
		expect(state.queries.get(first)?.validating).toBe(true);

		[state] = step(state, { kind: 'mounted', key: second, input: secondInput });
		expect(state.queries.get(second)?.validating).toBe(false);
		const firstRows = [{ id: 's1', position: 1 }];
		const [live, effects] = step(state, {
			kind: 'registered',
			at: 1,
			requestedKeys: [first],
			response: {
				queries: [
					{
						queryKey: first,
						version: 0,
						rows: firstRows,
						retainedBytes: syncRetainedPrefixBytes(firstRows)
					}
				],
				outcomes: []
			}
		});

		expect(live.link).toBe('live');
		expect(live.queries.get(first)).toMatchObject({
			phase: 'fresh',
			validating: false,
			prefix: { version: 0, rows: firstRows }
		});
		expect(live.queries.get(second)).toMatchObject({
			phase: 'pending',
			validating: true,
			subscribers: 1
		});
		expect(effects).toMatchObject([
			{ kind: 'register', request: { queries: [{ queryKey: second }] } }
		]);
	});

	it('rejects an omitted owned registration without installing partial state', () => {
		const input = queryInput('steps');
		const key = stableKey(input);
		const state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([
				[
					key,
					{
						input,
						requestedPrefix: 100,
						phase: 'pending',
						validating: true,
						extending: false,
						subscribers: 1
					} satisfies QueryState
				]
			])
		};
		const [rejected, effects] = step(state, {
			kind: 'registered',
			at: 2,
			requestedKeys: [key],
			response: { queries: [], outcomes: [] }
		});
		expect(rejected.link).toBe('reconnecting');
		expect(rejected.queries.get(key)).toMatchObject({ phase: 'pending', validating: false });
		expect(effects).toEqual([
			{ kind: 'restart', message: 'Sync registration omitted a query owned by this request' }
		]);
	});

	it('rejects a registration whose retainedBytes is the JSON array encoding', () => {
		const input = queryInput('steps');
		const key = stableKey(input);
		const rows = [{ id: 's1', position: 1 }];
		expect(syncJsonByteLength(rows)).not.toBe(syncRetainedPrefixBytes(rows));
		const state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([
				[
					key,
					{
						input,
						requestedPrefix: 100,
						phase: 'pending',
						validating: true,
						extending: false,
						subscribers: 1
					} satisfies QueryState
				]
			])
		};
		const [rejected, effects] = step(state, {
			kind: 'registered',
			at: 2,
			requestedKeys: [key],
			response: {
				queries: [
					{
						queryKey: key,
						version: 0,
						rows,
						retainedBytes: syncJsonByteLength(rows)
					}
				],
				outcomes: []
			}
		});
		expect(rejected.link).toBe('reconnecting');
		expect(effects).toEqual([
			{ kind: 'restart', message: 'Registered sync prefix has inconsistent retained-prefix bytes' }
		]);
	});
});

describe('keyed retained-prefix reducer', () => {
	it('removes all displaced ids before inserting puts at their final indexes', () => {
		const first = { id: 'a', position: 1 };
		const unchanged = { id: 'b', position: 2 };
		const result = applyPrefixDelta([first, unchanged, { id: 'c', position: 3 }], {
			removeIds: ['c'],
			put: [
				{ id: 'x', index: 0, row: { id: 'x', position: 0 } },
				{ id: 'a', index: 2, row: { id: 'a', position: 2.5 } }
			]
		});
		expect(result).toEqual([
			{ id: 'x', position: 0 },
			unchanged,
			{ id: 'a', position: 2.5 }
		]);
		expect(result[1]).toBe(unchanged);
	});

	it('advances a shorter viewer through an empty delta before its next visible change', () => {
		const initial = retained(0, [{ id: 'r1' }, { id: 'r2' }]);
		const empty: SyncPrefixUpdate = {
			queryKey: 'steps',
			fromVersion: 0,
			toVersion: 1,
			delta: { removeIds: [], put: [] }
		};
		const visible: SyncPrefixUpdate = {
			queryKey: 'steps',
			fromVersion: 1,
			toVersion: 2,
			delta: {
				removeIds: ['r2'],
				put: [{ id: 'x', index: 0, row: { id: 'x' } }]
			}
		};
		const advanced = applyPrefixUpdate(applyPrefixUpdate(initial, empty), visible);
		expect(advanced).toMatchObject({ version: 2, rows: [{ id: 'x' }, { id: 'r1' }] });
		expect(() => applyPrefixUpdate(initial, visible)).toThrow(/retained version/u);
	});

	it('preflights every query version before applying an atomic connection frame', () => {
		const states = new Map<string, VersionedPrefixState>([
			['a', retained(3, [{ id: 'a1' }])],
			['b', retained(8, [{ id: 'b1' }])]
		]);
		const updates: SyncPrefixUpdate[] = [
			{
				queryKey: 'a',
				fromVersion: 3,
				toVersion: 4,
				delta: { removeIds: [], put: [{ id: 'a1', index: 0, row: { id: 'a1', value: 2 } }] }
			},
			{
				queryKey: 'b',
				fromVersion: 7,
				toVersion: 8,
				delta: { removeIds: [], put: [] }
			}
		];
		expect(() => applyPrefixUpdates(states, updates)).toThrow(/every retained query version/u);
		expect(states.get('a')).toMatchObject({ version: 3, rows: [{ id: 'a1' }] });
	});

	it('extends monotonically at the current version and refuses a stale extension', () => {
		const state = retained(7, [{ id: 'r1' }]);
		const rows = [{ id: 'r1' }, { id: 'r2' }];
		const extended = extendRetainedPrefix(state, {
			queryKey: 'steps',
			version: 7,
			fromPrefix: 1,
			toPrefix: 2,
			rows: [{ id: 'r2' }],
			retainedBytes: syncRetainedPrefixBytes(rows)
		});
		expect(extended).toMatchObject({ version: 7, rows });
		expect(() =>
			extendRetainedPrefix(state, {
				queryKey: 'steps',
				version: 6,
				fromPrefix: 1,
				toPrefix: 2,
				rows: [{ id: 'r2' }],
				retainedBytes: syncRetainedPrefixBytes(rows)
			})
		).toThrow(/stale/u);
	});
});

describe('atomic version application and reset', () => {
	it('applies one version transition exactly once and resets on replay', () => {
		const input = queryInput('steps');
		const key = stableKey(input);
		const base = retained(0, [{ id: 'a', position: 1 }]);
		const state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([[key, heldQuery(input, base)]])
		};
		const payload = {
			updates: [
				{
					queryKey: key,
					fromVersion: 0,
					toVersion: 1,
					delta: {
						removeIds: [],
						put: [{ id: 'a', index: 0, row: { id: 'a', position: 2 } }]
					}
				}
			],
			resets: [],
			outcomes: []
		};
		const [applied, effects] = step(state, { kind: 'frame', payload, at: 1 });
		expect(applied.queries.get(key)?.prefix).toMatchObject({
			version: 1,
			rows: [{ id: 'a', position: 2 }]
		});
		expect(effects).toEqual([]);

		const [rejected, replayEffects] = step(applied, { kind: 'frame', payload, at: 2 });
		expect(rejected.link).toBe('reconnecting');
		expect(rejected.queries.get(key)?.prefix).toBeUndefined();
		expect(replayEffects).toMatchObject([{ kind: 'restart' }]);
	});

	it('reopens a server-reset query without disturbing another retained prefix', () => {
		const firstInput = queryInput('steps');
		const secondInput = queryInput('tasks');
		const first = stableKey(firstInput);
		const second = stableKey(secondInput);
		const state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([
				[first, heldQuery(firstInput, retained(3, [{ id: 's1' }]))],
				[second, heldQuery(secondInput, retained(8, [{ id: 't1' }]))]
			])
		};
		const [next, effects] = step(state, {
			kind: 'frame',
			at: 1,
			payload: {
				updates: [],
				resets: [{ queryKey: first, reason: 'authority-changed' }],
				outcomes: []
			}
		});
		expect(next.queries.get(first)).toMatchObject({ phase: 'pending', validating: true });
		expect(next.queries.get(first)?.prefix).toBeUndefined();
		expect(next.queries.get(second)?.prefix).toBe(state.queries.get(second)?.prefix);
		expect(effects).toMatchObject([
			{ kind: 'register', request: { queries: [{ queryKey: first }] } }
		]);
	});
});

describe('retained-prefix lifetime', () => {
	it('keeps every body through the grace period and deletes it only at detach', () => {
		const input = queryInput('steps');
		const key = stableKey(input);
		const prefix = retained(2, [{ id: 's1' }, { id: 's2' }]);
		let state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([[key, heldQuery(input, prefix)]])
		};
		[state] = step(state, { kind: 'detached', key, at: 10 });
		[state] = step(state, { kind: 'tick', now: 10 + DETACH_GRACE_MS - 1 });
		expect(state.queries.get(key)?.prefix).toBe(prefix);

		const [detached, effects] = step(state, {
			kind: 'tick',
			now: 10 + DETACH_GRACE_MS
		});
		expect(detached.queries.has(key)).toBe(false);
		expect(effects).toMatchObject([
			{ kind: 'register', request: { queries: [], detached: [key] } }
		]);
	});

	it('requests extension from the retained length at the same version', () => {
		const input = queryInput('steps');
		const key = stableKey(input);
		const prefix = retained(12, [{ id: 's1' }]);
		const state: ClientState = {
			...initialClientState(0),
			link: 'live',
			queries: new Map([[key, heldQuery(input, prefix)]])
		};
		const [extending, effects] = step(state, {
			kind: 'extendRequested',
			key,
			requestedPrefix: 200
		});
		expect(extending.queries.get(key)).toMatchObject({
			requestedPrefix: 200,
			extending: true,
			prefix: { version: 12, rows: [{ id: 's1' }] }
		});
		expect(effects).toEqual([
			{
				kind: 'extend',
				request: {
					queryKey: key,
					version: 12,
					loadedPrefix: 1,
					requestedPrefix: 200
				}
			}
		]);
	});
});
