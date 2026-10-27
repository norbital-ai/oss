// Engine failures (D3, rule 72a). `BoltError` carries a literal `code`; a separate tag exists only where code branches
// on it. `CODE` is the one table of each code's wire status and retry class (rule 54); `isTransient` reads it.
import { Match, Option, Schema } from 'effect';
import { FACILITY_KINDS } from '../decl/errors.ts';
import type { AgentRefusal } from './agent/schema.ts';
export type { AgentRefusal } from './agent/schema.ts';

import { BoltError, CODE } from '../protocol/errors.ts';

const DbErrorFields = {
	sqlstate: Schema.String,
	message: Schema.String,
	constraint: Schema.optional(Schema.String),
	column: Schema.optional(Schema.String)
};
type DbErrorProps = Schema.Struct.MakeIn<typeof DbErrorFields>;
type DbErrorArgs =
	| [sqlstate: string, message: string, constraint?: string, column?: string]
	| [props: DbErrorProps, options?: Schema.MakeOptions];
/** What a Postgres adapter fails with: the SQLSTATE and constraint the write compiler maps to a refusal (rule 20). */
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

/** The write lost a race: another write changed the named fields of these records since they were read (rule 25). */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
	records: Schema.Array(
		Schema.Struct({
			model: Schema.String,
			id: Schema.String,
			fields: Schema.Array(Schema.String)
		})
	)
}) {}
/** Another link opened the instance since this one did (its epoch moved); terminal for the fenced link. */
export class Fenced extends Schema.TaggedError<Fenced>()('Fenced', {
	instance: Schema.String,
	message: Schema.String
}) {}
/** The work's generation is draining (rule 71a). */
export class Interrupted extends Schema.TaggedError<Interrupted>()('Interrupted', {}) {}
/** The database refused a serializable commit; the admitted attempt is replanned once (rule 26). */
export class SerializationReplay extends Schema.TaggedError<SerializationReplay>()(
	'SerializationReplay',
	{}
) {}
export const IDENTITY_REFUSALS = [
	'forbidden',
	'notFound',
	'rateLimited',
	'expired',
	'lastAdmin',
	'active',
	'check',
	'invalidCode',
	'notMember',
	'unavailable',
	'upstream',
	'timeout'
] as const;
/** A sign-in, session or member operation refused (§5.11): the shell answers `code`, `message` and `retry-after`. */
export class IdentityRefusal extends Schema.TaggedError<IdentityRefusal>()('IdentityRefusal', {
	code: Schema.Literals(IDENTITY_REFUSALS),
	message: Schema.String,
	retryAfter: Schema.optional(Schema.Number)
}) {}
/** An artifact or evaluated manifest that does not decode as an `EngineManifest`; `issues` are the decoder's lines. */
export class ManifestInvalid extends Schema.TaggedError<ManifestInvalid>()('ManifestInvalid', {
	issues: Schema.Array(Schema.String)
}) {}

export type EngineError =
	| BoltError
	| DbError
	| Conflict
	| Fenced
	| Interrupted
	| SerializationReplay
	| IdentityRefusal
	| ManifestInvalid
	| AgentRefusal;

/** The SQLSTATEs `refusalOf` answers `conflict` (40001, 40P01) or `timeout` (57014). */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01', '57014']);
const guestFacility = Schema.decodeUnknownOption(
	Schema.Struct({ kind: Schema.Literals(FACILITY_KINDS) })
);
/** Rule 54: guest facility failures retain their kind across the isolate boundary. */
export const isTransient = (e: EngineError): boolean =>
	Match.valueTags(e, {
		BoltError: (b) => {
			if (CODE[b.code].transient) return true;
			if (b.code !== 'guestError') return false;
			const facility = guestFacility(b.cause);
			return Option.isSome(facility) && CODE[facility.value.kind].transient;
		},
		DbError: (d) => TRANSIENT_SQLSTATES.has(d.sqlstate),
		Conflict: () => CODE.conflict.transient,
		Fenced: () => CODE.fenced.transient,
		Interrupted: () => CODE.interrupted.transient,
		SerializationReplay: () => CODE.conflict.transient,
		IdentityRefusal: (r) => CODE[r.code].transient,
		ManifestInvalid: () => false,
		AgentRefusal: () => false
	});
