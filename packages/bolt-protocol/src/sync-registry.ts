import {
	MAX_SYNC_HELD_IDS,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncAdvanceSubscription,
	type SyncApplyFrame,
	type SyncApplyPatch,
	type SyncConnectEvaluation,
	type SyncConnectEvaluationResult,
	type SyncConnectRequest,
	type SyncConnectResponse,
	type SyncCursor,
	type SyncHeldCoordinate,
	type SyncQueryInput,
	type SyncSubEntry
} from './sync.js';

/**
 * The registry and pump core both hosts run (RFC/live-query-sync.md §1.2, §1.8).
 *
 * It hashes and files opaque guest facts, targets by dependency collection, and fans frames. It
 * never imports Bolt, resolves a subject, evaluates a predicate, masks a row, or constructs a
 * patch — a host that can evaluate is a host that will.
 *
 * A host supplies its connection type, disconnect vocabulary, digest primitive, and guest bridge;
 * it does not supply a second registry or serial-pump implementation.
 */

/** One query a connection holds, and the digest its answer last settled on. */
type SyncQueryState = {
	input: SyncQueryInput;
	digest: string;
};

/**
 * The part of a host connection this core reads and writes.
 *
 * Deliberately narrower than either host's connection: the registry files keys and learns whether
 * a frame was accepted, and is told nothing about scopes, releases or why a stream ended.
 */
export interface SyncRegistryConnection {
	readonly credential: string;
	readonly sink: {
		readonly writable: () => boolean;
		readonly write: (frame: SyncApplyFrame) => boolean;
	};
	readonly subscriptions: Map<string, string>;
	readonly queries: Map<string, SyncQueryState>;
	readonly dirty: Set<string>;
	closed: boolean;
	refreshing: boolean;
	lastHead?: SyncCursor | undefined;
}

/**
 * One connection's hold on a shared subscription.
 *
 * `authority` is the opaque per-attachment discriminator the guest issued with the registration.
 * The core never interprets it and no host needs a concept for it — it rides in on `SyncSubEntry`
 * and out on `SyncAdvanceSubscription`.
 */
type SyncAttachment<Connection> = Readonly<{
	readonly connection: Connection;
	readonly key: string;
	readonly authority?: string | undefined;
}>;

/** One woken subscription with the state a pump needs to fan its answer. */
type SyncAffectedState<Connection> = Readonly<{
	readonly subscription: SyncAdvanceSubscription;
	readonly policyDependencies: ReadonlySet<string>;
	readonly attachments: ReadonlyArray<SyncAttachment<Connection>>;
}>;

type SubState<Connection> = {
	readonly subId: string;
	readonly input: SyncQueryInput;
	policyHash: string;
	dependencies: ReadonlyArray<string>;
	policyDependencies: ReadonlyArray<string>;
	routing: NonNullable<SyncSubEntry['routing']>;
	heldIds: ReadonlyArray<string>;
	heldCoordinates?: ReadonlyArray<SyncHeldCoordinate> | undefined;
	digestOnly: boolean;
	digest: string;
	readonly attached: Map<Connection, Map<string, string | undefined>>;
};

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
const sameCoordinates = (
	left: ReadonlyArray<SyncHeldCoordinate> | undefined,
	right: ReadonlyArray<SyncHeldCoordinate> | undefined
): boolean =>
	left === undefined || right === undefined ? left === right : canonical(left) === canonical(right);

const routingKey = (field: string, value: unknown): string => `${field}\0${canonical(value)}`;
const normalizedRouting = (
	routing: SyncSubEntry['routing']
): NonNullable<SyncSubEntry['routing']> =>
	(routing ?? [])
		.map(({ field, values }) => ({
			field,
			values: [...new Map(values.map((value) => [canonical(value), value])).values()].sort((a, b) =>
				canonical(a).localeCompare(canonical(b))
			)
		}))
		.filter(({ values }) => values.length > 0)
		.sort((left, right) => left.field.localeCompare(right.field));
const sameRouting = (
	left: NonNullable<SyncSubEntry['routing']>,
	right: NonNullable<SyncSubEntry['routing']>
): boolean => canonical(left) === canonical(right);

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(values)].sort();

