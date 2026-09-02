import {
	MAX_SYNC_INITIAL_ANSWER_BYTES,
	MAX_SYNC_LOADED_KEYS,
	MAX_SYNC_OUTBOUND_FRAME_BYTES,
	MAX_SYNC_RETAINED_PREFIX_BYTES,
	syncApplyFrameByteLength,
	syncJsonByteLength,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncAdvanceSubscription,
	type SyncAdvanceUpdate,
	type SyncApplyFrame,
	type SyncChange,
	type SyncConnectEvaluation,
	type SyncConnectEvaluationResult,
	type SyncConnectRequest,
	type SyncConnectResponse,
	type SyncExtendPrefixEvaluation,
	type SyncExtendPrefixRequest,
	type SyncExtendPrefixResponse,
	type SyncPrefixDelta,
	type SyncPrefixKey,
	type SyncQueryInput,
	type SyncResetReason,
	type SyncRoutingConstraint,
	type SyncSubEntry
} from './sync.js';

export interface SyncRegistryConnection {
	/**
	 * The caller token the guest evaluates this connection under.
	 *
	 * Writable so a second tab of the same principal can present a newer session token without
	 * forcing `410` on a stream that is still open. The physical connection is keyed by principal,
	 * not by this string.
	 */
	credential: string;
	readonly sink: {
		readonly writable: () => boolean;
		readonly write: (frame: SyncApplyFrame) => boolean;
	};
	readonly subscriptions: Map<string, string>;
	closed: boolean;
}

type SyncAttachmentState = {
	readonly authority?: string | undefined;
	loadedPrefix: number;
};

type SyncAttachment<Connection> = Readonly<{
	readonly connection: Connection;
	readonly queryKey: string;
	readonly authority?: string | undefined;
	readonly loadedPrefix: number;
}>;

type SyncPlanState<Connection> = {
	readonly subId: string;
	readonly input: SyncQueryInput;
	readonly planKey: string;
	version: number;
	keys: ReadonlyArray<SyncPrefixKey>;
	retainedBytes: number;
	readonly authorityFingerprint: string;
	dependencies: ReadonlyArray<string>;
	routing: NonNullable<SyncSubEntry['routing']>;
	readonly attached: Map<Connection, Map<string, SyncAttachmentState>>;
};

type SyncAffectedState<Connection> = Readonly<{
	readonly subscription: SyncAdvanceSubscription;
	readonly attachments: ReadonlyArray<SyncAttachment<Connection>>;
}>;

type MutableSyncApplyFrame = {
	updates: Array<SyncApplyFrame['updates'][number]>;
	resets: Array<SyncApplyFrame['resets'][number]>;
	outcomes: Array<SyncApplyFrame['outcomes'][number]>;
};

export type SyncPrefixViewerState = Readonly<{
	readonly subId: string;
	readonly version: number;
	readonly loadedPrefix: number;
	readonly retainedPrefix: number;
	readonly retainedBytes: number;
}>;

export type SyncPrefixExtensionDecision = Readonly<
	| ({ readonly accepted: true } & SyncPrefixViewerState)
	| {
			readonly accepted: false;
			readonly reason:
				| 'not-attached'
				| 'stale-version'
				| 'non-monotonic'
				| 'prefix-limit'
				| 'prefix-bytes'
				| 'inconsistent-prefix';
	  }
>;

const canonical = (value: unknown, preserveObjectOrder = false): string => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
	switch (typeof value) {
		case 'string':
		case 'boolean':
		case 'number': {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) throw new TypeError('sync query input must be JSON');
			return encoded;
		}
		case 'object': {
			const entries = Object.entries(value);
			if (!preserveObjectOrder)
				entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
			return `{${entries
				.map(
					([key, item]) =>
						`${JSON.stringify(key)}:${canonical(item, key === 'orderBy' && !Array.isArray(item))}`
				)
				.join(',')}}`;
		}
		default:
			throw new TypeError('sync query input must be JSON');
	}
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const samePrefixKeys = (
	left: ReadonlyArray<SyncPrefixKey>,
	right: ReadonlyArray<SyncPrefixKey>
): boolean => canonical(left) === canonical(right);

