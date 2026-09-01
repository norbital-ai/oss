import type {
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	StoredRecord,
	SyncConnectRequest,
	SyncConnectResponse,
	SyncExtendPrefixRequest,
	SyncExtendPrefixResponse,
	SyncPrefixUpdate,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import {
	DEFAULT_SYNC_LOADED_KEYS,
	MAX_SYNC_LOADED_KEYS,
	MAX_SYNC_RETAINED_PREFIX_BYTES,
	syncJsonByteLength
} from '@norbital-ai/bolt-protocol';
import type { SyncClientApplyFrame } from './sse-driver.js';
import { applyPrefixDelta } from '../live-query/project.js';

export { applyPrefixDelta } from '../live-query/project.js';

type QueryKey = string;
type WriteId = CollectionMutationIdempotencyKey;

export type DisconnectCause = Readonly<{
	readonly kind: 'transport' | 'terminal';
	readonly message: string;
	readonly at: number;
}>;

export const DETACH_GRACE_MS = 30_000;
export const STALE_WRITE_MS = 15_000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

export type QueryPhase = 'pending' | 'fresh' | 'failed';

export type VersionedPrefixState = Readonly<{
	readonly version: number;
	readonly rows: ReadonlyArray<StoredRecord>;
	readonly retainedBytes: number;
}>;

export type QueryState = Readonly<{
	readonly input: SyncQueryInput;
	readonly prefix?: VersionedPrefixState;
	readonly requestedPrefix: number;
	readonly phase: QueryPhase;
	readonly validating: boolean;
	readonly extending: boolean;
	readonly subscribers: number;
	readonly detachedAt?: number;
	readonly error?: string;
}>;

export type WriteState = Readonly<
	{ readonly request: CollectionMutateRequest } & (
		| { readonly phase: 'queued' }
		| { readonly phase: 'sent'; readonly sentAt: number }
	)
>;

export type ClientState = Readonly<{
	readonly link: 'live' | 'reconnecting' | 'closed';
	readonly queries: ReadonlyMap<QueryKey, QueryState>;
	readonly writes: ReadonlyMap<WriteId, WriteState>;
	readonly reconnectAttempt: number;
	readonly reconnectAt: number;
}>;

export type ClientEvent = Readonly<
	| { readonly kind: 'frame'; readonly payload: SyncClientApplyFrame; readonly at: number }
	| { readonly kind: 'disconnected'; readonly cause: DisconnectCause }
	| {
			readonly kind: 'registered';
			readonly response: SyncConnectResponse;
			readonly at: number;
			readonly requestedKeys: ReadonlyArray<QueryKey>;
	  }
	| { readonly kind: 'extensionAccepted'; readonly response: SyncExtendPrefixResponse }
	| {
			readonly kind: 'extensionRejected';
			readonly queryKey: QueryKey;
			readonly message: string;
	  }
	| { readonly kind: 'mounted'; readonly key: QueryKey; readonly input: SyncQueryInput }
	| { readonly kind: 'detached'; readonly key: QueryKey; readonly at: number }
	| { readonly kind: 'extendRequested'; readonly key: QueryKey; readonly requestedPrefix: number }
	| {
			readonly kind: 'writeEnqueued';
			readonly request: CollectionMutateRequest;
			readonly at: number;
	  }
	| { readonly kind: 'tick'; readonly now: number }
>;

export type ClientEffect = Readonly<
	| { readonly kind: 'register'; readonly request: SyncConnectRequest }
	| { readonly kind: 'extend'; readonly request: SyncExtendPrefixRequest }
	| { readonly kind: 'push'; readonly writeId: WriteId }
	| { readonly kind: 'restart'; readonly message: string }
>;

export const initialClientState = (now = 0): ClientState => ({
	link: 'reconnecting',
	queries: new Map(),
	writes: new Map(),
	reconnectAttempt: 0,
	reconnectAt: now
});

const retryDelay = (attempt: number): number =>
	Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(16, Math.max(0, attempt)));