/**
 * The ceiling is a host promise, not a guest guess: past MAX_SYNC_HELD_IDS a SubState runs
 * digest-only — no id list is held or shipped, so no positional patch and no rank probe is ever
 * issued and every wake for it is answered by a full re-resolve.
 */
const ceiling = (state: {
	readonly heldIds: ReadonlyArray<string>;
	readonly heldCoordinates?: ReadonlyArray<SyncHeldCoordinate> | undefined;
	readonly digestOnly: boolean;
}): {
	heldIds: ReadonlyArray<string>;
	heldCoordinates?: ReadonlyArray<SyncHeldCoordinate> | undefined;
	digestOnly: boolean;
} => {
	if (state.digestOnly || state.heldIds.length > MAX_SYNC_HELD_IDS)
		return { heldIds: [], heldCoordinates: [], digestOnly: true };
	const coordinates = state.heldCoordinates;
	const aligned =
		coordinates !== undefined &&
		coordinates.length === state.heldIds.length &&
		coordinates.every(({ id }, index) => id === state.heldIds[index]);
	return {
		heldIds: [...state.heldIds],
		...(aligned ? { heldCoordinates: [...coordinates] } : {}),
		digestOnly: false
	};
};

type SyncRegistryOptions<Connection> = Readonly<{
	/**
	 * Lowercase hex SHA-256 of a UTF-8 string.
	 *
	 * Injected rather than imported so this package keeps no runtime dependency: it is loaded in
	 * the browser through the same barrel the wire schemas are.
	 */
	readonly hash: (value: string) => string;
	/** Names the keys whose shared state retired under a connection and now owe a full answer. */
	readonly invalidate: (connection: Connection, keys: ReadonlyArray<string>) => void;
}>;

/**
 * Two levels — shared query state keyed by `(policyHash, queryHash)`, per-connection attachment —
 * indexed by dependency collection.
 */
export class SyncRegistry<Connection extends SyncRegistryConnection> {
	readonly #subscriptions = new Map<string, SubState<Connection>>();
	readonly #byCollection = new Map<string, Set<string>>();
	readonly #hash: (value: string) => string;
	readonly #invalidate: (connection: Connection, keys: ReadonlyArray<string>) => void;

	constructor(options: SyncRegistryOptions<Connection>) {
		this.#hash = options.hash;
		this.#invalidate = options.invalidate;
	}

	/**
	 * Host-local by design: no client and no guest has to reproduce this value.
	 *
	 * Object key order is erased except inside `orderBy`, where insertion order states SQL term
	 * precedence. Array order is always semantic.
	 */
	queryHash(input: SyncQueryInput): string {
		return this.#hash(canonical(input));
	}

	attach(connection: Connection, queries: ReadonlyArray<SyncSubEntry>): void {
		if (connection.closed) return;
		const seen = new Set<string>();
		for (const query of queries) {
			if (seen.has(query.key)) throw new Error(`duplicate sync query key ${query.key}`);
			seen.add(query.key);
			this.release(connection, [query.key]);

			const queryHash = this.queryHash(query.input);
			const subId = this.#hash(`${query.policyHash}\u0000${queryHash}`);
			const limited = ceiling(query);
			let state = this.#subscriptions.get(subId);
			const dependencies = sortedUnique(query.dependencies);
			const policyDependencies = sortedUnique(query.policyDependencies);
			const routing = normalizedRouting(query.routing);
			if (
				state !== undefined &&
				(state.digest !== query.digest ||
					state.digestOnly !== limited.digestOnly ||
					!sameStrings(state.heldIds, limited.heldIds) ||
					!sameCoordinates(state.heldCoordinates, limited.heldCoordinates) ||
					!sameStrings(state.dependencies, dependencies) ||
					!sameStrings(state.policyDependencies, policyDependencies) ||
					!sameRouting(state.routing, routing))
			) {
				// Soft state: a registration that disagrees with what is held retires the shared state
				// and sends everyone attached a full answer on their next drain.
				this.#retire(state, true);
				state = undefined;
			}
			if (state === undefined) {
				state = {
					subId,
					input: query.input,
					policyHash: query.policyHash,
					dependencies,
					policyDependencies,
					routing,
					...limited,
					digest: query.digest,
					attached: new Map()
				};
				this.#subscriptions.set(subId, state);
				this.#index(state);
			}
			let attachments = state.attached.get(connection);
			if (attachments === undefined) {
				attachments = new Map();
				state.attached.set(connection, attachments);
			}
			attachments.set(query.key, query.impersonatedTeam);
			connection.subscriptions.set(query.key, subId);
			connection.dirty.delete(query.key);
		}
	}

