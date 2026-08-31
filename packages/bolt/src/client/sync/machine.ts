import type {
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	StoredRecord,
	SyncAnswer,
	SyncApplyFrame,
	SyncConnectRequest,
	SyncConnectResponse,
	SyncCursor,
	SyncHeldCoordinate,
	SyncPatch,
	SyncQueryInput
} from '@norbital-ai/bolt-protocol';

type QueryKey = string;
type WriteId = CollectionMutationIdempotencyKey;
type Digest = string;
type ConnectQuery = SyncConnectRequest['queries'][number];

export type DisconnectCause = Readonly<{
	readonly kind: 'transport' | 'release-mismatch' | 'terminal';
	readonly message: string;
	readonly at: number;
}>;

export const RETAIN_MS = 30_000;
export const STALE_WRITE_MS = 15_000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

export type QueryPhase = 'pending' | 'fresh' | 'failed';

export type QueryState = Readonly<{
	readonly input: SyncQueryInput;
	readonly digest?: Digest;
	readonly digestOnly?: boolean;
	readonly answer?: SyncAnswer;
	readonly phase: QueryPhase;
	readonly subscribers: number;
	readonly releasedAt?: number;
	readonly error?: string;
}>;

export type WriteState = Readonly<
	{ readonly request: CollectionMutateRequest } & (
		{ readonly phase: 'queued' } | { readonly phase: 'sent'; readonly sentAt: number }
	)
>;

export type ClientState = Readonly<{
	readonly link: 'live' | 'reconnecting' | 'needsReload';
	readonly head?: SyncCursor;
	readonly queries: ReadonlyMap<QueryKey, QueryState>;
	readonly writes: ReadonlyMap<WriteId, WriteState>;
	readonly reconnectAttempt: number;
	readonly reconnectAt: number;
}>;

export type ClientEvent = Readonly<
	| { readonly kind: 'frame'; readonly payload: SyncApplyFrame }
	| { readonly kind: 'disconnected'; readonly cause: DisconnectCause }
	| { readonly kind: 'connected'; readonly response: SyncConnectResponse; readonly at: number }
	| {
			readonly kind: 'mounted';
			readonly key: QueryKey;
			readonly input: SyncQueryInput;
			readonly seed?: Readonly<{ readonly answer: SyncAnswer; readonly digest: Digest }>;
	  }
	| { readonly kind: 'unmounted'; readonly key: QueryKey; readonly at: number }
	| {
			readonly kind: 'writeEnqueued';
			readonly request: CollectionMutateRequest;
			readonly at: number;
	  }
	| { readonly kind: 'tick'; readonly now: number }
>;

export type ClientEffect = Readonly<
	| {
			readonly kind: 'connect';
			readonly head?: SyncCursor;
			readonly queries: ReadonlyArray<ConnectQuery>;
			readonly pending: ReadonlyArray<WriteId>;
			readonly released: ReadonlyArray<QueryKey>;
	  }
	| { readonly kind: 'push'; readonly writeId: WriteId }
	| {
			readonly kind: 'revalidate';
			readonly query: ConnectQuery;
			readonly pending: ReadonlyArray<WriteId>;
	  }
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

const recordIds = (rows: unknown): ReadonlyArray<string> =>
	Array.isArray(rows)
		? rows.flatMap((row) => {
				const id = recordIdOf(row);
				return id === undefined ? [] : [id];
			})
		: [];

/** The answer shape whose ids the client retains as the reconnect base for changelog skipping. */
const heldIds = (query: QueryState): ReadonlyArray<string> | undefined => {
	const answer = query.answer;
	if (answer === undefined) return undefined;
	if (query.input.kind === 'count' || answer === null || typeof answer === 'number') return [];
	if (query.input.kind === 'findFirst') return recordIds([answer]);
	if (Array.isArray(answer)) return recordIds(answer);
	return Object.values(answer).flatMap((rows) => recordIds(rows));
};

const heldCoordinates = (query: QueryState): ReadonlyArray<SyncHeldCoordinate> | undefined => {
	if (query.input.kind !== 'findMany' || !Array.isArray(query.answer)) return undefined;
	const authoredOrder =
		query.input.orderBy !== null &&
		typeof query.input.orderBy === 'object' &&
		!Array.isArray(query.input.orderBy)
			? Object.entries(query.input.orderBy).flatMap(([column, direction]) =>
					direction === 'asc' || direction === 'desc' ? [column] : []
				)
			: [];
	const columns = authoredOrder.includes('id') ? authoredOrder : [...authoredOrder, 'id'];
	const coordinates = query.answer.flatMap((row) => {
		if (!isRecord(row)) return [];
		const id = recordIdOf(row);
		const order = columns.map((column) => row[column]);
		if (id === undefined || order.some((value) => value === undefined)) return [];
		const version = row['row_version'];
		return [
			{
				id,
				rowVersion: typeof version === 'number' || typeof version === 'string' ? version : null,
				order: order as SyncHeldCoordinate['order']
			}
		];
	});
	return coordinates.length === query.answer.length ? coordinates : undefined;
};

