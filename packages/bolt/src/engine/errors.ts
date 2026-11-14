// Engine failures (D3). `BoltError` carries a literal `code`; a separate tag exists only where code branches
// on it. `CODE` is the one table of each code's wire status and retry class; `is_transient` reads it.
import { Match, Option, Schema } from 'effect';
import { DbError, FACILITY_KINDS, Fenced } from '@norbital-ai/host-api';
import type { AgentRefusal } from './agent/schema.ts';
export type { AgentRefusal } from './agent/schema.ts';

import { BoltError, CODE } from '../protocol/errors.ts';

/** The write lost a race: another write changed the named fields of these records since they were read. */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
	records: Schema.Array(
		Schema.Struct({
			model: Schema.String,
			id: Schema.String,
			fields: Schema.Array(Schema.String)
		})
	)
}) {}
/** The work's generation is draining. */
export class Interrupted extends Schema.TaggedError<Interrupted>()('Interrupted', {}) {}
/** The database refused a serializable commit; the admitted attempt is replanned once. */
export class SerializationReplay extends Schema.TaggedError<SerializationReplay>()(
	'SerializationReplay',
	{}
) {}
export const IDENTITY_REFUSALS = [
	'forbidden',
	'not_found',
	'rate_limited',
	'expired',
	'last_admin',
	'active',
	'check',
	'invalid_code',
	'not_member',
	'unavailable',
	'upstream',
	'timeout'
] as const;
/** A sign-in, session or member operation refused: the shell answers `code`, `message` and `retry-after`. */
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

/** Transaction races, cancellation, unavailable locks/connections and temporary server shutdown or saturation. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
	'40001', '40P01', '57014', '55P03', '53300', '57P01', '57P02', '57P03', '57P05'
]);
const guestFacility = Schema.decodeUnknownOption(
	Schema.Struct({ kind: Schema.Literals(FACILITY_KINDS) })
);
/** Rule 54: guest facility failures retain their kind across the isolate boundary. */
export const is_transient = (e: EngineError): boolean =>
	Match.valueTags(e, {
		BoltError: (b) => {
			if (CODE[b.code].transient) return true;
			if (b.code !== 'guest_error') return false;
			const facility = guestFacility(b.cause);
			return Option.isSome(facility) && CODE[facility.value.kind].transient;
		},
		DbError: (d) => /^08[A-Z0-9]{3}$/.test(d.sqlstate) || TRANSIENT_SQLSTATES.has(d.sqlstate),
		Conflict: () => CODE.conflict.transient,
		Fenced: () => CODE.fenced.transient,
		Interrupted: () => CODE.interrupted.transient,
		SerializationReplay: () => CODE.conflict.transient,
		IdentityRefusal: (r) => CODE[r.code].transient,
		ManifestInvalid: () => false,
		AgentRefusal: () => false
	});
