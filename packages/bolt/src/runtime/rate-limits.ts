// repository-health:allow SEM_PARALLEL -- the runtime limiter consumes the authored rate-limit
// schema over the #lib alias, so the pair is linked, not parallel.
import { Context, Duration, Effect, Layer, Schema } from 'effect';
import { RateLimiter } from 'effect/unstable/persistence';
import { bucketKey } from '@norbital-ai/std/rate-limit';
import {
	rateLimitFor,
	rateLimitWindowMillis,
	type RateLimitRule,
	type RateLimitSpec
} from '#lib/authoring/rate-limits-schema.js';

/** Reports a caller who has spent this window's admissions. */
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

type RateLimitSubject = Readonly<{
	readonly tenantId: string;
	/** The signed-in person, or the static identity acting — an envoy, an automation. */
	readonly userId?: string | undefined;
	/** The address a request names, such as the email an OTP would be sent to. */
	readonly address?: string | undefined;
	/**
	 * The transport's own address for an outside sender, on an inbound envoy message.
	 *
	 * The one thing an envoy knows that a policy cannot: which stranger this message is from. A
	 * `sender`-keyed rule counts against it, and never matches a human holder of the same policy.
	 */
	readonly sender?: string | undefined;
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
 *
 * `bucketKey` hashes through WebCrypto, so it carries an `Error` channel for a `crypto.subtle`
 * that refuses. It is declared here rather than swallowed; `admit` decides what to do with it.
 */
const keyFor = (
	command: string,
	rule: RateLimitRule,
	subject: RateLimitSubject
): Effect.Effect<string, Error> =>
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
 * A command no rule matches is admitted without being counted. The edge ceiling still applies, and
 * inventing a default here would throttle commands at a number nobody chose.
 *
 * The counting itself is Effect's fixed-window `RateLimiter`, one limiter over one in-memory store
 * per instance — a `Layer.sync`, so no interval and no sweep has to be kept alive. Instance
 * ownership prevents separate workspace layers or tests from spending one another's admissions
 * without a process-global reset hook. Buttons that once shared one bucket — every portal visitor
 * behind a single reverse proxy — are counted per tenant, per command, per identity key.
 */
export const make = (spec: RateLimitSpec | undefined): Interface => {
	const limiter = Effect.runSync(
		RateLimiter.make.pipe(Effect.provide(RateLimiter.layerStoreMemory))
	);
	return {
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
				// A digest that will not compute is the host's WebCrypto failing, not a caller to be turned
				// away: answering `RateLimited` would tell somebody they had spent admissions they never
				// spent, and admitting would drop the ceiling on the way through. Both are worse than a
				// defect that stops the invocation and says so — the same direction the store failure below
				// takes, for the same reason.
				const key = yield* keyFor(command, rule, subject).pipe(Effect.orDie);
				yield* limiter
					.consume({
						key,
						limit: rule.limit,
						window: Duration.millis(windowMillis),
						algorithm: 'fixed-window',
						onExceeded: 'fail'
					})
					.pipe(
						Effect.catch((error) => {
							const reason = error.reason;
							if (!(reason instanceof RateLimiter.RateLimitExceeded)) {
								// The in-memory store is synchronous and cannot fail; any store error that
								// reaches here is a defect in the store itself, not a caller to be turned away.
								return Effect.die(error);
							}
							const retryAfterSeconds = Math.max(
								1,
								Math.ceil(Duration.toMillis(reason.retryAfter) / 1_000)
							);
							return Effect.fail(
								new RateLimited({
									command,
									limit: rule.limit,
									windowMillis,
									retryAfterSeconds,
									message: `${command} is limited to ${rule.limit} per ${rule.window} per ${rule.key}. Try again in ${retryAfterSeconds}s.`
								})
							);
						})
					);
			}
		})
	};
};

export const layer = (spec: RateLimitSpec | undefined): Layer.Layer<Interface> =>
	Layer.sync(Service, () => make(spec));
