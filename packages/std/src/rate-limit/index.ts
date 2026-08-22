import { Effect } from 'effect';

/**
 * What a bucket is named, with the identifying half hashed.
 *
 * It lives in `std` for the reason the secret cipher does: more than one thing has to rate limit,
 * and they are not the same thing. Bolt limits a workspace's own commands against a policy the
 * workspace declares in `src/+ratelimits.ts`, counting in memory inside the runtime with Effect's
 * own `RateLimiter`. Colony limits the *bootstrap* path — a sign-in code requested before any
 * tenant exists, so there is no `+ratelimits.ts` to consult and nothing to key on but the address —
 * counting in its control store.
 *
 * Those two differ in **where the policy comes from** and in **where the counts are kept** — and
 * the counting itself belongs to Effect, which both sides use. What must not differ is the key
 * derivation: an address must never be a key in either store, and there is one answer, not two, to
 * what a bucket is called.
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
): Effect.Effect<string> => {
	const named = identity?.trim().toLowerCase() ?? '';
	// An empty identity is a *shared* bucket, and deliberately the strict direction: anonymous
	// traffic that names nothing is counted together, so omitting the field a limit is keyed on
	// cannot buy a caller an unlimited lane of their own. It needs no digest — there is nothing
	// to conceal — so it stays off the async path entirely.
	if (named === '') return Effect.succeed([...scope, 'shared'].join('/'));
	return sha256Hex(named).pipe(Effect.map((digest) => [...scope, digest.slice(0, 32)].join('/')));
};

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
 * Async because `crypto.subtle` is. That is the whole cost, and it is paid nowhere: the call site
 * in `bucketKey` is inside an Effect.
 */
const sha256Hex = (value: string): Effect.Effect<string> =>
	Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).pipe(
		Effect.map((digest) =>
			[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
		)
	);
