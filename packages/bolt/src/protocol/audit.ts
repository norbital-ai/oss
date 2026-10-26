// Administrative audit events live in a host-owned store, separately from tenant rollback history and runtime logs.
import { Schema } from 'effect';

/** Native event families offered by the administrator's audit filters. */
export const AUDIT_CATEGORIES = [
	'write',
	'approval',
	'identity',
	'automation',
	'integration'
] as const;
/** An event's observed lifecycle; prepared and unknown never claim a committed database change. */
export const AUDIT_STATUSES = [
	'prepared',
	'committed',
	'pendingApproval',
	'refused',
	'conflict',
	'failed',
	'unknown'
] as const;
/** The existing native actor families, projected without credentials or session data. */
export const AUDIT_ACTOR_KINDS = ['member', 'envoy', 'visitor', 'apiKey', 'system'] as const;

/** A stable actor identity and its optional display label at the time of the event. */
export const AuditActor = Schema.Struct({
	kind: Schema.Literals(AUDIT_ACTOR_KINDS),
	id: Schema.NullOr(Schema.NonEmptyString),
	label: Schema.NullOr(Schema.String)
});
export type AuditActor = typeof AuditActor.Type;

/** A historical model identity; removed or renamed models remain searchable. */
export const AuditSubject = Schema.Struct({
	model: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
});
export type AuditSubject = typeof AuditSubject.Type;

const metadata = {
	id: Schema.NonEmptyString,
	operationId: Schema.NonEmptyString,
	at: Schema.String,
	category: Schema.Literals(AUDIT_CATEGORIES),
	action: Schema.NonEmptyString,
	status: Schema.Literals(AUDIT_STATUSES),
	actor: AuditActor,
	subject: Schema.NullOr(AuditSubject),
	invocation: Schema.NullOr(Schema.String),
	transaction: Schema.NullOr(Schema.String),
	run: Schema.NullOr(Schema.String),
	approval: Schema.NullOr(Schema.String)
};

/** An immutable native event; committed or held states require database acknowledgement before append. */
export const AuditEvent = Schema.Struct({ ...metadata, payload: Schema.Json });
export type AuditEvent = typeof AuditEvent.Type;

const stored = {
	recordedAt: Schema.String,
	payloadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
};
/** One list row, without its potentially large payload. */
export const AuditSummary = Schema.Struct({ ...metadata, ...stored });
export type AuditSummary = typeof AuditSummary.Type;
/** The full event returned only when its administrator opens the detail. */
export const AuditRecord = Schema.Struct({ ...metadata, ...stored, payload: Schema.Json });
export type AuditRecord = typeof AuditRecord.Type;

/** A durable preparation awaiting a confirmed terminal event; its full payload is host-only reconciliation input. */
export const AuditPreparedRecord = Schema.Struct({
	...metadata,
	...stored,
	status: Schema.Literal('prepared'),
	payload: Schema.Json
});
export type AuditPreparedRecord = typeof AuditPreparedRecord.Type;

const pageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

/** Typed server filters; after is an opaque cursor bound to these filters and the requested time order. */
export const AuditQuery = Schema.Struct({
	after: Schema.optionalKey(Schema.NonEmptyString),
	order: Schema.optionalKey(Schema.Literals(['newest', 'oldest'])),
	since: Schema.optionalKey(Schema.String),
	until: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	actorKind: Schema.optionalKey(Schema.Literals(AUDIT_ACTOR_KINDS)),
	actorId: Schema.optionalKey(Schema.String),
	category: Schema.optionalKey(Schema.Literals(AUDIT_CATEGORIES)),
	action: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.Literals(AUDIT_STATUSES)),
	model: Schema.optionalKey(Schema.String),
	record: Schema.optionalKey(Schema.String),
	invocation: Schema.optionalKey(Schema.String),
	run: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(pageLimit)
});
export type AuditQuery = typeof AuditQuery.Type;

/** A bounded page in stable occurrence-time and event-id order, with no exact-count scan. */
export const AuditPage = Schema.Struct({
	rows: Schema.Array(AuditSummary),
	next: Schema.NullOr(Schema.String)
});
export type AuditPage = typeof AuditPage.Type;

/** Host-only reconciliation pages proceed oldest first, without letting one unresolved operation block later ones. */
export const AuditPendingQuery = Schema.Struct({
	after: Schema.optionalKey(Schema.NonEmptyString),
	limit: Schema.optionalKey(pageLimit)
});
export type AuditPendingQuery = typeof AuditPendingQuery.Type;

/** Full prepared records without their operation's terminal marker, in stable oldest-first cursor order. */
export const AuditPendingPage = Schema.Struct({
	rows: Schema.Array(AuditPreparedRecord),
	next: Schema.NullOr(Schema.String)
});
export type AuditPendingPage = typeof AuditPendingPage.Type;

/** The environment-bound host facility; callers cannot supply tenant or environment scope. */
export interface AuditPort {
	/** Buffered facilities acknowledge before disk flush; a host crash can lose accepted records. */
	readonly mode: 'durable' | 'buffered' | 'disabled';
	/** Append with the host's declared persistence guarantee; identical ids deduplicate, changed content conflicts. */
	append(events: readonly AuditEvent[], signal: AbortSignal): Promise<void>;
	/** Search includes the full stored payload; list answers contain summaries only. */
	query(query: AuditQuery, signal: AbortSignal): Promise<AuditPage>;
	/** One full event from this facility's environment, or null when that id is absent. */
	detail(id: string, signal: AbortSignal): Promise<AuditRecord | null>;
	/** Prepared operations without `${operationId}:terminal`; this facility is not exposed to page or tenant code. */
	pending(query: AuditPendingQuery, signal: AbortSignal): Promise<AuditPendingPage>;
}