const connectQuery = (key: QueryKey, query: QueryState): ConnectQuery => {
	const ids = query.digestOnly === true ? undefined : heldIds(query);
	const coordinates = query.digestOnly === true ? undefined : heldCoordinates(query);
	return {
		key,
		input: query.input,
		...(query.digest === undefined ? {} : { digest: query.digest }),
		...(ids === undefined ? {} : { heldIds: [...ids] }),
		...(coordinates === undefined ? {} : { heldCoordinates: [...coordinates] }),
		...(query.digestOnly === true ? { digestOnly: true } : {})
	};
};

const connectQueries = (state: ClientState): ReadonlyArray<ConnectQuery> =>
	[...state.queries]
		.filter(([, query]) => query.subscribers > 0)
		.map(([key, query]) => connectQuery(key, query));

const pendingWrites = (state: ClientState): ReadonlyArray<WriteId> => [...state.writes.keys()];

const connectEffect = (
	state: ClientState,
	released: ReadonlyArray<QueryKey> = []
): ClientEffect => ({
	kind: 'connect',
	...(state.head === undefined ? {} : { head: state.head }),
	queries: connectQueries(state),
	pending: pendingWrites(state),
	released
});

const revalidateEffect = (state: ClientState, key: QueryKey, query: QueryState): ClientEffect => ({
	kind: 'revalidate',
	query: connectQuery(key, query),
	pending: pendingWrites(state)
});

const patchRows = (
	rows: ReadonlyArray<StoredRecord>,
	patch: SyncPatch
): ReadonlyArray<StoredRecord> => {
	const next = [...rows];
	if (patch.op === 'insert') {
		if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index > next.length) {
			throw new Error('Sync insert index is outside the authoritative answer');
		}
		const incomingId = recordIdOf(patch.row);
		if (incomingId === undefined || next.some((row) => recordIdOf(row) === incomingId)) {
			throw new Error('Sync insert does not name one new record');
		}
		next.splice(patch.index, 0, patch.row);
		return next;
	}
	if (patch.op === 'replace') {
		const held = next.findIndex((row) => recordIdOf(row) === patch.recordId);
		if (recordIdOf(patch.row) !== patch.recordId) {
			throw new Error('Sync replacement does not match the held record');
		}
		if (patch.index === undefined && patch.displaces === undefined && held >= 0) {
			next[held] = patch.row;
			return next;
		}
		const displaced =
			patch.displaces === undefined
				? -1
				: next.findIndex((row) => recordIdOf(row) === patch.displaces);
		const removed = patch.displaces === undefined ? held : displaced;
		if (removed < 0 || (patch.displaces !== undefined && held >= 0)) {
			throw new Error('Sync replacement does not match the held record');
		}
		const target = patch.index ?? removed;
		next.splice(removed, 1);
		if (!Number.isInteger(target) || target < 0 || target > next.length) {
			throw new Error('Sync replacement index is outside the authoritative answer');
		}
		next.splice(target, 0, patch.row);
		return next;
	}
	if (patch.op === 'remove') {
		const index = next.findIndex((row) => recordIdOf(row) === patch.recordId);
		if (index < 0) throw new Error('Sync removal does not match the held record');
		next.splice(index, 1);
		return next;
	}
	throw new Error('A non-row patch cannot be applied to a row answer');
};

/** Positional patches are strict: malformed or wrong-base operations fail closed. */
export const applyPatch = (answer: SyncAnswer | undefined, patch: SyncPatch): SyncAnswer => {
	if (patch.op === 'answer') return patch.answer;
	if (patch.op === 'scalar') {
		if (typeof answer === 'number') return patch.value;
		throw new Error('Sync scalar patch does not match a scalar answer');
	}
	if (Array.isArray(answer)) {
		if (!answer.every(isRecord)) throw new Error('Sync row answer contains a non-record value');
		return patchRows(answer, patch);
	}
	if (patch.op === 'insert' && answer === null && patch.index === 0) return patch.row;
	if (isRecord(answer) && patch.op === 'replace') {
		if (recordIdOf(answer) !== patch.recordId || recordIdOf(patch.row) !== patch.recordId) {
			throw new Error('Sync replacement does not match the held singleton');
		}
		return patch.row;
	}
	if (isRecord(answer) && patch.op === 'remove') {
		if (recordIdOf(answer) !== patch.recordId) {
			throw new Error('Sync removal does not match the held singleton');
		}
		return null;
	}
	throw new Error('Sync positional patch has no row answer to update');
};

