/**
 * The complete identity of one browser replica.
 *
 * A tenant and environment are not enough: two people using the same browser profile, or one person
 * moving between operator and preview authority, must never share rows, cursors, cache answers, lock
 * names or wake-up channels. `formatVersion` is independent of the tenant schema fingerprint; it is
 * bumped when Bolt changes the *replica's* durable layout or wire interpretation.
 */
export type ReplicaPartitionIdentity = Readonly<{
	readonly tenant: string;
	readonly environment: string;
	/** A SHA-256 fingerprint of the stable principal identifier. Never a bearer credential. */
	readonly principal: string;
	/** The authority-shaped browser scope, for example `operator` or `team:field`. */
	readonly authority: string;
	readonly formatVersion: number;
}>;

export const REPLICA_FORMAT_VERSION = 1;

const nonEmpty = (label: string, value: string): string => {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`Replica partition ${label} cannot be empty`);
	return normalized;
};

/**
 * A collision-free, filesystem-safe serialization of the full partition identity.
 *
 * Each component is encoded independently and length-prefixed. Replacing punctuation with `_` made
 * `a/b` and `a?b` the same database; joining on `::` made delimiter-bearing identities ambiguous.
 * This representation is used verbatim only inside browser-local names.
 */
export const replicaPartitionKey = (identity: ReplicaPartitionIdentity): string => {
	const components = [
		['tenant', nonEmpty('tenant', identity.tenant)],
		['environment', nonEmpty('environment', identity.environment)],
		['principal', nonEmpty('principal', identity.principal)],
		['authority', nonEmpty('authority', identity.authority)],
		['formatVersion', String(identity.formatVersion)]
	] as const;
	if (!Number.isSafeInteger(identity.formatVersion) || identity.formatVersion < 1)
		throw new Error('Replica partition formatVersion must be a positive safe integer');
	return (
		components
			.map(
				([label, value]) =>
					`${label.length.toString(36)}.${label}.${value.length.toString(36)}.${value}`
			)
			// `encodeURIComponent` deliberately leaves `~` alone. Escape it as well because `~` is the
			// component delimiter; otherwise a value containing the delimiter would make this serialization
			// ambiguous to a future parser even though browser storage itself accepts the name.
			.map((component) => encodeURIComponent(component).replaceAll('~', '%7E'))
			.join('~')
	);
};

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Makes a stable principal safe to place in storage paths, lock names and channel names. */
export const fingerprintReplicaPrincipal = async (
	principal: string
): Promise<Readonly<{ fingerprint: string; source: 'principal' }>> => {
	const value = nonEmpty('principal', principal);
	if (globalThis.crypto?.subtle === undefined)
		throw new Error('Replica partitioning requires WebCrypto SHA-256');
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`principal\u0000${value}`)
	);
	return { fingerprint: hex(digest), source: 'principal' };
};

type WebLockLike = Readonly<{ readonly name: string }>;

/** The small Web Locks surface used here, kept injectable for deterministic tests. */
export type WebLockManagerLike = Readonly<{
	request: <Value>(
		name: string,
		options: Readonly<{
			readonly mode: 'exclusive';
			readonly ifAvailable?: boolean;
			readonly signal?: AbortSignal;
		}>,
		callback: (lock: WebLockLike | null) => Value | PromiseLike<Value>
	) => Promise<Value>;
}>;

export type ReplicationLeadership = Readonly<{
	readonly name: string;
	/** Resolves after the non-blocking first election: true for leader, false for follower. */
	readonly ready: Promise<boolean>;
	readonly leader: () => boolean;
	/** A policy/runtime rejection, distinct from the ordinary follower result `ready === false`. */
	readonly failed: () => boolean;
	readonly onChange: (callback: (leader: boolean) => void) => () => void;
	readonly stop: () => void;
}>;

export const replicationLockName = (partitionKey: string): string =>
	`bolt-replication:${nonEmpty('key', partitionKey)}`;

/**
 * Elects exactly one replication owner for one complete partition.
 *
 * The first request is `ifAvailable` so a follower can attach to the shared database immediately.
 * It then queues a normal exclusive request; when the current leader's document dies, the browser
 * transfers the lock and this object announces the promotion. No BroadcastChannel participates in
 * the election. Broadcasts are wake-ups only; callers must re-read durable cursor/barrier state after
 * every promotion or wake.
 */
export const openReplicationLeadership = (
	partitionKey: string,
	locks: WebLockManagerLike
): ReplicationLeadership => {
	const name = replicationLockName(partitionKey);
	const callbacks = new Set<(leader: boolean) => void>();
	const abort = new AbortController();
	let active = true;
	let leading = false;
	let failure = false;
	let release: () => void = () => undefined;
	let resolveReady: (leader: boolean) => void = () => undefined;
	let readySettled = false;
	const ready = new Promise<boolean>((resolve) => {
		resolveReady = resolve;
	});

	const settleReady = (leader: boolean): void => {
		if (readySettled) return;
		readySettled = true;
		resolveReady(leader);
	};
	const setLeading = (next: boolean): void => {
		if (leading === next) return;
		leading = next;
		for (const callback of callbacks) {
			try {
				callback(next);
			} catch {
				// An observer cannot surrender or poison the browser-owned lock.
			}
		}
	};
	const hold = async (lock: WebLockLike | null): Promise<boolean> => {
		if (lock === null || !active) {
			settleReady(false);
			return false;
		}
		settleReady(true);
		setLeading(true);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		setLeading(false);
		return true;
	};
	const acquire = async (): Promise<void> => {
		try {
			// No `signal` on this one. Web Locks rejects `signal` combined with `ifAvailable`
			// (`NotSupportedError`), and that rejection lands in the catch below, which reports a failed
			// election — so every document became a server-only replica in every browser. The option
			// bought nothing regardless: an `ifAvailable` request settles immediately, granting the lock
			// or yielding null, so there is no wait for a signal to abort.
			const won = await locks.request(name, { mode: 'exclusive', ifAvailable: true }, hold);
			if (won || !active) return;
			await locks.request(name, { mode: 'exclusive', signal: abort.signal }, hold);
		} catch (cause) {
			settleReady(false);
			if (active) {
				failure = true;
				active = false;
				setLeading(false);
				// A lock manager can reject for policy or unavailable storage. The runtime observes a follower
				// and remains server-authoritative; surfacing an unhandled rejection would break that fallback.
				void cause;
			}
		}
	};
	void acquire();

	return {
		name,
		ready,
		leader: () => leading,
		failed: () => failure,
		onChange: (callback) => {
			callbacks.add(callback);
			return () => callbacks.delete(callback);
		},
		stop: () => {
			if (!active) return;
			active = false;
			abort.abort();
			release();
			setLeading(false);
			callbacks.clear();
			settleReady(false);
		}
	};
};
