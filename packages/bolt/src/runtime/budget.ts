import { Context, Effect, Layer, Result, Schema } from 'effect';

/**
 * How deep the work that caused this invocation already was.
 *
 * Carried in the enqueued task's own payload, beside `bolt_run_as` and stamped by the same runtime
 * that stamps that — never read from a caller's request. An automation or a delegated agent turn is
 * a *durable* piece of work: the runtime hands it to the host's task facility and the host runs it
 * later, on a fresh invocation with a fresh deadline. So a wall-clock budget cannot bound that
 * chain, and nothing else about the child says where it came from. A counter that rides the payload
 * does, and it is what actually stops `write → automation → write → automation` from running until
 * somebody notices the bill.
 */
const DEPTH_FIELD = 'bolt_depth';

const DepthPayload = Schema.Struct({
	[DEPTH_FIELD]: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))
});
const JsonObject = Schema.Record(Schema.String, Schema.Json);

/**
 * How many levels of enqueued work one originating request may cause.
 *
 * Eight, because the legitimate chains in this tree are two or three deep — a write fires an
 * automation which writes, or an agent delegates to a sub-agent which delegates once more — and a
 * limit has to sit far enough above the real cases that it never fires on one. It is a backstop,
 * not a design constraint: work that genuinely needs to go deeper is work that should be a loop
 * inside one automation rather than a chain of them.
 */
export const DEFAULT_NESTING_LIMIT = 8;

/** Reports work that would nest deeper than this host allows. */
export class NestingLimitExceeded extends Schema.TaggedError<NestingLimitExceeded>()(
	'Bolt.Budget.NestingLimitExceeded',
	{
		what: Schema.NonEmptyString,
		depth: Schema.Number.check(Schema.isInt()),
		limit: Schema.Number.check(Schema.isInt()),
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'nesting-limit' as const;
	readonly retryable = false;

	/**
	 * The sentence is a field rather than a getter, because these errors are `Error` subclasses whose
	 * `message` is an own property the base constructor writes — a getter on the subclass is shadowed
	 * by it, and the failure would report an empty sentence. `AccessDenied` copies `reason` onto
	 * `message` for the same reason, so a caller that reads `.message` still sees the authorization
	 * sentence instead of `''`.
	 */
	static at(what: string, depth: number, limit: number): NestingLimitExceeded {
		return new NestingLimitExceeded({
			what,
			depth,
			limit,
			message: `${what} would nest ${depth} levels deep, past this host's limit of ${limit}. Something is enqueueing work that enqueues itself.`
		});
	}
}

export type Interface = Readonly<{
	/** How deep this invocation already is. Zero for work a person or a schedule started. */
	readonly depth: number;
	readonly limit: number;
	/**
	 * The depth a child enqueued from here would run at, or a refusal if that is past the limit.
	 *
	 * Checked at the point of *enqueue* rather than on arrival, so the chain stops where it can still
	 * be attributed — the run that tried to go too deep fails, naming itself, instead of a mystery
	 * task failing later with nothing to trace it back to.
	 */
	readonly nest: (what: string) => Effect.Effect<number, NestingLimitExceeded>;
}>;

/** Identifies the invocation budget in Effect's context so nesting policy is injected rather than ambient. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/InvocationBudget');

export const make = (depth: number, limit: number = DEFAULT_NESTING_LIMIT): Interface => ({
	depth,
	limit,
	nest: (what: string) => {
		const next = depth + 1;
		return next > limit
			? Effect.fail(NestingLimitExceeded.at(what, next, limit))
			: Effect.succeed(next);
	}
});

export const layer = (
	depth: number,
	limit: number = DEFAULT_NESTING_LIMIT
): Layer.Layer<Interface> => Layer.succeed(Service, make(depth, limit));

/**
 * The depth an invocation's payload declares, or zero.
 *
 * Read defensively rather than through a schema: this key rides inside payloads whose schemas are
 * declared elsewhere and do not mention it, and a payload that carries a nonsense value should be
 * treated as the start of a chain rather than allowed to fail an unrelated decode. A negative or
 * fractional value is not a depth, and neither is a string.
 */
export const depthOf = (payload: unknown): number =>
	Result.getOrElse(Schema.decodeUnknownResult(DepthPayload)(payload), () => ({ bolt_depth: 0 }))[
		DEPTH_FIELD
	] ?? 0;

/**
 * Stamps the depth a child should run at onto the payload being enqueued.
 *
 * Overwrites rather than merges, for the reason `bolt_run_as` is overwritten at the same seam: the
 * only party entitled to say how deep a piece of work is is the runtime that is causing it, and a
 * depth carried in from a caller's own input would let anything reset itself to zero.
 */
export const stampDepth = (payload: Schema.Json, depth: number): Schema.Json => ({
	...Result.getOrElse(Schema.decodeUnknownResult(JsonObject)(payload), () => ({})),
	[DEPTH_FIELD]: depth
});