	release(connection: Connection, keys: ReadonlyArray<string>): void {
		for (const key of new Set(keys)) {
			const subId = connection.subscriptions.get(key);
			if (subId === undefined) continue;
			connection.subscriptions.delete(key);
			const state = this.#subscriptions.get(subId);
			const attachments = state?.attached.get(connection);
			attachments?.delete(key);
			if (attachments?.size === 0) state?.attached.delete(connection);
			if (state !== undefined && state.attached.size === 0) this.#retire(state, false);
		}
	}

	detach(connection: Connection): void {
		this.release(connection, [...connection.subscriptions.keys()]);
	}

	/**
	 * Drops a backpressured connection's chain: every query it holds owes a full answer, and the
	 * shared state it was riding is released so no positional patch is computed against it (§2.5).
	 */
	collapse(connection: Connection): void {
		if (connection.closed) return;
		for (const key of connection.queries.keys()) connection.dirty.add(key);
		this.detach(connection);
	}

	affectedStates(
		changes: SyncAdvanceRequest['changes']
	): ReadonlyArray<SyncAffectedState<Connection>> {
		const ids = new Set<string>();
		for (const change of changes) {
			for (const subId of this.#byCollection.get(change.collection) ?? []) {
				const state = this.#subscriptions.get(subId);
				if (state === undefined) continue;
				if (
					state.policyDependencies.includes(change.collection) ||
					state.input.collection !== change.collection ||
					state.heldIds.includes(change.recordId) ||
					state.routing.length === 0 ||
					(change.routing?.length ?? 0) === 0
				) {
					ids.add(subId);
					continue;
				}
				const changed = new Set(
					(change.routing ?? []).map(({ field, value }) => routingKey(field, value))
				);
				let contradicted = false;
				for (const constraint of state.routing) {
					const carriesField = (change.routing ?? []).some(
						(candidate) => candidate.field === constraint.field
					);
					if (
						carriesField &&
						!constraint.values.some((value) => changed.has(routingKey(constraint.field, value)))
					) {
						contradicted = true;
						break;
					}
				}
				if (!contradicted) ids.add(subId);
			}
		}
		return [...ids].sort().flatMap((subId): ReadonlyArray<SyncAffectedState<Connection>> => {
			const state = this.#subscriptions.get(subId);
			if (state === undefined) return [];
			const attachments = this.#attachmentsOf(state);
			const representative = attachments[0];
			if (representative === undefined) {
				this.#retire(state, false);
				return [];
			}
			return [
				{
					subscription: this.#subscription(state, representative),
					policyDependencies: new Set(state.policyDependencies),
					attachments
				}
			];
		});
	}

	commit(
		subId: string,
		next: Readonly<{
			digest: string;
			heldIds: ReadonlyArray<string>;
			heldCoordinates?: ReadonlyArray<SyncHeldCoordinate> | undefined;
			digestOnly: boolean;
			policyHash: string;
			dependencies: ReadonlyArray<string>;
			policyDependencies: ReadonlyArray<string>;
		}>
	): void {
		const state = this.#subscriptions.get(subId);
		if (state === undefined) return;
		if (state.policyHash !== next.policyHash) {
			this.#retire(state, true);
			return;
		}
		const limited = ceiling(next);
		this.#unindex(state);
		state.digest = next.digest;
		state.heldIds = limited.heldIds;
		state.heldCoordinates = limited.heldCoordinates;
		state.digestOnly = limited.digestOnly;
		state.dependencies = sortedUnique(next.dependencies);
		state.policyDependencies = sortedUnique(next.policyDependencies);
		this.#index(state);
	}

	emit(connection: Connection, frame: SyncApplyFrame): boolean {
		return !connection.closed && connection.sink.writable() && connection.sink.write(frame);
	}

