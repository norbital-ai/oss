import { Clock, Context, Effect, Layer, Schema } from 'effect';
import {
	bucketKey,
	countAttempt,
	retryAfterSeconds,
	type WindowState
} from '@norbital-ai/std/rate-limit';
import {
	rateLimitFor,
	rateLimitWindowMillis,
	type RateLimitRule,
	type RateLimitSpec
} from '../authoring/rate-limits-schema.js';

/** Reports a caller who has spent this window's admissions; stupidity:allow Q4 -- Effect TaggedError declaration is the canonical Effect v4 error boundary. */
export class RateLimited extends Schema.TaggedError<RateLimited>()('Bolt.RateLimited', {
	command: Schema.NonEmptyString,
	limit: Schema.Number.check(Schema.isInt()),
	windowMillis: Schema.Number.check(Schema.isInt()),
	/** Whole seconds until this bucket resets, which is what a `Retry-After` header carries. */
	retryAfterSeconds: Schema.Number.check(Schema.isInt()),
	message: Schema.NonEmptyString
}) {
	readonly category = 'rate-limited' as const;
	readonly retryable = true;
}

export type RateLimitSubject = Readonly<{
	readonly tenantId: string;
	/** The signed-in person, or the static identity acting — an envoy, an automation. */
	readonly userId?: string;
	/** The address a request names, such as the email an OTP would be sent to. */
	readonly address?: string;
	/**
	 * The transport's own address for an outside sender, on an inbound envoy message.
	 *
	 * The one thing an envoy knows that a policy cannot: which stranger this message is from. A
	 * `sender`-keyed rule counts against it, and never matches a human holder of the same policy.
	 */
	readonly sender?: string;
}>;

export type Interface = Readonly<{
	/**
	 * Admit one command, against the workspace's pre-sign-in rules plus this holder's own.
	 *
	 * `held` is the merged `limits` of the policies this subject holds, resolved by `AccessControl`
	 * and passed in rather than looked up here. That direction is what keeps the limiter ignorant of
	 * teams, policies and declarations: it counts, and something that already knows who holds what
	 * decides which rule to count against.
	 */
	readonly admit: (
		command: string,
		subject: RateLimitSubject,
		held?: Readonly<Record<string, ReadonlyArray<RateLimitRule>>>
	) => Effect.Effect<void, RateLimited>;
}>;

/** Identifies the rate limiter in Effect's context so policy is injected rather than ambient. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/RateLimits');

/**
 * One fixed window per key, in memory.
 *
 * A fixed window rather than a sliding log, for the reason Colony's onboarding guard already gives:
 * the log grows with the flood it exists to stop, which is the wrong shape for a counter a stranger
 * can drive. The cost of a fixed window is that a caller can spend two windows' admissions across a
 * boundary; that is a factor of two on limits chosen with an order of magnitude of headroom.
 *
 * In memory, and therefore per process. That is exact while a host is one instance, which Colony is,
 * and it is the honest place to start: a shared store is a second system to run, to fail, and to
 * decide what to do about when it is unreachable, and none of that is worth buying before the
 * deployment needs it. If this scales out the map becomes a shared store and nothing else here
 * changes.
 */
const buckets = new Map<string, WindowState>();

/**
 * Drops buckets whose window closed long enough ago that they cannot matter.
 *
 * Without it, a limit keyed on `address` grows one map entry per address a stranger names, which is
 * a memory leak with an attacker's hand on the tap. Swept on write rather than on a timer, so the
 * cost is paid by the traffic that caused it and no interval has to be kept alive.
 */
const SWEEP_EVERY = 512;
/** Longer than any window this surface admits, so an entry older than it is dead whatever wrote it. */
const BUCKET_LIFETIME_MILLIS = 86_400_000;
let sinceSweep = 0;
const sweep = (nowMillis: number): void => {
	sinceSweep += 1;
	if (sinceSweep < SWEEP_EVERY) return;
	sinceSweep = 0;
	for (const [key, bucket] of buckets)
		if (nowMillis - bucket.windowStartMillis > BUCKET_LIFETIME_MILLIS) buckets.delete(key);
};