const isPrefixOf = (
	shorter: ReadonlyArray<SyncPrefixKey>,
	longer: ReadonlyArray<SyncPrefixKey>
): boolean =>
	shorter.length <= longer.length &&
	shorter.every((key, index) => canonical(key) === canonical(longer[index]));

const validPrefixKeys = (keys: ReadonlyArray<SyncPrefixKey>): boolean =>
	keys.length <= MAX_SYNC_LOADED_KEYS && new Set(keys.map(({ id }) => id)).size === keys.length;

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(values)].sort();

const sortedUniqueNumbers = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
	[...new Set(values)].sort((left, right) => left - right);

const routingKey = (field: string, value: unknown): string => `${field}\0${canonical(value)}`;

const normalizedRouting = (
	routing: SyncSubEntry['routing']
): NonNullable<SyncSubEntry['routing']> => {
	const normalized: SyncRoutingConstraint[] = [];
	for (const { field, values } of routing) {
		const unique = [...new Map(values.map((value) => [canonical(value), value])).values()].sort(
			(left, right) => canonical(left).localeCompare(canonical(right))
		);
		if (unique.length > 0) normalized.push({ field, values: unique });
	}
	normalized.sort((left, right) => left.field.localeCompare(right.field));
	return normalized;
};

const sameRouting = (
	left: NonNullable<SyncSubEntry['routing']>,
	right: NonNullable<SyncSubEntry['routing']>
): boolean => canonical(left) === canonical(right);

const validPrefixState = (entry: {
	readonly prefixKeys: ReadonlyArray<SyncPrefixKey>;
	readonly loadedPrefix: number;
	readonly prefixBytes: number;
}): boolean =>
	validPrefixKeys(entry.prefixKeys) &&
	entry.loadedPrefix <= entry.prefixKeys.length &&
	entry.prefixBytes >= 0 &&
	entry.prefixBytes <= MAX_SYNC_RETAINED_PREFIX_BYTES;

const validDelta = (delta: SyncPrefixDelta, retainedPrefix: number): boolean => {
	const removeIds = new Set(delta.removeIds);
	const putIds = new Set(delta.put.map(({ id }) => id));
	return (
		removeIds.size === delta.removeIds.length &&
		putIds.size === delta.put.length &&
		[...removeIds].every((id) => !putIds.has(id)) &&
		delta.put.every(
			({ id, index, row }) =>
				index < retainedPrefix && typeof row.id === 'string' && row.id === id
		)
	);
};

type SyncRegistryOptions = Readonly<{
	readonly hash: (value: string) => string;
}>;

export class SyncRegistry<Connection extends SyncRegistryConnection> {
	readonly #plans = new Map<string, SyncPlanState<Connection>>();
	readonly #byCollection = new Map<string, Set<string>>();
	readonly #hash: (value: string) => string;

	constructor(options: SyncRegistryOptions) {
		this.#hash = options.hash;
	}