	details(subId: string):
		| Readonly<{
				subscription: SyncAdvanceSubscription;
				attachments: ReadonlyArray<SyncAttachment<Connection>>;
		  }>
		| undefined {
		const state = this.#subscriptions.get(subId);
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

	#attachmentsOf(state: SubState<Connection>): ReadonlyArray<SyncAttachment<Connection>> {
		return [...state.attached].flatMap(([connection, entries]) =>
			[...entries].map(([key, authority]) => ({
				connection,
				key,
				...(authority === undefined ? {} : { authority })
			}))
		);
	}

	#subscription(
		state: SubState<Connection>,
		representative: SyncAttachment<Connection>
	): SyncAdvanceSubscription {
		return {
			subId: state.subId,
			key: representative.key,
			input: state.input,
			credential: representative.connection.credential,
			...(representative.authority === undefined
				? {}
				: { impersonatedTeam: representative.authority }),
			heldIds: [...state.heldIds],
			...(state.heldCoordinates === undefined
				? {}
				: { heldCoordinates: [...state.heldCoordinates] }),
			digestOnly: state.digestOnly,
			digest: state.digest,
			policyHash: state.policyHash
		};
	}

	#retire(state: SubState<Connection>, invalidate: boolean): void {
		this.#subscriptions.delete(state.subId);
		this.#unindex(state);
		for (const [connection, attachments] of state.attached) {
			const keys = [...attachments.keys()];
			for (const key of keys) connection.subscriptions.delete(key);
			if (invalidate && keys.length > 0) this.#invalidate(connection, keys);
		}
		state.attached.clear();
	}

	#index(state: SubState<Connection>): void {
		for (const collection of state.dependencies) {
			let subscriptions = this.#byCollection.get(collection);
			if (subscriptions === undefined) {
				subscriptions = new Set();
				this.#byCollection.set(collection, subscriptions);
			}
			subscriptions.add(state.subId);
		}
	}

	#unindex(state: SubState<Connection>): void {
		for (const collection of state.dependencies) {
			const subscriptions = this.#byCollection.get(collection);
			subscriptions?.delete(state.subId);
			if (subscriptions?.size === 0) this.#byCollection.delete(collection);
		}
	}
}

/** Projects the guest's registration evaluation to what the client is entitled to see. */
const syncClientResponse = (evaluation: SyncConnectEvaluation): SyncConnectResponse => ({
	head: evaluation.head,
	results: evaluation.results.map(
		(result: SyncConnectEvaluationResult): SyncConnectResponse['results'][number] =>
			result.changed
				? {
						key: result.key,
						digest: result.digest,
						digestOnly: result.digestOnly,
						changed: true,
						answer: result.answer
					}
				: {
						key: result.key,
						digest: result.digest,
						digestOnly: result.digestOnly,
						changed: false
					}
	),
	outcomes: evaluation.outcomes
});

const laterSyncHead = (left: SyncCursor, right: SyncCursor): SyncCursor =>
	left.sequence >= right.sequence ? left : right;

/** The keys a connection owes an answer for, in a stable order. */
const syncDirtyKeys = (connection: SyncRegistryConnection): ReadonlyArray<string> =>
	[...connection.dirty].filter((key) => connection.queries.has(key)).sort();

const syncHandshakeQueries = (
	connection: SyncRegistryConnection,
	keys: ReadonlyArray<string>
): SyncConnectRequest['queries'] =>
	keys.flatMap((key): SyncConnectRequest['queries'] => {
		const query = connection.queries.get(key);
		return query === undefined ? [] : [{ key, input: query.input }];
	});

/**
 * One full-answer patch per requested key, or `undefined` when the guest did not answer one.
 *
 * A collapsed connection is re-served by a handshake, and a handshake that comes back
 * `changed: false` for a key whose chain the host already dropped cannot be reconciled — the caller
 * treats that as a guest failure rather than shipping a patch chained off a digest nobody holds.
 */