/**
 * What a rule counts against.
 *
 * The tenant and the command are in every key, always. Two workspaces on one host must not be able
 * to spend each other's admissions, and a key that omitted the tenant would let the busiest
 * workspace on a deployment lock out the quietest — the multi-tenant form of the exact defect this
 * replaces, where every visitor behind one reverse proxy shared one bucket.
 *
 * The identity half goes through `bucketKey` from `@norbital-ai/std/rate-limit`, which hashes it.
 * That is the same derivation Colony's bootstrap limiter uses, so an address is never a key in
 * either store — and there is one answer, not two, to what a bucket is called.
 */
const keyFor = (
	command: string,
	rule: RateLimitRule,
	subject: RateLimitSubject
): Effect.Effect<string> =>
	bucketKey(
		[subject.tenantId, command, rule.key],
		rule.key === 'subject'
			? subject.userId
			: rule.key === 'address'
				? subject.address
				: rule.key === 'sender'
					? subject.sender
					: 'tenant'
	);

/**
 * The limiter for one workspace's declared policy.
 *
 * A command no rule matches is admitted without being counted. That is not an oversight: the edge
 * ceiling still applies, and a default invented here would throttle every command a workspace never
 * thought about, at a number nobody chose.
 */
export const make = (spec: RateLimitSpec | undefined): Interface => ({
	admit: Effect.fn('RateLimits.admit')(function* (
		command: string,
		subject: RateLimitSubject,
		held?: Readonly<Record<string, ReadonlyArray<RateLimitRule>>>
	) {
		// The holder's own rules first, then the pre-sign-in ones. They cannot collide in practice —
		// `+anonymous_limits.ts` refuses anything not keyed by `address`, and a policy refuses anything
		// that is — so the order states an intent rather than resolving a conflict: a rule declared by
		// the holder governs the holder.
		const held_ = held === undefined ? [] : rateLimitFor({ rules: held }, command);
		const rules = held_.length > 0 ? held_ : rateLimitFor(spec, command);
		// Every rule at the winning pattern, because one command can carry two buckets keyed
		// differently — a public envoy caps each sender *and* the surface as a whole — and being inside
		// one of two ceilings is not admission.
		for (const rule of rules) {
			// A rule that names a key this caller has no value for counts nothing. A `sender`-keyed rule
			// reaching an authenticated person, or an `address`-keyed one reaching a signed-in session,
			// is not a misconfiguration to refuse — it is the ordinary case of a rule that is about a
			// different kind of caller, and refusing on absence would close the door on everybody.
			if (rule.key === 'subject' && subject.userId === undefined) continue;
			if (rule.key === 'address' && subject.address === undefined) continue;
			if (rule.key === 'sender' && subject.sender === undefined) continue;
			const windowMillis = rateLimitWindowMillis(rule.window);
			// `anonymousLimits` refuses an unparseable window at build time, so reaching this means the
			// declaration was assembled some other way. Admitting is the right direction for a policy
			// that cannot be read: failing closed on malformed configuration takes the workspace down in
			// order to enforce a rule nobody can state.
			if (windowMillis === undefined) continue;
			const nowMillis = yield* Clock.currentTimeMillis;
			// An `Effect`, because the digest is `crypto.subtle` and that is async. Free here: this is
			// already a generator, and the alternative — a synchronous non-cryptographic hash — would
			// make the address recoverable by enumeration, which is the whole point of hashing it.
			const key = yield* keyFor(command, rule, subject);
			const [admitted, next] = countAttempt(
				buckets.get(key),
				{ limit: rule.limit, windowMillis },
				nowMillis
			);
			buckets.set(key, next);
			sweep(nowMillis);
			if (admitted) continue;
			const retryAfter = retryAfterSeconds(next, { limit: rule.limit, windowMillis }, nowMillis);
			return yield* new RateLimited({
				command,
				limit: rule.limit,
				windowMillis,
				retryAfterSeconds: retryAfter,
				message: `${command} is limited to ${rule.limit} per ${rule.window} per ${rule.key}. Try again in ${retryAfter}s.`
			});
		}
	})
});

export const layer = (spec: RateLimitSpec | undefined): Layer.Layer<Interface> =>
	Layer.succeed(Service, make(spec));

/** Empties every bucket. For tests, which must not inherit a count from the case before them. */
export const resetRateLimits = (): void => {
	buckets.clear();
	sinceSweep = 0;
};

export * as RateLimits from './rate-limits.js';