	attach(connection: Connection, entries: ReadonlyArray<SyncSubEntry>): void {
		if (connection.closed) return;
		const seen = new Set<string>();
		for (const entry of entries) {
			if (seen.has(entry.key)) throw new Error(`duplicate sync query key ${entry.key}`);
			seen.add(entry.key);
			if (!validPrefixState(entry)) throw new Error('invalid bounded sync prefix registration');
			this.release(connection, [entry.key]);

			const subId = this.#hash(entry.planKey);
			const dependencies = sortedUnique(entry.dependencies);
			const routing = normalizedRouting(entry.routing);
			let state = this.#plans.get(subId);
			if (state === undefined) {
				state = {
					subId,
					input: entry.input,
					planKey: entry.planKey,
					version: entry.version,
					keys: [...entry.prefixKeys],
					retainedBytes: entry.prefixBytes,
					authorityFingerprint: entry.authorityFingerprint,
					dependencies,
					routing,
					attached: new Map()
				};
				this.#plans.set(subId, state);
				this.#index(state);
			} else {
				if (
					state.planKey !== entry.planKey ||
					state.authorityFingerprint !== entry.authorityFingerprint ||
					// A freshly evaluated registration always says version 0: `connect` reads the current
					// authoritative answer and has no way to know what version this host is holding the
					// shared plan at. The lane serializes `connect` against `committed`, so that read *is*
					// the current answer and the viewer joins at the version the plan already holds.
					// Comparing the two outright — which is what this used to do — refused every second
					// viewer of any query that had advanced even once, and refusal here closes the whole
					// connection. A non-zero entry is still a claim about a specific version and must match.
					(entry.version !== 0 && state.version !== entry.version) ||
					canonical(state.input) !== canonical(entry.input) ||
					!sameStrings(state.dependencies, dependencies) ||
					!sameRouting(state.routing, routing) ||
					(!isPrefixOf(state.keys, entry.prefixKeys) && !isPrefixOf(entry.prefixKeys, state.keys))
				)
					throw new Error('incompatible versioned sync registration');
				if (entry.prefixKeys.length > state.keys.length) {
					if (entry.prefixBytes < state.retainedBytes)
						throw new Error('extended sync prefix reduced retained bytes');
					state.keys = [...entry.prefixKeys];
					state.retainedBytes = entry.prefixBytes;
				} else if (
					entry.prefixKeys.length === state.keys.length &&
					(!samePrefixKeys(state.keys, entry.prefixKeys) ||
						state.retainedBytes !== entry.prefixBytes)
				) {
					throw new Error('inconsistent versioned sync prefix');
				}
			}

			let viewers = state.attached.get(connection);
			if (viewers === undefined) {
				viewers = new Map();
				state.attached.set(connection, viewers);
			}
			viewers.set(entry.key, {
				...(entry.impersonatedTeam === undefined
					? {}
					: { authority: entry.impersonatedTeam }),
				loadedPrefix: entry.loadedPrefix
			});
			connection.subscriptions.set(entry.key, subId);
		}
	}

	release(connection: Connection, queryKeys: ReadonlyArray<string>): void {
		for (const queryKey of new Set(queryKeys)) {
			const subId = connection.subscriptions.get(queryKey);
			if (subId === undefined) continue;
			connection.subscriptions.delete(queryKey);
			const state = this.#plans.get(subId);
			const viewers = state?.attached.get(connection);
			viewers?.delete(queryKey);
			if (viewers?.size === 0) state?.attached.delete(connection);
			if (state !== undefined && state.attached.size === 0) this.#retire(state);
		}
	}

	detach(connection: Connection): void {
		this.release(connection, [...connection.subscriptions.keys()]);
	}

	prefixViewer(connection: Connection, queryKey: string): SyncPrefixViewerState | undefined {
		const subId = connection.subscriptions.get(queryKey);
		const state = subId === undefined ? undefined : this.#plans.get(subId);
		const viewer = state?.attached.get(connection)?.get(queryKey);
		return state === undefined || viewer === undefined
			? undefined
			: {
					subId: state.subId,
					version: state.version,
					loadedPrefix: viewer.loadedPrefix,
					retainedPrefix: state.keys.length,
					retainedBytes: state.retainedBytes
				};
	}

	extendPrefix(
		connection: Connection,
		evaluation: SyncExtendPrefixEvaluation
	): SyncPrefixExtensionDecision {
		const subId = connection.subscriptions.get(evaluation.queryKey);
		const state = subId === undefined ? undefined : this.#plans.get(subId);
		const viewer = state?.attached.get(connection)?.get(evaluation.queryKey);
		if (state === undefined || viewer === undefined)
			return { accepted: false, reason: 'not-attached' };
		if (evaluation.version !== state.version)
			return { accepted: false, reason: 'stale-version' };
		if (
			evaluation.fromPrefix !== viewer.loadedPrefix ||
			evaluation.toPrefix <= viewer.loadedPrefix
		)
			return { accepted: false, reason: 'non-monotonic' };
		if (
			evaluation.toPrefix > MAX_SYNC_LOADED_KEYS ||
			evaluation.toPrefix > evaluation.prefixKeys.length ||
			!validPrefixKeys(evaluation.prefixKeys)
		)
			return { accepted: false, reason: 'prefix-limit' };
		if (
			evaluation.retainedBytes < state.retainedBytes ||
			evaluation.retainedBytes > MAX_SYNC_RETAINED_PREFIX_BYTES
		)
			return { accepted: false, reason: 'prefix-bytes' };
		if (!isPrefixOf(state.keys, evaluation.prefixKeys))
			return { accepted: false, reason: 'inconsistent-prefix' };

		state.keys = [...evaluation.prefixKeys];
		state.retainedBytes = evaluation.retainedBytes;
		viewer.loadedPrefix = evaluation.toPrefix;
		return {
			accepted: true,
			subId: state.subId,
			version: state.version,
			loadedPrefix: viewer.loadedPrefix,
			retainedPrefix: state.keys.length,
			retainedBytes: state.retainedBytes
		};
	}

