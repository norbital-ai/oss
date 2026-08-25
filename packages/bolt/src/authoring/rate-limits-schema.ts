/**
 * What a workspace will admit, and how often.
 *
 * A rate limit is always the same shape — a command class, a window, a count, and a key — and the
 * key is the only thing that varies. It decides who shares a bucket with whom, and therefore where
 * the rule is declared:
 *
 * | question | key | declared in |
 * | --- | --- | --- |
 * | How much may an authenticated person do? | `subject` | the policies they hold |
 * | How many messages may an outside sender push at an envoy? | `sender` | the policies the envoy holds |
 * | How much may a caller at the sign-in surface do? | `address` | `src/access/+anonymous_limits.ts` |
 *
 * **Everything with a holder is declared by that holder.** There is no workspace-wide rate file any
 * more: `src/+ratelimits.ts` mixed `identity.*` — which has no subject yet — with `collections.*` and
 * `agents.enqueue`, which have one, and stating the second kind in one place for everybody meant a
 * contractor and a controller could not be given different budgets for the same command.
 *
 * The one genuinely separate file is `+anonymous_limits.ts`, and it is separate structurally rather
 * than stylistically: before sign-in there is no subject, so there is no policy to hang a limit on.
 *
 * Three layers, each doing only what it can see:
 *
 * ```
 * Traefik   per-IP anti-flood ceiling, high enough no real user meets it
 *    │      (also: must give the app a trustworthy client IP)
 *    ▼
 * Bolt      the real policy — knows command, subject, tenant, and who holds what
 *    │      buckets keyed (tenant, command-class, identity), in memory
 *    ▼
 * Colony    inherits; does not reimplement
 * ```
 *
 * This file is the middle one. It knows what the edge cannot — which command was called, which
 * tenant it belongs to, which person is behind it, and which policies that person holds — and those
 * are the facts a real policy is written in terms of. The limiter used to live in Colony alone,
 * keyed on `getClientAddress()`, which behind a reverse proxy is *the proxy*: every visitor to the
 * host shared one bucket and the whole deployment got twenty sign-in codes an hour between them.
 */

import { Schema } from 'effect';

/**
 * How a bucket is keyed, which decides who shares a limit with whom.
 *
 * - `address` — the address the request names (the email an OTP would go to): the only usable key
 *   for anonymous traffic, and the correct one, because what is protected is the cost of sending to
 *   *that address* — a stranger who can vary the address spends nothing on the person named.
 * - `subject` — the authenticated person, and for an envoy, the envoy itself: one subject, so its
 *   senders share one bucket by construction (what `totalPerMinute` used to say, twice).
 * - `sender` — one outside sender on an inbound envoy message, by the transport's address for them;
 *   the other half of what an envoy used to declare (`perSenderPerMinute`), meaningless for a human
 *   holder in the way `address` is meaningless after sign-in, and like `address` it simply never
 *   matches rather than needing a rule about it.
 * - `tenant` — everyone in this workspace together, for a resource the workspace as a whole pays for.
 */
const RateLimitKeySchema = Schema.Literals(['address', 'subject', 'sender', 'tenant']);

export type RateLimitKey = Schema.Schema.Type<typeof RateLimitKeySchema>;

/**
 * One rate ceiling and the identity that shares its bucket.
 *
 * Policy declarations may omit `key` because `subject` is their only sensible default; resolved
 * rules and anonymous declarations require it so runtime code never has to reinterpret absence.
 */
export type RateLimitRule<
	Key extends RateLimitKey = RateLimitKey,
	OptionalKey extends boolean = false
> = Readonly<{
	/** How long a bucket lasts: `'1 hour'`, `'15 min'`, `'30 s'`. */
	readonly window: string;
	/** How many admissions per window. */
	readonly limit: number;
}> &
	(OptionalKey extends true ? { readonly key?: Key } : { readonly key: Key });

/**
 * One command pattern may apply one rule or several differently keyed rules.
 *
 * Several are real, not syntactic flexibility: `envoys.receive` needs both a per-sender ceiling and
 * a ceiling for the envoy as a whole. Every rule at the winning pattern applies, because being under
 * one of two ceilings is not admission.
 */
export type RateLimitRules<Rule = RateLimitRule> = Rule | ReadonlyArray<Rule>;

const isRuleList = <Rule>(declared: RateLimitRules<Rule>): declared is ReadonlyArray<Rule> =>
	Array.isArray(declared);

const rulesOf = <Rule>(declared: RateLimitRules<Rule>): ReadonlyArray<Rule> =>
	isRuleList(declared) ? declared : [declared];

export const resolvePolicyLimits = (
	limits: Readonly<Record<string, RateLimitRules<RateLimitRule<RateLimitKey, true>>>> | undefined
): Readonly<Record<string, ReadonlyArray<RateLimitRule>>> =>
	Object.fromEntries(
		Object.entries(limits ?? {}).map(([pattern, declared]) => [
			pattern,
			rulesOf(declared).map((rule) => ({
				window: rule.window,
				limit: rule.limit,
				key: rule.key ?? 'subject'
			}))
		])
	);

export interface RateLimitSpec {
	/**
	 * Command pattern → rule, or rules. A pattern is an exact command name or a `prefix.*` wildcard;
	 * the most specific match wins, so `collections.create` overrides `collections.*`.
	 */
	readonly rules: Readonly<Record<string, RateLimitRules>>;
}

/** `'1 hour'`, `'15 min'`, `'30 s'`, `'1 day'` — and nothing else, so a typo is a build failure. */
const WINDOW =
	/^\s*(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/;

const UNIT_MILLIS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000
};

