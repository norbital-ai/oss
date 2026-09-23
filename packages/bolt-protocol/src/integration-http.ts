import { Schema } from 'effect';

/**
 * The one connector operation an integration performs, and its two message shapes.
 *
 * `ConnectorRequest` in the protocol is `{ connector, operation, input: Json }` — deliberately
 * open, because a connector is whatever a host binds. An integration needs exactly one thing from
 * it: send this HTTP request, give me back the status, the headers and the body. Stating that as a
 * schema here rather than inventing a second protocol field means every host already speaks it: the
 * request rides in `input` and the response rides in `output`, both plain JSON.
 *
 * The runtime plans the request — it resolves the credential, appends the cursor, walks the pages —
 * and the host performs it. That split is the whole point of the facility boundary: Bolt never
 * opens a socket, and a host can refuse an egress its policy does not allow without Bolt having to
 * know what that policy is.
 */
export const INTEGRATION_HTTP_OPERATION = 'http.request';

/**
 * The methods an integration may ask a host to perform.
 *
 * A pull only ever needs the first two. The rest arrived with outbound delivery, where they are not
 * decoration: a binding that mirrors a record into somebody else's system replaces it with `PUT`,
 * amends it with `PATCH` and withdraws it with `DELETE`, and collapsing all three into `POST` would
 * mean every update created a duplicate over there.
 */
const IntegrationHttpMethod = Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const IntegrationHttpRequest = Schema.Struct({
	method: IntegrationHttpMethod,
	url: Schema.NonEmptyString,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.optionalKey(Schema.Json)
});
export interface IntegrationHttpRequest extends Schema.Schema.Type<typeof IntegrationHttpRequest> {}

export const IntegrationHttpResponse = Schema.Struct({
	status: Schema.Number,
	/** Lower-cased by the performer, so `nextCursorHeader: 'X-Next-Cursor'` and `x-next-cursor` are the same header. */
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.Json
});
export interface IntegrationHttpResponse extends Schema.Schema.Type<
	typeof IntegrationHttpResponse
> {}

/** One sync's lifecycle (integrations.md §7). */
export const SyncState = Schema.Literals([
	'unlinked',
	'backfilling',
	'live',
	'reconciling',
	'paused',
	'failed'
]);
export type SyncState = typeof SyncState.Type;

/** What one backfill or reconcile did: counts per class, and up to 20 sample identities each. */
export const SyncReport = Schema.Struct({
	mode: Schema.Literals(['backfill', 'changes', 'reconcile']),
	finishedAt: Schema.String,
	matched: Schema.Number,
	created: Schema.Number,
	updated: Schema.Number,
	deleted: Schema.Number,
	pushed: Schema.Number,
	unmatched: Schema.Number,
	rejected: Schema.Number,
	conflicts: Schema.Number,
	samples: Schema.Record(Schema.String, Schema.Array(Schema.String))
});
export interface SyncReport extends Schema.Schema.Type<typeof SyncReport> {}

export const IntegrationSyncStatus = Schema.Struct({
	integration: Schema.NonEmptyString,
	sync: Schema.NonEmptyString,
	collection: Schema.NonEmptyString,
	direction: Schema.Literals(['one_way', 'two_way']),
	state: SyncState,
	detail: Schema.NullOr(Schema.String),
	/** The consistency bound: the slowest path a change may take (§8.5). */
	bound: Schema.Struct({
		subscribe: Schema.Boolean,
		changes: Schema.NullOr(Schema.String),
		reconcile: Schema.String
	}),
	page: Schema.NullOr(Schema.Number),
	report: Schema.NullOr(SyncReport),
	pending: Schema.Number,
	deadLetters: Schema.Number,
	conflicts: Schema.Number
}).annotate({ identifier: 'BoltIntegrationSyncStatus' });
export interface IntegrationSyncStatus extends Schema.Schema.Type<typeof IntegrationSyncStatus> {}