const syncFullAnswerPatches = (
	connection: SyncRegistryConnection,
	keys: ReadonlyArray<string>,
	results: ReadonlyArray<SyncConnectEvaluationResult>
): ReadonlyArray<SyncApplyPatch> | undefined => {
	const answered = new Map(results.map((result) => [result.key, result]));
	const patches: Array<SyncApplyPatch> = [];
	for (const key of keys) {
		const prior = connection.queries.get(key);
		const result = answered.get(key);
		if (prior === undefined || result === undefined || !result.changed) return undefined;
		patches.push({
			key,
			from: prior.digest,
			to: result.digest,
			patch: { op: 'answer', answer: result.answer }
		});
	}
	return patches;
};

/** Files the digests a handshake settled on, so the next patch chains off what the client holds. */
const syncRecordAnswers = (
	connection: SyncRegistryConnection,
	results: ReadonlyArray<SyncConnectEvaluationResult>
): void => {
	for (const result of results) {
		const current = connection.queries.get(result.key);
		if (current !== undefined)
			connection.queries.set(result.key, { input: current.input, digest: result.digest });
		connection.dirty.delete(result.key);
	}
};

/**
 * The serial, connection-owning half of a live-sync lane.
 *
 * Hosts choose how a connection is found and authenticated, how its guest is reached, and when a
 * lane is retired. Once those facts are supplied, the ordering-sensitive handshake, commit and
 * collapsed-refresh sequence is identical for every host and lives here exactly once.
 */
type SyncConnectionLaneOptions<
	Connection extends SyncRegistryConnection & Readonly<{ id: string }>,
	CloseReason
> = Readonly<{
	readonly hash: (value: string) => string;
	readonly invalidate: (connection: Connection, keys: ReadonlyArray<string>) => void;
	readonly connect: (
		connection: Connection,
		request: SyncConnectRequest
	) => Promise<SyncConnectEvaluation>;
	readonly guestFailure: CloseReason;
	readonly close: (connection: Connection, reason: CloseReason) => void;
	/** A temporarily unbound host leaves dirty work queued instead of disconnecting streams. */
	readonly refreshable?: () => boolean;
}>;

type SyncLaneConnectOptions<Connection extends SyncRegistryConnection & Readonly<{ id: string }>> =
	Readonly<{
		readonly request: SyncConnectRequest;
		/** Runs inside the lane, so close/authenticate races cannot file a stale registration. */
		readonly resolve: () => Connection | undefined;
		readonly unavailable: () => Error;
		/** Lets a host ask every connection it owns to drain after a successful registration. */
		readonly refresh: () => void;
	}>;