/** Drops a stale failure so a transition leaves the optional key absent. */
const withoutError = (query: QueryState): Omit<QueryState, 'error'> => {
	const { error: _error, ...rest } = query;
	return rest;
};

const settleWrites = (
	writes: ReadonlyMap<WriteId, WriteState>,
	outcomes: SyncApplyFrame['outcomes'] | SyncConnectResponse['outcomes']
): ReadonlyMap<WriteId, WriteState> => {
	if (outcomes.length === 0) return writes;
	const next = new Map(writes);
	for (const outcome of outcomes) next.delete(outcome.id);
	return next;
};

const latestHead = (current: SyncCursor | undefined, incoming: SyncCursor): SyncCursor =>
	current === undefined || incoming.sequence >= current.sequence ? incoming : current;

const onFrame = (state: ClientState, payload: SyncApplyFrame): [ClientState, ClientEffect[]] => {
	if (state.link !== 'live') return [state, []];
	const queries = new Map(state.queries);
	const writes = settleWrites(state.writes, payload.outcomes);
	const effects: ClientEffect[] = [];
	const refused = new Set<QueryKey>();

	for (const entry of payload.patches) {
		const query = queries.get(entry.key);
		if (query === undefined || refused.has(entry.key)) continue;
		if (query.digest !== entry.from) {
			refused.add(entry.key);
			const pending = { ...withoutError(query), phase: 'pending' as const };
			queries.set(entry.key, pending);
			effects.push(revalidateEffect({ ...state, queries, writes }, entry.key, pending));
			continue;
		}
		try {
			queries.set(entry.key, {
				...withoutError(query),
				answer: applyPatch(query.answer, entry.patch),
				digest: entry.to,
				phase: 'fresh'
			});
		} catch {
			refused.add(entry.key);
			const pending = { ...withoutError(query), phase: 'pending' as const };
			queries.set(entry.key, pending);
			effects.push(revalidateEffect({ ...state, queries, writes }, entry.key, pending));
		}
	}

	return [
		{
			...state,
			head: latestHead(state.head, payload.head),
			queries,
			writes
		},
		effects
	];
};

const onConnected = (
	state: ClientState,
	response: SyncConnectResponse,
	at: number
): [ClientState, ClientEffect[]] => {
	const queries = new Map(state.queries);
	let malformed = false;
	for (const result of response.results) {
		const query = queries.get(result.key);
		if (query === undefined) continue;
		if (!result.changed && query.answer === undefined) {
			malformed = true;
			queries.set(result.key, {
				...withoutError(query),
				phase: 'failed',
				error: 'Sync handshake claimed an unchanged query without a local answer'
			});
			continue;
		}
		queries.set(result.key, {
			...withoutError(query),
			...(result.changed ? { answer: result.answer } : {}),
			digest: result.digest,
			digestOnly: result.digestOnly,
			phase: 'fresh'
		});
	}
	const settled = settleWrites(state.writes, response.outcomes);
	const writes = new Map(settled);
	const effects: ClientEffect[] = [];
	if (!malformed && state.link === 'reconnecting') {
		for (const [id, write] of writes) {
			writes.set(id, {
				...write,
				phase: 'sent',
				sentAt: at
			});
			effects.push({ kind: 'push', writeId: id });
		}
		// The opening connect effect is a snapshot. UI queries can mount after that snapshot was
		// queued but before its HTTP response arrives; while the link is reconnecting, mounts do not
		// schedule their own revalidation. Once the opening response makes the link live, issue one
		// revalidation for every subscribed query it did not answer so none remains pending forever.
		const revalidationState = { ...state, queries, writes };
		for (const [key, query] of queries) {
			if (query.phase === 'pending' && query.subscribers > 0) {
				effects.push(revalidateEffect(revalidationState, key, query));
			}
		}
	}
	const reconnectAttempt = malformed ? state.reconnectAttempt + 1 : 0;
	return [
		{
			...state,
			link: malformed ? 'reconnecting' : 'live',
			head: latestHead(state.head, response.head),
			queries,
			writes,
			reconnectAttempt,
			reconnectAt: malformed ? at + retryDelay(reconnectAttempt) : at
		},
		effects
	];
};