	frameFits(frame: SyncApplyFrame): boolean {
		return syncApplyFrameByteLength(frame) <= MAX_SYNC_OUTBOUND_FRAME_BYTES;
	}

	emit(connection: Connection, frame: SyncApplyFrame): boolean {
		return (
			this.frameFits(frame) &&
			!connection.closed &&
			connection.sink.writable() &&
			connection.sink.write(frame)
		);
	}

	affectedStates(changes: ReadonlyArray<SyncChange>): ReadonlyArray<SyncAffectedState<Connection>> {
		const affected = new Set<string>();
		for (const change of changes) {
			const routes = [
				...(change.operation === 'insert' ? [] : [change.before]),
				...(change.operation === 'delete' ? [] : [change.after])
			];
			for (const subId of this.#byCollection.get(change.collection) ?? []) {
				const state = this.#plans.get(subId);
				if (state === undefined) continue;
				if (
					state.input.collection !== change.collection ||
					state.keys.some(({ id }) => id === change.id) ||
					state.routing.length === 0 ||
					routes.length === 0
				) {
					affected.add(subId);
					continue;
				}
				const couldMatch = routes.some((route) =>
					state.routing.every(
						(constraint) =>
							!Object.hasOwn(route, constraint.field) ||
							constraint.values.some(
								(value) =>
									routingKey(constraint.field, route[constraint.field]) ===
									routingKey(constraint.field, value)
							)
					)
				);
				if (couldMatch) affected.add(subId);
			}
		}
		return [...affected].sort().flatMap((subId) => {
			const state = this.#plans.get(subId);
			if (state === undefined) return [];
			const attachments = this.#attachmentsOf(state);
			const representative = attachments[0];
			if (representative === undefined) {
				this.#retire(state);
				return [];
			}
			return [
				{
					subscription: this.#subscription(state, representative),
					attachments
				}
			];
		});
	}

	details(subId: string): SyncAffectedState<Connection> | undefined {
		const state = this.#plans.get(subId);
		if (state === undefined) return undefined;
		const attachments = this.#attachmentsOf(state);
		const representative = attachments[0];
		return representative === undefined
			? undefined
			: {
					subscription: this.#subscription(state, representative),
					attachments
				};
	}

