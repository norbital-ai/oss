// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import RemoteQueryView from './support/remote-query-view.svelte';
import { Effect, Schema } from 'effect';
import { syncRetainedPrefixBytes, type StoredRecord } from '@norbital-ai/bolt-protocol';
import { createMachineQuery, createRemoteQuery } from '../src/client/remote-query.svelte.js';
import {
	initialClientState,
	type ClientState,
	type QueryState
} from '../src/client/sync/machine.js';
import { stableKey } from '../src/client/live-query/stable-key.js';
import type { SyncClient } from '../src/client/sync/client.js';

/**
 * What a failing remote tells the reader, and what a query promises the reader.
 *
 * The command-backed loader records the cause in the reactive `error` cell, which previously left
 * the awaited half with nothing but "the value is undefined" to say. The Machine-backed loader
 * keeps the §1.7 read semantics: the awaited half resolves with the first projected value,
 * `current !== undefined` is the readiness test, and `loading` stays true while a revalidation
 * repaints a retained answer — the answer on screen is real but not yet confirmed.
 */
describe('remote query failure reporting', () => {
	it('rejects with the cause the command failed on', async () => {
		const cause = new Error('PostgreSQL operation failed: operator does not exist: text = uuid');
		const query = createRemoteQuery(() => Effect.fail(cause), Schema.Json);
		await expect(Promise.resolve(query)).rejects.toThrow('operator does not exist: text = uuid');
		expect(query.error).toBe(cause);
		expect(query.current).toBeUndefined();
		expect(query.loading).toBe(false);
	});

	/** A command that answers nothing at all still has to say so, rather than resolving `undefined`. */
	it('still names a command that completed without a value', async () => {
		const query = createRemoteQuery(() => Effect.succeed(undefined as never), Schema.Json);
		await expect(Promise.resolve(query)).rejects.toThrow(
			'Remote invocation completed without a value'
		);
	});
});

const queryState = (overrides: Partial<QueryState>): QueryState => ({
	input: { kind: 'findMany', collection: 'jobs' },
	requestedPrefix: 100,
	phase: 'fresh',
	validating: false,
	extending: false,
	subscribers: 1,
	...overrides
});

/** The projection under test: a row answer becomes the ids the reader sees. */
const projectIds = (state: ClientState): ReadonlyArray<string> | undefined => {
	const rows = state.queries.get('jobs')?.prefix?.rows;
	if (rows === undefined) return undefined;
	return rows.map((row) => {
		const id = row['id'];
		return typeof id === 'string' ? id : '';
	});
};

const fakeMachine = () => {
	const listeners = new Set<(state: ClientState) => void>();
	const client: SyncClient = {
		start: () => undefined,
		attach: () => () => undefined,
		shutdown: () => undefined,
		current: () => initialClientState(),
		subscribe: (listener) => {
			listeners.add(listener);
			listener(initialClientState());
			return () => listeners.delete(listener);
		},
		mount: (input) => ({
			key: stableKey(input),
			extend: () => undefined,
			detach: () => undefined
		}),
		enqueue: () => undefined
	};
	return {
		client,
		publish: (state: ClientState) => {
			for (const listener of listeners) listener(state);
		}
	};
};

describe('machine-backed query read semantics', () => {
	it('repaints a mounted Svelte consumer when the live row set grows', async () => {
		const machine = fakeMachine();
		const makeQuery = () =>
			createMachineQuery(
				machine.client,
				{ key: 'jobs', extend: () => undefined, detach: () => undefined },
				projectIds
			);
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(RemoteQueryView, { target, props: { makeQuery } });
		try {
			flushSync();
			for (const ids of [['first'], ['first', 'second'], []]) {
				const rows = ids.map((id) => ({ id }));
				machine.publish({
					...initialClientState(),
					queries: new Map([
						[
							'jobs',
							queryState({
								prefix: { version: 1, rows, retainedBytes: syncRetainedPrefixBytes(rows) }
							})
						]
					])
				});
				await Promise.resolve();
				flushSync();
				expect(target.textContent).toBe(ids.join(','));
			}
		} finally {
			await unmount(component);
			target.remove();
		}
	});

	it('resolves with the first projected value and repaints the retained answer while loading', async () => {
		const machine = fakeMachine();
		let detached = 0;
		const mounted = {
			key: 'jobs',
			extend: () => undefined,
			detach: () => {
				detached += 1;
			}
		};
		const query = createMachineQuery(machine.client, mounted, projectIds);

		expect(query.loading).toBe(true);
		expect(query.current).toBeUndefined();

		const fresh = (rows: ReadonlyArray<StoredRecord>, phase: 'fresh' | 'pending'): ClientState => ({
			...initialClientState(),
			queries: new Map([
				[
					'jobs',
					queryState({
						phase,
						validating: phase === 'pending',
						prefix: {
							version: 1,
							rows: [...rows],
							retainedBytes: syncRetainedPrefixBytes(rows)
						}
					})
				]
			])
		});

		machine.publish(fresh([{ id: 'retained' }], 'fresh'));
		expect(await Promise.resolve(query)).toEqual(['retained']);
		expect(query.current).toEqual(['retained']);
		expect(query.loading).toBe(false);

		// A commit revalidates: the Machine keeps the retained answer but flips the phase, and the
		// read must repaint the cached rows without telling the reader the revalidation finished.
		machine.publish(fresh([{ id: 'retained' }], 'pending'));
		expect(query.current).toEqual(['retained']);
		expect(query.loading).toBe(true);

		machine.publish(fresh([{ id: 'newest' }], 'fresh'));
		expect(query.current).toEqual(['newest']);
		expect(query.loading).toBe(false);
		expect(detached).toBe(0);
	});

	it('does not reproject when an unrelated Machine query publishes', () => {
		const machine = fakeMachine();
		let projections = 0;
		const query = createMachineQuery(
			machine.client,
			{ key: 'jobs', extend: () => undefined, detach: () => undefined },
			(state) => {
				projections += 1;
				return projectIds(state);
			}
		);
		const stableRows = [{ id: 'stable' }];
		const jobs = queryState({
			phase: 'fresh',
			prefix: {
				version: 1,
				rows: stableRows,
				retainedBytes: syncRetainedPrefixBytes(stableRows)
			}
		});
		const relevant: ClientState = {
			...initialClientState(),
			queries: new Map([['jobs', jobs]])
		};
		machine.publish(relevant);
		const first = query.current;
		expect(first).toEqual(['stable']);
		expect(projections).toBe(2);

		machine.publish({
			...relevant,
			queries: new Map([
				['jobs', jobs],
				['sites', queryState({ phase: 'pending' })]
			])
		});

		expect(query.current).toBe(first);
		expect(projections).toBe(2);
	});

	it('rejects a query that fails before holding a value', async () => {
		const machine = fakeMachine();
		const query = createMachineQuery(
			machine.client,
			{ key: 'jobs', extend: () => undefined, detach: () => undefined },
			projectIds
		);
		machine.publish({
			...initialClientState(),
			queries: new Map([
				['jobs', queryState({ phase: 'failed', error: 'operator does not exist: text = uuid' })]
			])
		});
		expect(query.error).toBeInstanceOf(Error);
		await expect(Promise.resolve(query)).rejects.toThrow('operator does not exist: text = uuid');
	});
});
