// The failures a host port and a host database answer with: one class each, shared by the host that raises them and
// the release that branches on them.
import { Schema } from 'effect';

/** A facility failure's kinds: `too_large` and `invalid` pass a provider's own limit refusal through (P37). */
export const FACILITY_KINDS = [
	'upstream',
	'timeout',
	'rate_limited',
	'invalid',
	'too_large',
	'unsupported'
] as const;
/** A failed facility call: its kind, message, HTTP status and optional provider retry delay. */
export class FacilityFailure extends Schema.TaggedError<FacilityFailure>()('FacilityFailure', {
	kind: Schema.Literals(FACILITY_KINDS),
	message: Schema.String,
	status: Schema.optional(Schema.Number),
	/** The provider's minimum delay before another attempt. */
	retry_after_ms: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
}) {
	/** Refuses invalid facility input without changing the shared tagged error identity. */
	static invalid(message: string): FacilityFailure {
		return new FacilityFailure({ kind: 'invalid', message });
	}
}

/** An optional facility with no provider bound (P19), or an instance not paired: the facility and why. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', {
	facility: Schema.String,
	reason: Schema.String
}) {
	readonly message = this.reason;
}

/** What a port call fails with: the facility's own failure, or the host providing none. */
export type PortFailure = FacilityFailure | Unavailable;

const DbErrorFields = {
	sqlstate: Schema.String,
	message: Schema.String,
	outcome_unknown: Schema.optionalKey(Schema.Literal(true)),
	constraint: Schema.optional(Schema.String),
	column: Schema.optional(Schema.String)
};
type DbErrorProps = Schema.Struct.MakeIn<typeof DbErrorFields>;
type DbErrorArgs =
	| [sqlstate: string, message: string, constraint?: string, column?: string]
	| [props: DbErrorProps, options?: Schema.MakeOptions];
/** What a Postgres adapter fails with: the SQLSTATE and constraint the write compiler maps to a refusal. */
export class DbError extends Schema.TaggedError<DbError>()('DbError', DbErrorFields) {
	static override make(
		...args: [sqlstate: string, message: string, constraint?: string, column?: string]
	): DbError;
	/** The Schema class's own form (`new DbError(props)`), which the static side keeps. */
	static override make(...args: [props: DbErrorProps, options?: Schema.MakeOptions]): DbError;
	static override make(...args: DbErrorArgs): DbError {
		if (isDbProps(args)) return new DbError(args[0], args[1]);
		const [sqlstate, message, constraint, column] = args;
		return new DbError({ sqlstate, message, constraint, column });
	}
}
const isDbProps = (
	args: DbErrorArgs
): args is [props: DbErrorProps, options?: Schema.MakeOptions] => typeof args[0] !== 'string';

/** Another link opened the instance since this one did (its epoch moved); terminal for the fenced link. */
export class Fenced extends Schema.TaggedError<Fenced>()('Fenced', {
	instance: Schema.String,
	message: Schema.String
}) {}
/**
 * A provider's refusal of a send, thrown from `LinksPort.send`: `permanent` (SMTP 5xx, an API 4xx) fails the message
 * at once; otherwise bolt retries it with backoff and records `deferred` (SMTP 4xx). Recognised by `name`, so a copy of
 * this class in another bundle still counts.
 */
export class SendRefused extends Error {
	override readonly name = 'SendRefused';
	readonly code: string | undefined;
	readonly permanent: boolean;
	constructor(message: string, code?: string, permanent = true) {
		super(message);
		this.code = code;
		this.permanent = permanent;
	}
}