const isRecord = (value: unknown): value is StoredRecord =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const recordIdOf = (row: unknown): string | undefined => {
	if (!isRecord(row)) return undefined;
	const id = row['id'];
	return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const requireUniqueRecordIds = (rows: ReadonlyArray<StoredRecord>, label: string): string[] => {
	const ids = rows.map((row) => {
		const id = recordIdOf(row);
		if (id === undefined) throw new Error(`${label} contains a row without a stable id`);
		return id;
	});
	if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate row ids`);
	return ids;
};

const checkedPrefix = (
	version: number,
	rows: ReadonlyArray<StoredRecord>,
	retainedBytes: number,
	label: string
): VersionedPrefixState => {
	if (!Number.isInteger(version) || version < 0) throw new Error(`${label} has an invalid version`);
	if (rows.length > MAX_SYNC_LOADED_KEYS) throw new Error(`${label} exceeds the loaded-key ceiling`);
	requireUniqueRecordIds(rows, label);
	const measuredBytes = syncJsonByteLength(rows);
	if (retainedBytes !== measuredBytes || retainedBytes > MAX_SYNC_RETAINED_PREFIX_BYTES) {
		throw new Error(`${label} has inconsistent retained-prefix bytes`);
	}
	return { version, rows: [...rows], retainedBytes };
};

export const applyPrefixUpdate = (
	state: VersionedPrefixState,
	update: SyncPrefixUpdate
): VersionedPrefixState => {
	if (state.version !== update.fromVersion || update.toVersion !== update.fromVersion + 1) {
		throw new Error('Sync prefix update does not continue the retained version');
	}
	const rows = applyPrefixDelta(state.rows, update.delta);
	return checkedPrefix(update.toVersion, rows, syncJsonByteLength(rows), 'Updated sync prefix');
};

export const applyPrefixUpdates = (
	states: ReadonlyMap<string, VersionedPrefixState>,
	updates: ReadonlyArray<SyncPrefixUpdate>
): ReadonlyMap<string, VersionedPrefixState> => {
	const seen = new Set<string>();
	for (const update of updates) {
		if (seen.has(update.queryKey)) throw new Error('Sync frame updates one query more than once');
		seen.add(update.queryKey);
		const state = states.get(update.queryKey);
		if (state === undefined || state.version !== update.fromVersion) {
			throw new Error('Sync frame does not continue every retained query version');
		}
	}
	const next = new Map(states);
	for (const update of updates) {
		const current = next.get(update.queryKey);
		if (current === undefined) throw new Error('Sync frame lost a preflighted query base');
		next.set(update.queryKey, applyPrefixUpdate(current, update));
	}
	return next;
};

export const extendRetainedPrefix = (
	state: VersionedPrefixState,
	extension: SyncExtendPrefixResponse
): VersionedPrefixState => {
	if (extension.version !== state.version) throw new Error('Sync prefix extension is stale');
	if (
		extension.fromPrefix !== state.rows.length ||
		extension.toPrefix < extension.fromPrefix ||
		extension.toPrefix > MAX_SYNC_LOADED_KEYS ||
		extension.rows.length !== extension.toPrefix - extension.fromPrefix
	) {
		throw new Error('Sync prefix extension is not a monotonic contiguous slice');
	}
	const rows = [...state.rows, ...extension.rows];
	return checkedPrefix(state.version, rows, extension.retainedBytes, 'Extended sync prefix');
};

const withoutError = (query: QueryState): Omit<QueryState, 'error'> => {
	const { error: _error, ...rest } = query;
	return rest;
};

const withoutPrefix = (query: QueryState): Omit<QueryState, 'prefix' | 'error'> => {
	const { prefix: _prefix, error: _error, ...rest } = query;
	return rest;
};

const requestedPrefixOf = (input: SyncQueryInput): number => {
	if (input.kind === 'findFirst') return 1;
	const requested = input.limit ?? DEFAULT_SYNC_LOADED_KEYS;
	if (!Number.isInteger(requested) || requested <= 0 || requested > MAX_SYNC_LOADED_KEYS) {
		throw new Error(`A live prefix must contain between 1 and ${MAX_SYNC_LOADED_KEYS} rows`);
	}
	return requested;
};

const pendingWrites = (state: ClientState): ReadonlyArray<WriteId> => [...state.writes.keys()];

const registrationEffect = (
	state: ClientState,
	keys: ReadonlyArray<QueryKey> | undefined,
	detached: ReadonlyArray<QueryKey> = []
): Extract<ClientEffect, { readonly kind: 'register' }> => {
	const selected = keys === undefined ? [...state.queries.keys()] : [...new Set(keys)];
	const queries = selected.flatMap((queryKey): SyncConnectRequest['queries'] => {
		const query = state.queries.get(queryKey);
		if (query === undefined || query.subscribers === 0) return [];
		return [
			{
				queryKey,
				input: query.input,
				requestedPrefix: query.requestedPrefix
			}
		];
	});
	return {
		kind: 'register',
		request: { queries, detached: [...new Set(detached)], pending: pendingWrites(state) }
	};
};

const extensionEffect = (
	key: QueryKey,
	query: QueryState
): Extract<ClientEffect, { readonly kind: 'extend' }> => {
	const prefix = query.prefix;
	if (prefix === undefined) throw new Error('Cannot extend a query without a retained prefix');
	return {
		kind: 'extend',
		request: {
			queryKey: key,
			version: prefix.version,
			loadedPrefix: prefix.rows.length,
			requestedPrefix: query.requestedPrefix
		}
	};
};

const settleWrites = (
	writes: ReadonlyMap<WriteId, WriteState>,
	outcomes: SyncClientApplyFrame['outcomes'] | SyncConnectResponse['outcomes']
): ReadonlyMap<WriteId, WriteState> => {
	if (outcomes.length === 0) return writes;
	const next = new Map(writes);
	for (const outcome of outcomes) next.delete(outcome.id);
	return next;
};

const protocolRestart = (
	state: ClientState,
	message: string,
	at: number
): [ClientState, ClientEffect[]] => {
	const queries = new Map<QueryKey, QueryState>();
	for (const [key, query] of state.queries) {
		queries.set(key, {
			...withoutPrefix(query),
			phase: 'pending',
			validating: false,
			extending: false
		});
	}
	const reconnectAttempt = state.reconnectAttempt + 1;
	return [
		{
			...state,
			link: 'reconnecting',
			queries,
			reconnectAttempt,
			reconnectAt: at + retryDelay(reconnectAttempt)
		},
		[{ kind: 'restart', message }]
	];
};

const onFrame = (
	state: ClientState,
	payload: SyncClientApplyFrame,
	at: number
): [ClientState, ClientEffect[]] => {
	if (state.link !== 'live') return [state, []];
	const updateKeys = new Set<QueryKey>();
	const resetKeys = new Set<QueryKey>();
	const prefixes = new Map<QueryKey, VersionedPrefixState>();

	try {
		for (const update of payload.updates) {
			if (updateKeys.has(update.queryKey)) {
				throw new Error('Sync frame updates one query more than once');
			}
			updateKeys.add(update.queryKey);
			const query = state.queries.get(update.queryKey);
			if (
				query === undefined ||
				query.prefix === undefined ||
				query.phase !== 'fresh' ||
				query.validating
			) {
				throw new Error('Sync frame updates a query without one compatible retained prefix');
			}
			prefixes.set(update.queryKey, query.prefix);
		}
		for (const reset of payload.resets) {
			if (resetKeys.has(reset.queryKey) || updateKeys.has(reset.queryKey)) {
				throw new Error('Sync frame names one query in incompatible transitions');
			}
			if (!state.queries.has(reset.queryKey)) {
				throw new Error('Sync frame resets a query the browser does not hold');
			}
			resetKeys.add(reset.queryKey);
		}
		const applied = applyPrefixUpdates(prefixes, payload.updates);
		const queries = new Map(state.queries);
		for (const key of updateKeys) {
			const query = queries.get(key);
			const prefix = applied.get(key);
			if (query === undefined || prefix === undefined) {
				throw new Error('Sync frame lost an atomically applied query');
			}
			queries.set(key, { ...withoutError(query), prefix, phase: 'fresh' });
		}
		for (const key of resetKeys) {
			const query = queries.get(key);
			if (query === undefined) throw new Error('Sync frame lost a reset query');
			queries.set(key, {
				...withoutPrefix(query),
				phase: 'pending',
				validating: query.subscribers > 0,
				extending: false
			});
		}
		const next = { ...state, queries, writes: settleWrites(state.writes, payload.outcomes) };
		return [
			next,
			resetKeys.size === 0 ? [] : [registrationEffect(next, [...resetKeys])]
		];
	} catch (cause) {
		return protocolRestart(
			state,
			cause instanceof Error ? cause.message : 'Sync frame is incompatible with retained state',
			at
		);
	}
};

const onRegistered = (
	state: ClientState,
	response: SyncConnectResponse,
	at: number,
	requestedKeys: ReadonlyArray<QueryKey>
): [ClientState, ClientEffect[]] => {
	const expected = new Set(requestedKeys);
	if (expected.size !== requestedKeys.length) {
		return protocolRestart(state, 'Sync registration requested one query more than once', at);
	}
	const seen = new Set<QueryKey>();
	const prefixes = new Map<QueryKey, VersionedPrefixState>();
	try {
		for (const result of response.queries) {
			if (!expected.has(result.queryKey) || seen.has(result.queryKey)) {
				throw new Error('Sync registration returned an unowned or duplicate query');
			}
			seen.add(result.queryKey);
			const query = state.queries.get(result.queryKey);
			if (query === undefined) continue;
			if (result.rows.length > query.requestedPrefix) {
				throw new Error('Sync registration exceeds the requested retained prefix');
			}
			prefixes.set(
				result.queryKey,
				checkedPrefix(
					result.version,
					result.rows,
					result.retainedBytes,
					'Registered sync prefix'
				)
			);
		}
		for (const key of expected) {
			if (state.queries.has(key) && !seen.has(key)) {
				throw new Error('Sync registration omitted a query owned by this request');
			}
		}
	} catch (cause) {
		return protocolRestart(
			state,
			cause instanceof Error ? cause.message : 'Sync registration is incompatible',
			at
		);
	}

	const queries = new Map(state.queries);
	for (const [key, prefix] of prefixes) {
		const query = queries.get(key);
		if (query === undefined) continue;
		queries.set(key, {
			...withoutError(query),
			prefix,
			phase: 'fresh',
			validating: false,
			extending: false
		});
	}
	let writes = new Map(settleWrites(state.writes, response.outcomes));
	const effects: ClientEffect[] = [];
	if (state.link === 'reconnecting') {
		for (const [id, write] of writes) {
			writes.set(id, { ...write, phase: 'sent', sentAt: at });
			effects.push({ kind: 'push', writeId: id });
		}
	}
	const missing: QueryKey[] = [];
	for (const [key, query] of queries) {
		if (query.subscribers === 0 || query.phase !== 'pending' || query.validating) continue;
		queries.set(key, { ...query, validating: true });
		missing.push(key);
	}
	const next: ClientState = {
		...state,
		link: 'live',
		queries,
		writes,
		reconnectAttempt: 0,
		reconnectAt: at
	};
	if (missing.length > 0) effects.unshift(registrationEffect(next, missing));
	return [next, effects];
};

const resetAndRegister = (
	state: ClientState,
	key: QueryKey,
	message?: string
): [ClientState, ClientEffect[]] => {
	const query = state.queries.get(key);
	if (query === undefined) return [state, []];
	const queries = new Map(state.queries);
	queries.set(key, {
		...withoutPrefix(query),
		phase: 'pending',
		validating: state.link === 'live' && query.subscribers > 0,
		extending: false,
		...(message === undefined ? {} : { error: message })
	});
	const next = { ...state, queries };
	return [
		next,
		state.link === 'live' && query.subscribers > 0 ? [registrationEffect(next, [key])] : []
	];
};

export const step = (state: ClientState, event: ClientEvent): [ClientState, ClientEffect[]] => {
	switch (event.kind) {
		case 'frame':
			return onFrame(state, event.payload, event.at);
		case 'disconnected': {
			const terminal = event.cause.kind === 'terminal';
			const queries = new Map<QueryKey, QueryState>();
			for (const [key, query] of state.queries) {
				queries.set(key, {
					...withoutError(query),
					phase: terminal ? 'failed' : 'pending',
					validating: false,
					extending: false,
					...(terminal ? { error: event.cause.message } : {})
				});
			}
			if (terminal) return [{ ...state, link: 'closed', queries }, []];
			const reconnectAttempt = state.reconnectAttempt + 1;
			return [
				{
					...state,
					link: 'reconnecting',
					queries,
					reconnectAttempt,
					reconnectAt: event.cause.at + retryDelay(reconnectAttempt)
				},
				[]
			];
		}
		case 'registered':
			return onRegistered(state, event.response, event.at, event.requestedKeys);
		case 'extensionAccepted': {
			const query = state.queries.get(event.response.queryKey);
			if (query === undefined) return [state, []];
			if (!query.extending || query.prefix === undefined) {
				return resetAndRegister(state, event.response.queryKey, 'Unexpected sync prefix extension');
			}
			try {
				const prefix = extendRetainedPrefix(query.prefix, event.response);
				const queries = new Map(state.queries);
				const continueExtension =
					event.response.toPrefix > event.response.fromPrefix &&
					prefix.rows.length < query.requestedPrefix;
				const extended: QueryState = {
					...withoutError(query),
					prefix,
					phase: 'fresh',
					extending: continueExtension
				};
				queries.set(event.response.queryKey, extended);
				return [
					{ ...state, queries },
					continueExtension ? [extensionEffect(event.response.queryKey, extended)] : []
				];
			} catch (cause) {
				return resetAndRegister(
					state,
					event.response.queryKey,
					cause instanceof Error ? cause.message : 'Incompatible sync prefix extension'
				);
			}
		}
		case 'extensionRejected':
			return resetAndRegister(state, event.queryKey, event.message);
		case 'mounted': {
			const queries = new Map(state.queries);
			const existing = queries.get(event.key);
			if (existing !== undefined) {
				const { detachedAt: _detachedAt, ...rest } = existing;
				const mounted = { ...rest, subscribers: existing.subscribers + 1 };
				if (state.link === 'live' && mounted.phase === 'pending' && !mounted.validating) {
					const validating = { ...mounted, validating: true };
					queries.set(event.key, validating);
					const next = { ...state, queries };
					return [next, [registrationEffect(next, [event.key])]];
				}
				queries.set(event.key, mounted);
				return [{ ...state, queries }, []];
			}
			const query: QueryState = {
				input: event.input,
				requestedPrefix: requestedPrefixOf(event.input),
				phase: 'pending',
				validating: state.link === 'live',
				extending: false,
				subscribers: 1
			};
			queries.set(event.key, query);
			const next = { ...state, queries };
			return [
				next,
				state.link === 'live' ? [registrationEffect(next, [event.key])] : []
			];
		}
		case 'detached': {
			const existing = state.queries.get(event.key);
			if (existing === undefined || existing.subscribers === 0) return [state, []];
			const queries = new Map(state.queries);
			const subscribers = existing.subscribers - 1;
			const { detachedAt: _detachedAt, ...rest } = existing;
			queries.set(
				event.key,
				subscribers === 0
					? { ...rest, subscribers, detachedAt: event.at }
					: { ...rest, subscribers }
			);
			return [{ ...state, queries }, []];
		}
		case 'extendRequested': {
			const query = state.queries.get(event.key);
			if (query === undefined || query.subscribers === 0) return [state, []];
			if (
				!Number.isInteger(event.requestedPrefix) ||
				event.requestedPrefix <= 0 ||
				event.requestedPrefix > MAX_SYNC_LOADED_KEYS
			) {
				throw new Error(`A live prefix must contain between 1 and ${MAX_SYNC_LOADED_KEYS} rows`);
			}
			if (event.requestedPrefix <= query.requestedPrefix) return [state, []];
			const queries = new Map(state.queries);
			const extendedRequest = { ...query, requestedPrefix: event.requestedPrefix };
			if (
				state.link === 'live' &&
				extendedRequest.phase === 'fresh' &&
				extendedRequest.prefix !== undefined &&
				!extendedRequest.validating &&
				!extendedRequest.extending
			) {
				const extending = { ...extendedRequest, extending: true };
				queries.set(event.key, extending);
				return [{ ...state, queries }, [extensionEffect(event.key, extending)]];
			}
			queries.set(event.key, extendedRequest);
			return [{ ...state, queries }, []];
		}
		case 'writeEnqueued': {
			const id = event.request.idempotencyKey;
			if (state.writes.has(id) || state.link === 'closed') return [state, []];
			const writes = new Map(state.writes);
			writes.set(
				id,
				state.link === 'live'
					? { request: event.request, phase: 'sent', sentAt: event.at }
					: { request: event.request, phase: 'queued' }
			);
			return [{ ...state, writes }, [{ kind: 'push', writeId: id }]];
		}
		case 'tick': {
			if (state.link === 'closed') return [state, []];
			const queries = new Map(state.queries);
			const writes = new Map(state.writes);
			const effects: ClientEffect[] = [];
			const detached: QueryKey[] = [];

			for (const [key, query] of queries) {
				if (
					query.subscribers === 0 &&
					query.detachedAt !== undefined &&
					event.now - query.detachedAt >= DETACH_GRACE_MS
				) {
					queries.delete(key);
					detached.push(key);
				}
			}

			if (state.link === 'live') {
				for (const [id, write] of writes) {
					if (write.phase === 'queued' || event.now - write.sentAt >= STALE_WRITE_MS) {
						writes.set(id, { ...write, phase: 'sent', sentAt: event.now });
						effects.push({ kind: 'push', writeId: id });
					}
				}
			}

			let next: ClientState = { ...state, queries, writes };
			if (state.link === 'reconnecting' && state.reconnectAt <= event.now) {
				const registration = registrationEffect(next, undefined, detached);
				for (const { queryKey } of registration.request.queries) {
					const query = queries.get(queryKey);
					if (query !== undefined) queries.set(queryKey, { ...query, validating: true });
				}
				const reconnectAttempt = state.reconnectAttempt + 1;
				next = {
					...next,
					queries,
					reconnectAttempt,
					reconnectAt: event.now + retryDelay(reconnectAttempt)
				};
				effects.unshift(registration);
			} else if (state.link === 'live' && detached.length > 0) {
				effects.unshift(registrationEffect(next, [], detached));
			}
			return [next, effects];
		}
		default: {
			const exhausted: never = event;
			void exhausted;
			throw new Error('Unhandled sync client event');
		}
	}
};