type SyncLaneCommitOptions<Connection extends SyncRegistryConnection & Readonly<{ id: string }>> =
	Readonly<{
		readonly changes: SyncAdvanceRequest['changes'];
		readonly pending: SyncAdvanceRequest['pending'];
		/** Runs inside the lane; a just-detached writer never receives a stale outcome. */
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
	readonly #guestFailure: CloseReason;
	readonly #onClose: SyncConnectionLaneOptions<Connection, CloseReason>['close'];
	readonly #refreshable: () => boolean;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: SyncConnectionLaneOptions<Connection, CloseReason>) {
		this.registry = new SyncRegistry({ hash: options.hash, invalidate: options.invalidate });
		this.#connect = options.connect;
		this.#guestFailure = options.guestFailure;
		this.#onClose = options.close;
		this.#refreshable = options.refreshable ?? (() => true);
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Prevents new work while allowing callers to await the already-running operation. */
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
		connection.dirty.clear();
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
			this.registry.release(connection, options.request.released);
			for (const key of options.request.released) {
				connection.queries.delete(key);
				connection.dirty.delete(key);
			}
			const response = await this.#connect(connection, options.request);
			if (connection.closed || this.#closed) throw options.unavailable();
			this.registry.attach(connection, response.results);
			connection.lastHead = response.head;
			for (const result of response.results)
				connection.queries.set(result.key, { input: result.input, digest: result.digest });
			options.refresh();
			return syncClientResponse(response);
		});
	}

	committed(options: SyncLaneCommitOptions<Connection>): Promise<void> {
		return this.enqueue(() =>
			pumpCommit(
				this.registry,
				options.changes,
				options.pending,
				options.resolveWriter(),
				options.writerProof,
				options.advance,
				this.#connect,
				() => this.#closed,
				(connection) => this.detach(connection.id, this.#guestFailure),
				(connection) => this.refresh(connection)
			)
		);
	}

	/** Schedules one collapsed/full-answer drain behind the lane's committed work. */
	refresh(connection: Connection): void {
		if (
			this.#closed ||
			!this.#refreshable() ||
			connection.closed ||
			connection.dirty.size === 0 ||
			!connection.sink.writable()
		)
			return;
		void this.enqueue(() =>
			refreshConnection(
				this.registry,
				connection,
				(request) => this.#connect(connection, request),
				() => this.#closed,
				(target) => this.detach(target.id, this.#guestFailure)
			)
		).catch(() => undefined);
	}
}

/**
 * Advances every shared subscription affected by one committed write.
 *
 * Hosts own lanes, writer authentication, scopes, guest transport, disconnects and refresh
 * scheduling. This core owns the ordering-sensitive registry algorithm they must share: policy
 * drift, base fences, fanout, one writer outcome frame, refusal collapse and full-answer recovery.
 */
const pumpCommit = async <Connection extends SyncRegistryConnection>(
	registry: SyncRegistry<Connection>,
	changes: SyncAdvanceRequest['changes'],
	pending: SyncAdvanceRequest['pending'],
	writer: Connection | undefined,
	writerProof: (connection: Connection) => NonNullable<SyncAdvanceRequest['writer']>,
	advance: (request: SyncAdvanceRequest) => Promise<SyncAdvanceResponse>,
	connect: (connection: Connection, request: SyncConnectRequest) => Promise<SyncConnectEvaluation>,
	abandoned: () => boolean,
	onGuestFailure: (connection: Connection) => void,
	refresh: (connection: Connection) => void
): Promise<void> => {
	const collections: ReadonlySet<string> = new Set(
		changes.map((change): string => change.collection)
	);
	const affected = registry.affectedStates(changes);
	// A write to a policy or identity collection re-authenticates every attached credential
	// (§2.2.3): the affected connections drop their chain and refresh under the new subject.
	const policyAffected = affected.filter(({ policyDependencies }) =>
		[...collections].some((collection) => policyDependencies.has(collection))
	);
	const policySubIds = new Set(policyAffected.map(({ subscription }) => subscription.subId));
	const ordinary = affected
		.filter(({ subscription }) => !policySubIds.has(subscription.subId))
		.map(({ subscription }) => subscription);

	const policyConnections = new Set(
		policyAffected.flatMap(({ attachments }) => attachments.map(({ connection }) => connection))
	);
	for (const connection of policyConnections) {
		for (const state of policyAffected) {
			for (const attachment of state.attachments)
				if (attachment.connection === connection) connection.dirty.add(attachment.key);
		}
		registry.release(connection, [...connection.dirty]);
	}

	let response: SyncAdvanceResponse;
	try {
		response = await advance({
			changes,
			pending: writer === undefined ? [] : pending,
			subscriptions: ordinary,
			...(writer === undefined ? {} : { writer: writerProof(writer) })
		});
	} catch (cause) {
		for (const state of affected)
			for (const { connection } of state.attachments) onGuestFailure(connection);
		throw cause;
	}

	const patchesByConnection = new Map<Connection, Array<SyncApplyPatch>>();
	const headsByConnection = new Map<Connection, SyncCursor>();
	const collapsed = new Set<Connection>();
	for (const refusal of response.refused) {
		const refused = registry.details(refusal.subId)?.attachments[0];
		if (refused !== undefined) onGuestFailure(refused.connection);
	}
	for (const update of response.updates) {
		const current = registry.details(update.subId);
		if (current === undefined) continue;
		const { subscription, attachments } = current;
		if (subscription.digest !== update.from || subscription.policyHash !== update.policyHash) {
			// The guest answered against a base the registry already moved past: the chain is refused
			// and every attached connection collapses to a full answer.
			for (const { connection } of attachments) {
				registry.collapse(connection);
				collapsed.add(connection);
			}
			continue;
		}
		for (const { connection, key } of attachments) {
			let patches = patchesByConnection.get(connection);
			if (patches === undefined) {
				patches = [];
				patchesByConnection.set(connection, patches);
			}
			patches.push({ key, from: update.from, to: update.to, patch: update.patch });
			headsByConnection.set(connection, response.head);
		}
		registry.commit(update.subId, {
			digest: update.to,
			heldIds: update.heldIds,
			heldCoordinates: update.heldCoordinates,
			digestOnly: update.digestOnly,
			policyHash: update.policyHash,
			dependencies: update.dependencies,
			policyDependencies: update.policyDependencies
		});
	}

	for (const connection of policyConnections) {
		if (connection.closed || !connection.sink.writable()) continue;
		const keys = syncDirtyKeys(connection);
		if (keys.length === 0) continue;
		try {
			const refreshed = await connect(connection, {
				...(connection.lastHead === undefined ? {} : { head: connection.lastHead }),
				queries: syncHandshakeQueries(connection, keys),
				released: [],
				pending: []
			});
			if (connection.closed || abandoned()) continue;
			const answers = syncFullAnswerPatches(connection, keys, refreshed.results);
			if (answers === undefined)
				throw new Error('sync.connect did not return a full answer for every drifted key');
			patchesByConnection.set(connection, [
				...(patchesByConnection.get(connection) ?? []),
				...answers
			]);
			registry.attach(connection, refreshed.results);
			headsByConnection.set(connection, laterSyncHead(response.head, refreshed.head));
		} catch {
			onGuestFailure(connection);
		}
	}

	// One commit, one frame per connection, the writer's outcome riding it (§3.2 I3).
	const recipients = new Set(patchesByConnection.keys());
	if (writer !== undefined) recipients.add(writer);
	for (const connection of recipients) {
		if (connection.closed) continue;
		const patches = patchesByConnection.get(connection) ?? [];
		const outcomes = connection === writer ? response.outcomes : [];
		const head = headsByConnection.get(connection) ?? response.head;
		if (!registry.emit(connection, { head, patches, outcomes })) {
			registry.collapse(connection);
			collapsed.add(connection);
			continue;
		}
		connection.lastHead = head;
		for (const patch of patches) {
			const query = connection.queries.get(patch.key);
			if (query !== undefined)
				connection.queries.set(patch.key, { input: query.input, digest: patch.to });
			connection.dirty.delete(patch.key);
		}
	}
	for (const connection of recipients) refresh(connection);
	// A collapsed connection holds no registry state, so no later commit reaches it: its one full
	// answer is owed here (§2.5) or it is never sent.
	for (const connection of collapsed) refresh(connection);
};

/**
 * Serves one collapsed connection its single full answer (§2.5).
 *
 * Re-entrant by contract rather than by lock: `refreshing` is the flag, and the caller's lane is
 * what keeps this behind the commits it must not overtake.
 */
const refreshConnection = async <Connection extends SyncRegistryConnection>(
	registry: SyncRegistry<Connection>,
	connection: Connection,
	connect: (request: SyncConnectRequest) => Promise<SyncConnectEvaluation>,
	abandoned: () => boolean,
	onGuestFailure: (connection: Connection) => void
): Promise<void> => {
	if (
		connection.closed ||
		connection.refreshing ||
		connection.dirty.size === 0 ||
		!connection.sink.writable()
	)
		return;
	connection.refreshing = true;
	const keys = syncDirtyKeys(connection);
	try {
		const queries = syncHandshakeQueries(connection, keys);
		if (queries.length === 0) return;
		const evaluation = await connect({
			...(connection.lastHead === undefined ? {} : { head: connection.lastHead }),
			queries,
			released: [],
			pending: []
		});
		if (connection.closed || abandoned()) return;
		const patches = syncFullAnswerPatches(connection, keys, evaluation.results);
		if (patches === undefined) {
			onGuestFailure(connection);
			return;
		}
		registry.attach(connection, evaluation.results);
		if (
			!registry.emit(connection, {
				head: evaluation.head,
				patches,
				outcomes: evaluation.outcomes
			})
		) {
			registry.collapse(connection);
			return;
		}
		connection.lastHead = evaluation.head;
		syncRecordAnswers(connection, evaluation.results);
	} catch {
		onGuestFailure(connection);
	} finally {
		connection.refreshing = false;
	}
};
