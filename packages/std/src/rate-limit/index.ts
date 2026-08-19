import { Effect } from 'effect';

/**
 * The one fixed-window counter, and the one way a bucket is named.
 *
 * It lives in `std` for the reason the secret cipher does: more than one thing has to rate limit,
 * and they are not the same thing. Bolt limits a workspace's own commands against a policy the
 * workspace declares in `src/+ratelimits.ts`, counting in memory inside the runtime. Colony limits
 * the *bootstrap* path — a sign-in code requested before any tenant exists, so there is no
 * `+ratelimits.ts` to consult and nothing to key on but the address — counting in its control store.
 *
 * Those two differ in **where the policy comes from** and in **where the counts are kept**, and both
 * of those differences are real. What must not differ is the arithmetic. Two hand-written fixed
 * windows are two places to get the same off-by-one wrong, two answers to what happens on a window
 * boundary, and two things to fix when either is found — which is exactly what this replaces.
 *
 * So: the window function and the key derivation are here. The store is the caller's, injected, and
 * this module knows nothing about it.
 */

/** How long a bucket lasts, and how many admissions fit in it. */
export interface FixedWindow {
	readonly windowMillis: number;
	readonly limit: number;
}

/** One bucket's state: when its window opened, and how many attempts have landed in it. */
export interface WindowState {
	readonly windowStartMillis: number;
	readonly count: number;
}

/**
 * Counts one attempt against a bucket and says whether it is admitted.
 *
 * A fixed window rather than a sliding log, deliberately: the log grows with the flood it exists to
 * stop, which is the wrong shape for a counter a stranger can drive. What it costs is that a caller
 * can spend two windows' admissions either side of a boundary — a factor of two on limits that are
 * chosen with an order of magnitude of headroom, and a price worth paying for a counter that cannot
 * be made to consume memory.
 *
 * The comparison is `<=`, so a limit of five admits the fifth attempt and refuses the sixth. Stated
 * because it is the off-by-one every reimplementation of this gets to decide again.
 */
export const countAttempt = (
	current: WindowState | undefined,
	window: FixedWindow,
	nowMillis: number
): readonly [admitted: boolean, next: WindowState] => {
	const open =
		current !== undefined && nowMillis - current.windowStartMillis < window.windowMillis
			? current
			: { windowStartMillis: nowMillis, count: 0 };
	const next = { windowStartMillis: open.windowStartMillis, count: open.count + 1 };
	return [next.count <= window.limit, next];
};

/** Whole seconds until a bucket resets, which is what a `Retry-After` header carries. */
export const retryAfterSeconds = (
	state: WindowState,
	window: FixedWindow,
	nowMillis: number
): number =>
	Math.max(1, Math.ceil((state.windowStartMillis + window.windowMillis - nowMillis) / 1_000));

/**
 * SHA-256 as hex, through WebCrypto.
 *
 * `crypto.subtle`, never `node:crypto`, and this is not a style preference. One caller of this
 * module is Bolt's runtime, which ships inside the bundle a tenant isolate evaluates — and there
 * `node:crypto` is an externalized stub that throws on access, while the sandbox context is handed
 * WebCrypto for exactly this reason. A `node:crypto` import here would have thrown on the first
 * rate-limited command inside any isolate, which is every command on the hosting platform.
 * `runtime/access/system-principal.ts` computes its HMAC the same way and says so at length.
 *
 * Async, because `crypto.subtle` is. That is the whole cost, and it is paid nowhere: both call
 * sites are already inside an Effect.
 */
const sha256Hex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * What a bucket is named, with the identifying half hashed.
 *
 * The hash is not decoration. A limiter keyed on an email address turns every address anyone types
 * into a key in whatever store holds the counts — a control-plane row, a log line that prints a key,
 * a dump taken for an unrelated reason — and a list of the addresses that have tried to sign in is
 * personal data nobody decided to collect. Hashing means the store holds a counter under an opaque
 * name and the address stays in the request that named it.
 *
 * It has to be a *cryptographic* hash rather than a fast one that would keep this synchronous.
 * Email addresses are a low-entropy space; a non-cryptographic digest over one is reversible by
 * enumeration, which gives back exactly the list this exists to avoid holding.
 *
 * `scope` is the fixed part and stays legible: the tenant, the command, and which kind of key this
 * is. That is what makes a bucket findable when something is being diagnosed, and none of it
 * identifies a person. Only `identity` — the address, the user id — is hashed.
 *
 * Truncated to 32 hex characters. 128 bits of SHA-256 is far past any collision that matters for a
 * counter, and a full digest only makes keys longer in every store that holds one.
 */
export const bucketKey = (
	scope: ReadonlyArray<string>,
	identity: string | undefined
): Effect.Effect<string> =>
	Effect.suspend(() => {
		const named = identity?.trim().toLowerCase() ?? '';
		// An empty identity is a *shared* bucket, and deliberately the strict direction: anonymous
		// traffic that names nothing is counted together, so omitting the field a limit is keyed on
		// cannot buy a caller an unlimited lane of their own. It needs no digest — there is nothing
		// to conceal — so it stays off the async path entirely.
		if (named === '') return Effect.succeed([...scope, 'shared'].join('/'));
		return Effect.promise(() => sha256Hex(named)).pipe(
			Effect.map((digest) => [...scope, digest.slice(0, 32)].join('/'))
		);
	});