	#advanceBase(update: SyncAdvanceUpdate): SyncPlanState<Connection> | undefined {
		const state = this.#plans.get(update.subId);
		return state !== undefined &&
			state.version === update.fromVersion &&
			update.toVersion === update.fromVersion + 1 &&
			state.authorityFingerprint === update.authorityFingerprint &&
			validPrefixKeys(update.prefixKeys) &&
			update.prefixBytes >= 0 &&
			update.prefixBytes <= MAX_SYNC_RETAINED_PREFIX_BYTES
			? state
			: undefined;
	}

	validateAdvance(update: SyncAdvanceUpdate): boolean {
		const state = this.#advanceBase(update);
		if (state === undefined) return false;
		const expectedPrefixes = sortedUniqueNumbers(
			this.#attachmentsOf(state).map(({ loadedPrefix }) => loadedPrefix)
		);
		const deltaPrefixes = update.deltas.map(({ loadedPrefix }) => loadedPrefix).sort((a, b) => a - b);
		return (
			expectedPrefixes.length === deltaPrefixes.length &&
			expectedPrefixes.every((prefix, index) => prefix === deltaPrefixes[index]) &&
			new Set(deltaPrefixes).size === deltaPrefixes.length &&
			update.deltas.every(({ loadedPrefix, delta }) =>
				validDelta(delta, Math.min(loadedPrefix, update.prefixKeys.length))
			)
		);
	}

	commitAdvance(update: SyncAdvanceUpdate): boolean {
		const state = this.#advanceBase(update);
		if (state === undefined) return false;
		this.#unindex(state);
		state.version = update.toVersion;
		state.keys = [...update.prefixKeys];
		state.retainedBytes = update.prefixBytes;
		state.dependencies = sortedUnique(update.dependencies);
		for (const viewers of state.attached.values())
			for (const viewer of viewers.values())
				viewer.loadedPrefix = Math.min(viewer.loadedPrefix, state.keys.length);
		this.#index(state);
		return true;
	}

	reset(subId: string): ReadonlyArray<SyncAttachment<Connection>> {
		const state = this.#plans.get(subId);
		if (state === undefined) return [];
		const attachments = this.#attachmentsOf(state);
		this.#retire(state);
		return attachments;
	}

	#attachmentsOf(state: SyncPlanState<Connection>): ReadonlyArray<SyncAttachment<Connection>> {
		return [...state.attached].flatMap(([connection, viewers]) =>
			[...viewers].map(([queryKey, viewer]) => ({
				connection,
				queryKey,
				...(viewer.authority === undefined ? {} : { authority: viewer.authority }),
				loadedPrefix: viewer.loadedPrefix
			}))
		);
	}

	#subscription(
		state: SyncPlanState<Connection>,
		representative: SyncAttachment<Connection>
	): SyncAdvanceSubscription {
		return {
			subId: state.subId,
			input: state.input,
			planKey: state.planKey,
			version: state.version,
			prefixKeys: [...state.keys],
			prefixBytes: state.retainedBytes,
			viewerPrefixes: sortedUniqueNumbers(
				this.#attachmentsOf(state).map(({ loadedPrefix }) => loadedPrefix)
			),
			credential: representative.connection.credential,
			...(representative.authority === undefined
				? {}
				: { impersonatedTeam: representative.authority }),
			authorityFingerprint: state.authorityFingerprint
		};
	}

	#retire(state: SyncPlanState<Connection>): void {
		this.#plans.delete(state.subId);
		this.#unindex(state);
		for (const [connection, viewers] of state.attached)
			for (const queryKey of viewers.keys()) connection.subscriptions.delete(queryKey);
		state.attached.clear();
	}

	#index(state: SyncPlanState<Connection>): void {
		for (const collection of state.dependencies) {
			let plans = this.#byCollection.get(collection);
			if (plans === undefined) {
				plans = new Set();
				this.#byCollection.set(collection, plans);
			}
			plans.add(state.subId);
		}
	}

	#unindex(state: SyncPlanState<Connection>): void {
		for (const collection of state.dependencies) {
			const plans = this.#byCollection.get(collection);
			plans?.delete(state.subId);
			if (plans?.size === 0) this.#byCollection.delete(collection);
		}
	}
}

/**
 * The client's answer, versioned by the registry rather than by the evaluation.
 *
 * A fresh evaluation says 0 for every query. If that reached the browser unchanged, a second viewer
 * of an already-advanced plan would fence its retained prefix at 0 and reject the very next update
 * as discontinuous. `registeredVersion` reports what the plan is actually held at, which is the
 * version the deltas that follow will continue from.
 */
const syncClientResponse = (
	evaluation: SyncConnectEvaluation,
	registeredVersion: (queryKey: string) => number | undefined
): SyncConnectResponse => ({
	queries: evaluation.results.map((result: SyncConnectEvaluationResult) => ({
		queryKey: result.key,
		version: registeredVersion(result.key) ?? result.version,
		rows: result.rows,
		retainedBytes: result.prefixBytes
	})),
	outcomes: evaluation.outcomes
});

type SyncConnectionLaneOptions<
	Connection extends SyncRegistryConnection & Readonly<{ id: string }>,
	CloseReason