/** Pure sequencing authority. It imports no transport and performs no asynchronous work. */
export const step = (state: ClientState, event: ClientEvent): [ClientState, ClientEffect[]] => {
	switch (event.kind) {
		case 'frame':
			return onFrame(state, event.payload);
		case 'disconnected': {
			if (event.cause.kind !== 'transport') {
				// A terminal disconnect is a page reload, not a retry. Pending reads must settle with
				// the terminal error now — the link will never go live again, and a read left pending
				// here would strand its awaited promise forever.
				const queries = new Map(state.queries);
				for (const [key, query] of queries) {
					if (query.phase !== 'pending') continue;
					queries.set(key, {
						...withoutError(query),
						phase: 'failed' as const,
						error: event.cause.message
					});
				}
				return [{ ...state, link: 'needsReload', queries }, []];
			}
			const attempt = state.reconnectAttempt + 1;
			const reconnectAt = event.cause.at + retryDelay(attempt);
			const queries = new Map(state.queries);
			for (const [key, query] of queries) {
				if (query.phase !== 'pending') continue;
				queries.set(key, {
					...query,
					phase: 'failed',
					error: event.cause.message
				});
			}
			return [
				{
					...state,
					link: 'reconnecting',
					queries,
					reconnectAttempt: attempt,
					reconnectAt
				},
				[]
			];
		}
		case 'connected':
			return onConnected(state, event.response, event.at);
		case 'mounted': {
			const queries = new Map(state.queries);
			const existing = queries.get(event.key);
			if (existing !== undefined) {
				const { releasedAt: _releasedAt, ...rest } = existing;
				queries.set(event.key, { ...rest, subscribers: existing.subscribers + 1 });
				return [{ ...state, queries }, []];
			}
			const query: QueryState = {
				input: event.input,
				...(event.seed === undefined
					? { phase: 'pending' as const }
					: {
							answer: event.seed.answer,
							digest: event.seed.digest,
							phase: 'pending' as const
						}),
				subscribers: 1
			};
			queries.set(event.key, query);
			const next = { ...state, queries };
			return [next, state.link === 'live' ? [revalidateEffect(next, event.key, query)] : []];
		}
		case 'unmounted': {
			const existing = state.queries.get(event.key);
			if (existing === undefined || existing.subscribers === 0) return [state, []];
			const queries = new Map(state.queries);
			const subscribers = existing.subscribers - 1;
			const { releasedAt: _releasedAt, ...rest } = existing;
			queries.set(
				event.key,
				subscribers === 0
					? { ...rest, subscribers, releasedAt: event.at }
					: { ...rest, subscribers }
			);
			return [{ ...state, queries }, []];
		}
		case 'writeEnqueued': {
			const id = event.request.idempotencyKey;
			if (state.writes.has(id) || state.link === 'needsReload') return [state, []];
			const writes = new Map(state.writes);
			writes.set(
				id,
				state.link === 'live'
					? {
							request: event.request,
							phase: 'sent',
							sentAt: event.at
						}
					: { request: event.request, phase: 'queued' }
			);
			return [{ ...state, writes }, [{ kind: 'push', writeId: id }]];
		}
		case 'tick': {
			if (state.link === 'needsReload') return [state, []];
			const queries = new Map(state.queries);
			const writes = new Map(state.writes);
			const effects: ClientEffect[] = [];
			const released: QueryKey[] = [];

			for (const [key, query] of queries) {
				if (
					query.subscribers === 0 &&
					query.releasedAt !== undefined &&
					event.now - query.releasedAt >= RETAIN_MS
				) {
					queries.delete(key);
					released.push(key);
					continue;
				}
			}

			if (state.link === 'live') {
				for (const [id, write] of writes) {
					if (write.phase === 'queued' || event.now - write.sentAt >= STALE_WRITE_MS) {
						writes.set(id, {
							...write,
							phase: 'sent',
							sentAt: event.now
						});
						effects.push({ kind: 'push', writeId: id });
					}
				}
			}

			let next: ClientState = { ...state, queries, writes };
			if (state.link === 'reconnecting' && state.reconnectAt <= event.now) {
				effects.unshift(connectEffect(next, released));
				const attempt = state.reconnectAttempt + 1;
				next = {
					...next,
					reconnectAttempt: attempt,
					reconnectAt: event.now + retryDelay(attempt)
				};
			} else if (state.link === 'live' && released.length > 0) {
				effects.unshift(connectEffect(next, released));
			}
			return [next, effects];
		}
	}
};