/**
 * A declared window as milliseconds, or `undefined` if it is not one.
 *
 * Written as a parser rather than taking a number of milliseconds directly because the declaration
 * is read by people deciding policy, and `3_600_000` is a number nobody checks. `'1 hour'` is
 * checkable at a glance, which is the only review this file ever gets.
 */
export const rateLimitWindowMillis = (window: string): number | undefined => {
	const parsed = WINDOW.exec(window);
	if (parsed === null) return undefined;
	const amount = Number(parsed[1]);
	const unit = UNIT_MILLIS[parsed[2] ?? ''];
	return unit === undefined || !Number.isFinite(amount) || amount <= 0 ? undefined : amount * unit;
};

const PATTERN = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*(\.\*)?$/;

/** Every rule in one map, validated the same way whoever declared it. */
const validateRules = (rules: Readonly<Record<string, RateLimitRules>>, where: string): void => {
	for (const [pattern, declared] of Object.entries(rules)) {
		for (const rule of Array.isArray(declared) ? declared : [declared]) {
			if (!PATTERN.test(pattern)) {
				throw new TypeError(
					`${where} declares "${pattern}", which is not a command pattern. Use a command name such as "identity.sendCode", or a prefix wildcard such as "collections.*".`
				);
			}
			if (rateLimitWindowMillis(rule.window) === undefined) {
				throw new TypeError(
					`${where} declares the window "${rule.window}" for "${pattern}", which is not a duration. Write it as "1 hour", "15 min" or "30 s".`
				);
			}
			if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
				throw new TypeError(
					`${where} declares a limit of ${String(rule.limit)} for "${pattern}". A limit is a whole number of admissions per window, and a limit of zero is a closed door written as a rate — refuse it in a policy instead.`
				);
			}
		}
	}
};

/** Every rule at one pattern, whether it was declared as one or as several. */
/**
 * Declares the limits that apply before there is a subject to hang one on.
 *
 * `src/access/+anonymous_limits.ts` is the only rate-limit file left, and it is separate for a
 * structural reason rather than a stylistic one: before sign-in there is no subject, so there is no
 * policy to declare the rule. Everything with a holder is declared by that holder — a person's
 * limits live in the policies their team holds, an envoy's in the policies the envoy names.
 *
 * Every rule here must be keyed by `address`, and that is enforced rather than assumed. `subject`
 * and `sender` name things that do not exist yet at this surface, so a rule keyed by one of them
 * would collapse every anonymous caller into a single bucket — which is the exact defect this whole
 * layer replaced, where every visitor behind one reverse proxy shared one limit.
 *
 * Validated here rather than at admission time, for the reason `defineEnvironment` validates there:
 * a rule that never matches anything is indistinguishable, at run time, from a rule that is simply
 * not being hit — so a typo in a command name reads as "the limit is working" right up until
 * somebody tests it.
 */
export const anonymousLimits = <const T extends Readonly<Record<string, RateLimitRules>>>(
	rules: T
): RateLimitSpec & { readonly rules: T } => {
	validateRules(rules, '+anonymous_limits.ts');
	for (const [pattern, declared] of Object.entries(rules)) {
		for (const rule of rulesOf(declared)) {
			if (rule.key === 'address') continue;
			throw new TypeError(
				`+anonymous_limits.ts keys "${pattern}" by "${rule.key}". A caller at this surface has not signed in, so there is no subject and no sender to count against — key it by "address", or declare it on the policy whose holders it bounds.`
			);
		}
	}
	return Object.freeze({ rules });
};

/** Checks a policy's own limits at the point the compiler assembles it. */
export const validatePolicyLimits = (
	policyName: string,
	rules: Readonly<Record<string, RateLimitRules>>
): void => {
	validateRules(rules, `Policy ${policyName}`);
	for (const [pattern, declared] of Object.entries(rules)) {
		const keys = rulesOf(declared).map(({ key }) => key);
		if (new Set(keys).size !== keys.length) {
			throw new TypeError(
				`Policy ${policyName} declares two rules for "${pattern}" with the same key. Two buckets keyed the same way are one bucket with two numbers — write the tighter one.`
			);
		}
		for (const rule of rulesOf(declared)) {
			if (rule.key !== 'address') continue;
			throw new TypeError(
				`Policy ${policyName} keys "${pattern}" by "address". An address is what a caller names before signing in, and this policy only ever applies to somebody who already has — declare it in +anonymous_limits.ts instead.`
			);
		}
	}
};

/**
 * The rules that govern one command, empty when none does.
 *
 * Most specific wins, measured by pattern length: an exact `collections.create` beats
 * `collections.*`, and a workspace can therefore tighten one command without restating the class it
 * belongs to. An unmatched command is unlimited by this layer — the edge ceiling still applies, and
 * inventing a default here would silently throttle every command a workspace never thought about.
 *
 * Every rule at the winning pattern is returned, not merely the first: a pattern may declare several
 * keyed differently, and a caller has to be inside all of them.
 */
export const rateLimitFor = (
	spec: RateLimitSpec | undefined,
	command: string
): ReadonlyArray<RateLimitRule> => {
	if (spec === undefined) return [];
	let matched: ReadonlyArray<RateLimitRule> = [];
	let matchedLength = -1;
	for (const [pattern, declared] of Object.entries(spec.rules)) {
		const wildcard = pattern.endsWith('.*');
		const prefix = wildcard ? pattern.slice(0, -1) : pattern;
		const hit = wildcard ? command.startsWith(prefix) : command === pattern;
		if (!hit || pattern.length <= matchedLength) continue;
		matched = rulesOf(declared);
		matchedLength = pattern.length;
	}
	return matched;
};