> = Readonly<{
	readonly hash: (value: string) => string;
	readonly connect: (
		connection: Connection,
		request: SyncConnectRequest
	) => Promise<SyncConnectEvaluation>;
	readonly extendPrefix: (
		connection: Connection,
		request: SyncExtendPrefixRequest
	) => Promise<SyncExtendPrefixEvaluation>;
	readonly guestFailure: CloseReason;
	readonly close: (connection: Connection, reason: CloseReason) => void;
}>;

type SyncLaneConnectOptions<Connection extends SyncRegistryConnection & Readonly<{ id: string }>> =
	Readonly<{
		readonly request: SyncConnectRequest;
		readonly resolve: () => Connection | undefined;
		readonly unavailable: () => Error;
	}>;

type SyncLaneExtendOptions<Connection extends SyncRegistryConnection & Readonly<{ id: string }>> =
	Readonly<{
		readonly request: SyncExtendPrefixRequest;
		readonly resolve: () => Connection | undefined;
		readonly unavailable: () => Error;
	}>;

type SyncLaneCommitOptions<Connection extends SyncRegistryConnection & Readonly<{ id: string }>> =
	Readonly<{
		readonly changes: SyncAdvanceRequest['changes'];
		readonly pending: SyncAdvanceRequest['pending'];
		readonly resolveWriter: () => Connection | undefined;
		readonly writerProof: (connection: Connection) => NonNullable<SyncAdvanceRequest['writer']>;
		readonly advance: (request: SyncAdvanceRequest) => Promise<SyncAdvanceResponse>;
	}>;

export class SyncConnectionLane<
	Connection extends SyncRegistryConnection & Readonly<{ id: string }>,
	CloseReason
