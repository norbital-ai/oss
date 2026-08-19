/**
 * What a workspace will admit, and how often.
 *
 * `src/+ratelimits.ts` is where a workspace states its own rate policy, beside the collections and
 * policies it protects rather than in whichever host happens to be serving it. That placement is the
 * point. The limiter used to live in Colony alone, keyed on `getClientAddress()`, which behind a
 * reverse proxy is *the proxy* — so every visitor to the host shared one bucket and the whole
 * deployment got twenty sign-in codes an hour between them. Bolt had none at all, so a self-hosted
 * workspace had none at all.
 *
 * Three layers, each doing only what it can see:
 *
 * ```
 * Traefik   per-IP anti-flood ceiling, high enough no real user meets it
 *    │      (also: must give the app a trustworthy client IP)
 *    ▼
 * Bolt      the real policy — knows command, subject, tenant
 *    │      buckets keyed (tenant, subject, command-class), in memory
 *    ▼
 * Colony    inherits; does not reimplement
 * ```
 *
 * This file is the middle one. It knows what the edge cannot — which command was called, which
 * tenant it belongs to, and which person is behind it — and those are the facts a real policy is
 * written in terms of.
 *
 * Classes are declared separately because their economics differ, not for tidiness. An OTP send is
 * anonymous and costs an email; a sign-in is semi-anonymous; an ordinary invocation is
 * authenticated and nearly free; an agent turn is authenticated and costs money at a provider.
 * One number cannot be right for all four.
 */

/** How a bucket is keyed, which decides who shares a limit with whom. */
export type RateLimitKey =
	/**
	 * The address the request names — the email an OTP would go to.
	 *
	 * The only usable key for anonymous traffic, and the correct one: what is being protected is the
	 * cost of sending to *that address*, and a stranger who can vary the address is not spending
	 * anything on the person they are naming.
	 */
	| 'address'
	/** The authenticated person. Meaningless before sign-in, exact after it. */
	| 'subject'
	/** Everyone in this workspace together, for a resource the workspace as a whole pays for. */
	| 'tenant';

export interface RateLimitRule {
	/** How long a bucket lasts: `'1 hour'`, `'15 min'`, `'30 s'`. */
	readonly window: string;
	/** How many admissions per window. */
	readonly limit: number;
	readonly key: RateLimitKey;
}

export interface RateLimitSpec {
	/**
	 * Command pattern → rule. A pattern is an exact command name or a `prefix.*` wildcard; the most
	 * specific match wins, so `collections.create` overrides `collections.*`.
	 */
	readonly rules: Readonly<Record<string, RateLimitRule>>;
}

/** `'1 hour'`, `'15 min'`, `'30 s'`, `'1 day'` — and nothing else, so a typo is a build failure. */
const WINDOW = /^\s*(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/;

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
	return unit === undefined || !Number.isFinite(amount) || amount <= 0
		? undefined
		: amount * unit;
};

const PATTERN = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*(\.\*)?$/;

/**
 * Declares this workspace's rate limits.
 *
 * Validated here rather than at admission time, for the reason `defineEnvironment` validates there:
 * a rule that never matches anything is indistinguishable, at run time, from a rule that is simply
 * not being hit — so a typo in a command name reads as "the limit is working" right up until
 * somebody tests it.
 */
export const defineRateLimits = <const T extends Readonly<Record<string, RateLimitRule>>>(
	rules: T
): RateLimitSpec & { readonly rules: T } => {
	for (const [pattern, rule] of Object.entries(rules)) {
		if (!PATTERN.test(pattern)) {
			throw new TypeError(
				`Rate limit "${pattern}" is not a command pattern. Use a command name such as "identity.sendCode", or a prefix wildcard such as "collections.*".`
			);
		}
		if (rateLimitWindowMillis(rule.window) === undefined) {
			throw new TypeError(
				`Rate limit "${pattern}" declares the window "${rule.window}", which is not a duration. Write it as "1 hour", "15 min" or "30 s".`
			);
		}
		if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
			throw new TypeError(
				`Rate limit "${pattern}" declares a limit of ${String(rule.limit)}. A limit is a whole number of admissions per window, and a limit of zero is a closed door written as a rate — refuse it in a policy instead.`
			);
		}
	}
	return Object.freeze({ rules });
};

/**
 * The rule that governs one command, or `undefined` when none does.
 *
 * Most specific wins, measured by pattern length: an exact `collections.create` beats
 * `collections.*`, and a workspace can therefore tighten one command without restating the class it
 * belongs to. An unmatched command is unlimited by this layer — the edge ceiling still applies, and
 * inventing a default here would silently throttle every command a workspace never thought about.
 */
export const rateLimitFor = (
	spec: RateLimitSpec | undefined,
	command: string
): RateLimitRule | undefined => {
	if (spec === undefined) return undefined;
	let matched: RateLimitRule | undefined;
	let matchedLength = -1;
	for (const [pattern, rule] of Object.entries(spec.rules)) {
		const wildcard = pattern.endsWith('.*');
		const prefix = wildcard ? pattern.slice(0, -1) : pattern;
		const hit = wildcard ? command.startsWith(prefix) : command === pattern;
		if (!hit || pattern.length <= matchedLength) continue;
		matched = rule;
		matchedLength = pattern.length;
	}
	return matched;
};