> {
	readonly registry: SyncRegistry<Connection>;
	readonly #connections = new Map<string, Connection>();
	readonly #connect: SyncConnectionLaneOptions<Connection, CloseReason>['connect'];
	readonly #extendPrefix: SyncConnectionLaneOptions<Connection, CloseReason>['extendPrefix'];
	readonly #guestFailure: CloseReason;
	readonly #onClose: SyncConnectionLaneOptions<Connection, CloseReason>['close'];
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: SyncConnectionLaneOptions<Connection, CloseReason>) {
		this.registry = new SyncRegistry({ hash: options.hash });
		this.#connect = options.connect;
		this.#extendPrefix = options.extendPrefix;
		this.#guestFailure = options.guestFailure;
		this.#onClose = options.close;
	}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		this.#closed = true;
	}

	idle(): Promise<void> {
		return this.#tail;
	}

	get(connectionId: string): Connection | undefined {
		return this.#connections.get(connectionId);
	}

	connections(): IterableIterator<Connection> {
		return this.#connections.values();
	}

	open(connection: Connection, reason: CloseReason): void {
		if (this.#closed) throw new Error('sync lane is closing');
		const previous = this.#connections.get(connection.id);
		if (previous !== undefined) this.detach(previous.id, reason);
		this.#connections.set(connection.id, connection);
	}

	detach(connectionId: string, reason: CloseReason): void {
		const connection = this.#connections.get(connectionId);
		if (connection === undefined || connection.closed) return;
		connection.closed = true;
		this.#connections.delete(connectionId);
		this.registry.detach(connection);
		this.#onClose(connection, reason);
	}

	detachAll(reason: CloseReason): void {
		for (const connection of [...this.#connections.values()]) this.detach(connection.id, reason);
	}

	enqueue<A>(operation: () => Promise<A>): Promise<A> {
		const run = this.#tail.then(() => {
			if (this.#closed) throw new Error('sync lane is closing');
			return operation();
		});
		this.#tail = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	connect(options: SyncLaneConnectOptions<Connection>): Promise<SyncConnectResponse> {
		return this.enqueue(async () => {
			const connection = options.resolve();
			if (connection === undefined) throw options.unavailable();
			this.registry.release(connection, options.request.detached);
			let evaluation: SyncConnectEvaluation;
			try {
				evaluation = await this.#connect(connection, options.request);
			} catch (cause) {
				// A refused or exploded registration is that request's failure. Detaching here closed
				// the physical stream for every other live query — month-board hops and calendar
				// expansions then 410'd on a connection the EventSource still believed it owned.
				throw cause;
			}
			if (connection.closed || this.#closed) throw options.unavailable();
			const requestedKeys = options.request.queries.map(({ queryKey }) => queryKey).sort();
			const resultKeys = evaluation.results.map(({ key }) => key).sort();
			if (
				new Set(requestedKeys).size !== requestedKeys.length ||
				new Set(resultKeys).size !== resultKeys.length ||
				!sameStrings(requestedKeys, resultKeys) ||
				evaluation.results.some(
					(result) =>
						result.rows.length !== result.loadedPrefix ||
						result.loadedPrefix > result.prefixKeys.length
				)
			) {
				// This request's answer is unusable. Detaching here is what turned one refused
				// calendar/month-board query into a 410 on every other live query that still owned
				// this EventSource.
				throw new Error('sync initial answer does not match its prefix');
			}
			try {
				this.registry.attach(connection, evaluation.results);
			} catch (cause) {
				// Same as a guest throw: the registration fails; already-attached queries stay.
				throw cause;
			}
			// Built after attachment, because the version a query is registered at is the registry's
			// answer and not the evaluation's.
			const response = syncClientResponse(
				evaluation,
				(queryKey) => this.registry.prefixViewer(connection, queryKey)?.version
			);
			if (syncJsonByteLength(response) > MAX_SYNC_INITIAL_ANSWER_BYTES) {
				this.registry.release(connection, requestedKeys);
				throw new Error('sync initial answer exceeds its encoded byte ceiling');
			}
			return response;
		});
	}

	extendPrefix(options: SyncLaneExtendOptions<Connection>): Promise<SyncExtendPrefixResponse> {
		return this.enqueue(async () => {
			const connection = options.resolve();
			if (connection === undefined) throw options.unavailable();
			let evaluation: SyncExtendPrefixEvaluation;
			try {
				evaluation = await this.#extendPrefix(connection, options.request);
			} catch (cause) {
				// Same as connect: the prefix request fails; already-attached queries stay on the stream.
				throw cause;
			}
			if (connection.closed || this.#closed) throw options.unavailable();
			if (
				evaluation.queryKey !== options.request.queryKey ||
				evaluation.version !== options.request.version ||
				evaluation.fromPrefix !== options.request.loadedPrefix ||
				evaluation.toPrefix > options.request.requestedPrefix ||
				evaluation.rows.length !== evaluation.toPrefix - evaluation.fromPrefix
			)
				return this.#resetExtension(connection, options.request.queryKey, 'inconsistent-prefix');
			const response: SyncExtendPrefixResponse = {
				queryKey: evaluation.queryKey,
				version: evaluation.version,
				fromPrefix: evaluation.fromPrefix,
				toPrefix: evaluation.toPrefix,
				rows: evaluation.rows,
				retainedBytes: evaluation.retainedBytes
			};
			if (syncJsonByteLength(response) > MAX_SYNC_INITIAL_ANSWER_BYTES)
				return this.#resetExtension(connection, options.request.queryKey, 'prefix-bytes');
			const decision = this.registry.extendPrefix(connection, evaluation);
			if (!decision.accepted)
				return this.#resetExtension(
					connection,
					options.request.queryKey,
					decision.reason === 'not-attached' || decision.reason === 'non-monotonic'
						? 'inconsistent-prefix'
						: decision.reason
				);
			return response;
		});
	}

	committed(options: SyncLaneCommitOptions<Connection>): Promise<void> {
		return this.enqueue(() => this.#pumpCommit(options));
	}

	async #pumpCommit(options: SyncLaneCommitOptions<Connection>): Promise<void> {
		const writer = options.resolveWriter();
		const affected = this.registry.affectedStates(options.changes);
		const subscriptions = affected.map(({ subscription }) => subscription);

		let response: SyncAdvanceResponse;
		try {
			response = await options.advance({
				changes: options.changes,
				subscriptions,
				pending: writer === undefined ? [] : options.pending,
				...(writer === undefined ? {} : { writer: options.writerProof(writer) })
			});
		} catch (cause) {
			for (const { attachments } of affected)
				for (const { connection } of attachments)
					this.detach(connection.id, this.#guestFailure);
			if (writer !== undefined) this.detach(writer.id, this.#guestFailure);
			throw cause;
		}
		if (writer === undefined && response.outcomes.length > 0)
			return this.#failCommit(affected, writer, 'writer outcomes require an owning connection');

		const expected = new Set(subscriptions.map(({ subId }) => subId));
		const updates = new Map<string, SyncAdvanceUpdate>();
		const resets = new Map<string, SyncResetReason>();
		for (const update of response.updates) {
			if (
				!expected.has(update.subId) ||
				updates.has(update.subId) ||
				!this.registry.validateAdvance(update)
			)
				return this.#failCommit(affected, writer, 'invalid sync version advance');
			updates.set(update.subId, update);
		}
		for (const reset of response.resets) {
			if (!expected.has(reset.subId) || updates.has(reset.subId) || resets.has(reset.subId))
				return this.#failCommit(affected, writer, 'invalid sync reset');
			resets.set(reset.subId, reset.reason);
		}
		const frames = new Map<Connection, MutableSyncApplyFrame>();
		const frameFor = (connection: Connection): MutableSyncApplyFrame => {
			let frame = frames.get(connection);
			if (frame === undefined) {
				frame = { updates: [], resets: [], outcomes: [] };
				frames.set(connection, frame);
			}
			return frame;
		};

		for (const update of updates.values()) {
			const details = this.registry.details(update.subId);
			if (details === undefined) continue;
			const deltas = new Map(update.deltas.map(({ loadedPrefix, delta }) => [loadedPrefix, delta]));
			for (const { connection, queryKey, loadedPrefix } of details.attachments) {
				const delta = deltas.get(loadedPrefix);
				if (delta === undefined)
					return this.#failCommit(affected, writer, 'missing viewer prefix delta');
				frameFor(connection).updates.push({
					queryKey,
					fromVersion: update.fromVersion,
					toVersion: update.toVersion,
					delta
				});
			}
		}
		for (const [subId, reason] of resets) {
			const details = this.registry.details(subId);
			if (details === undefined) continue;
			for (const { connection, queryKey } of details.attachments)
				frameFor(connection).resets.push({ queryKey, reason });
		}
		if (writer !== undefined) frameFor(writer).outcomes.push(...response.outcomes);

		const failed = new Set<Connection>();
		for (const [connection, frame] of frames) {
			if (!this.registry.frameFits(frame) || !connection.sink.writable()) {
				failed.add(connection);
				continue;
			}
			try {
				if (!this.registry.emit(connection, frame)) failed.add(connection);
			} catch {
				failed.add(connection);
			}
		}
		for (const connection of failed) this.detach(connection.id, this.#guestFailure);

		for (const subId of resets.keys()) this.registry.reset(subId);
		for (const update of updates.values()) {
			if (this.registry.details(update.subId) !== undefined && !this.registry.commitAdvance(update))
				return this.#failCommit(affected, writer, 'sync version changed during publication');
		}
		if (writer !== undefined && failed.has(writer))
			throw new Error('writer sync frame was not accepted');
	}

	#resetExtension(
		connection: Connection,
		queryKey: string,
		reason: SyncResetReason
	): never {
		const subId = connection.subscriptions.get(queryKey);
		const frame = { updates: [], resets: [{ queryKey, reason }], outcomes: [] } satisfies SyncApplyFrame;
		if (!this.registry.emit(connection, frame)) this.detach(connection.id, this.#guestFailure);
		else if (subId !== undefined) this.registry.release(connection, [queryKey]);
		throw new Error(`sync prefix extension reset: ${reason}`);
	}

	#fail(connection: Connection, message: string): never {
		this.detach(connection.id, this.#guestFailure);
		throw new Error(message);
	}

	#failCommit(
		affected: ReadonlyArray<SyncAffectedState<Connection>>,
		writer: Connection | undefined,
		message: string
	): never {
		for (const { attachments } of affected)
			for (const { connection } of attachments)
				this.detach(connection.id, this.#guestFailure);
		if (writer !== undefined) this.detach(writer.id, this.#guestFailure);
		throw new Error(message);
	}
}
