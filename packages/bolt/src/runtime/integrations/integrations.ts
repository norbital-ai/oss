import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationModule } from '../../authoring/integration-introspection.js';
import {
	AuthoredRuntimeService,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler
} from '../collections/authored.js';
import { Collections } from '../collections/collections.js';
import { AI, Connector, Files, Tasks } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import type { Identity } from '../identity/identity.js';
import { Secrets } from '../secrets/secrets.js';
import { Workspace, describeCause } from '../workspace.js';
import {
	runOutboxDrain,
	DRAIN_BATCH_DEFAULT,
	type ClaimedDelivery,
	type DeliverDependencies
} from './deliver.js';
import { INTEGRATION_HTTP_OPERATION, IntegrationHttpResponse } from './http.js';
import { runPullBinding, type BindingReport, type PullDependencies } from './pull.js';
import { runWebhookDelivery, type LedgerState, type WebhookDependencies } from './webhook.js';

/** Carries integration error through the typed integrations failure channel without losing diagnostic context. */
export class IntegrationError extends Schema.TaggedError<IntegrationError>()(
	'Bolt.Integrations.Error',
	{
		integration: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'integration' as const;
	readonly retryable = false;
}
/**
 * What an operator can see about one integration without opening a database.
 *
 * `pending` and `failed` count the outbound ledger, and `failed` is the one that matters: a
 * delivery that exhausted its retries has to be *findable*, or the platform has quietly dropped
 * something a tenant believes was sent. `pending` was a hard-coded `0` for as long as there was
 * nothing to count.
 */
export const IntegrationStatus = Schema.Struct({
	name: Schema.NonEmptyString,
	enabled: Schema.Boolean,
	cursor: Schema.Json,
	pending: Schema.Number,
	failed: Schema.Number
});
export interface IntegrationStatus extends Schema.Schema.Type<typeof IntegrationStatus> {}
export type Interface = Readonly<{
	readonly install: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<void, IntegrationError | Database.FacilityError>;
	/**
	 * Runs the integration's receive bindings, or the one named by `binding`.
	 *
	 * `binding` exists because a schedule is declared per binding: the host registers one recurrence
	 * per `+integrations.ts` binding and names it here, so an hourly feed and a nightly feed in the
	 * same integration run on their own clocks instead of both on the faster one.
	 */
	readonly pull: (
		effectId: EffectId,
		name: string,
		cursor: Schema.Json,
		binding?: string
	) => Effect.Effect<Schema.Json, IntegrationError | Database.FacilityError>;
	/**
	 * Absorbs one pushed delivery into the collection, if its signature verifies.
	 *
	 * `delivery.body` is the **raw request body**, as a string. It is not a convenience: the source's
	 * digest was taken over exactly those bytes, and a re-serialisation of the parsed document is a
	 * different string for the same JSON. Handing this a parsed payload would make verification
	 * impossible, which is the state the previous signature — `(name, receiptId, input: Schema.Json)` —
	 * left it in.
	 *
	 * The receipt is not a parameter either. It is derived from the header the binding declares or from
	 * the verified digest, because a caller-supplied receipt is a caller-supplied dedup key.
	 */
	readonly receive: (
		effectId: EffectId,
		name: string,
		binding: string,
		delivery: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
	) => Effect.Effect<Schema.Json, IntegrationError | Database.FacilityError>;
	readonly flush: (
		effectId: EffectId,
		name: string,
		input: Schema.Json
	) => Effect.Effect<Schema.Json, IntegrationError | Database.FacilityError>;
	readonly reconcile: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<void, IntegrationError | Database.FacilityError>;
	readonly disable: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<void, IntegrationError | Database.FacilityError>;
	readonly status: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<IntegrationStatus, IntegrationError | Database.FacilityError>;
}>;
/** Identifies the integrations service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Integrations');

/**
 * Who an integration writes as.
 *
 * A pull is enqueued work with no person behind it, so there is no credential to carry and nothing
 * to impersonate. The subject is minted here, once, and it says what it is: the user id is
 * `integration:<name>`, so every row the mirror writes is attributable in `bolt_collection_history`
 * to the integration that wrote it rather than to whoever last touched the workspace.
 *
 * It is an administrator because a mirror writes rows nobody asked for and no row-scoped grant
 * describes that — the authority is the workspace's own declaration, the same authority that
 * installed the integration. That is a real grant and it is deliberately narrow in the one dimension
 * that can be narrowed: the collection is fixed by the declaration, so this subject can only ever
 * reach the table its own `+integrations.ts` named.
 *
 * Stated as the `admin` status rather than as `roles: ['admin']`, which is what it used to be and
 * what never worked: no workspace declares a policy called `admin`, so `subjectHasPolicy` matched
 * nothing and the mirror's authority came from nowhere. The status is the fact being asserted.
 */
const integrationSubject = (name: string): Identity.Subject => ({
	userId: `integration:${name}`,
	tenantId: 'system',
	roles: [],
	teams: [],
	admin: true
});

/**
 * How long one claimed pull may run before the host may start another.
 *
 * The expiry is the guarantee, not the release statement below it: a run killed by a deadline, a
 * crashed isolate or a host that lost the artifact never reaches its own release, and a lease with
 * no expiry would then stop the schedule permanently — a failure that presents as "the mirror
 * silently stopped", which is precisely the class of defect a schedule is supposed to end. Long
 * enough to cover a fifty-page pull whose every page backed off, short enough that a lost lease
 * costs one cycle of any realistic cron rather than a day of them.
 */
const PULL_LEASE = '10 minutes';

/**
 * How long a claimed delivery may stay in flight before another drain may take it back.
 *
 * The same guarantee `PULL_LEASE` makes, for the same reason: a drain killed by a deadline or a
 * lost isolate never reaches its own settlement, and a claim with no expiry would leave that
 * delivery `inflight` forever — visible in `status`, and never sent. Reclaiming it costs at most a
 * duplicate delivery, which is a thing the at-least-once contract and the idempotency key already
 * account for; *not* reclaiming it costs the delivery.
 */
const OUTBOX_CLAIM_LEASE = '10 minutes';

/**
 * Which rows a drain may take: due and pending, or claimed so long ago the claimant must be gone.
 *
 * Written once and used twice — inside the candidate select and again as the outer update's
 * predicate — because those two have to agree exactly. The outer one is the concurrency arbiter: a
 * second drain that computed the same candidates from its own snapshot blocks on the row, re-checks
 * this against the version the first wrote, and finds a fresh `updated_at`.
 */
const OUTBOX_CLAIMABLE = `(status = 'pending' or (status = 'inflight' and updated_at < now() - interval '${OUTBOX_CLAIM_LEASE}'))`;

/**
 * Reads claimed outbox rows back out of the facility's JSON.
 *
 * Defensive per field rather than decoded as a schema, for one specific reason: `sequence` is a
 * `bigint` column and drivers disagree about whether that arrives as a number or as its decimal
 * text. A decode that insisted on one would work against PGlite and fail against node-postgres, or
 * the reverse, and the failure would present as an empty drain rather than as a type error.
 */
const claimedDeliveries = (rows: ReadonlyArray<Schema.Json>): ReadonlyArray<ClaimedDelivery> =>
	rows.flatMap((row) => {
		if (row === null || typeof row !== 'object' || Array.isArray(row)) return [];
		const sequence = Number(Reflect.get(row, 'sequence'));
		const binding = Reflect.get(row, 'binding_name');
		const collection = Reflect.get(row, 'collection_name');
		const recordId = Reflect.get(row, 'record_id');
		const operation = Reflect.get(row, 'operation');
		const path = Reflect.get(row, 'path');
		const payload = Reflect.get(row, 'payload');
		if (
			!Number.isFinite(sequence) ||
			typeof binding !== 'string' ||
			typeof collection !== 'string' ||
			typeof recordId !== 'string' ||
			typeof operation !== 'string'
		)
			return [];
		return [
			{
				sequence,
				binding,
				collection,
				recordId,
				operation,
				path: typeof path === 'string' ? path : null,
				payload: Schema.is(Schema.Json)(payload) ? payload : null,
				attempts: Number(Reflect.get(row, 'attempts')) || 1
			}
		];
	});

const cursorsOf = (value: Schema.Json): Readonly<Record<string, string>> =>
	value === null || typeof value !== 'object' || Array.isArray(value)
		? {}
		: Object.fromEntries(
				Object.entries(value).flatMap(([binding, cursor]) =>
					typeof cursor === 'string' ? [[binding, cursor] as const] : []
				)
			);

/**
 * How many rows one source record is assumed to be able to fan out into.
 *
 * A bound rather than an unbounded read: the lookup exists to find the rows a previous run wrote for
 * these keys, and a mapping that produced more than this per record would be pathological. Sizing it
 * to `keys.length` — one row per key — was the original bug, because it truncated exactly the extra
 * rows a fan-out creates.
 */
const MAX_FAN_OUT = 64;

/** A ceiling on the whole lookup, so a large batch times a wide fan-out still cannot page unboundedly. */
const MAX_EXISTING_ROWS = 5000;

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const connector = yield* Connector.Service;
		const database = yield* Database.Service;
		const tasks = yield* Tasks.Service;
		const collections = yield* Collections.Service;
		const secrets = yield* Secrets.Service;
		const ai = yield* AI.Service;
		const files = yield* Files.Service;
		const authored = yield* AuthoredRuntimeService;
		const requireIntegration = Effect.fn('Integrations.require')(function* (name: string) {
			const integration = workspace.definition.integrations.find(
				(candidate) => candidate.name === name
			);
			if (integration === undefined)
				return yield* new IntegrationError({ integration: name, message: 'Unknown integration' });
			return integration;
		});

		/**
		 * The physical work a pull needs, bound once to this invocation's services.
		 *
		 * Assembled here rather than inside `pull.ts` so the loop has no idea what a facility is: it asks
		 * for a request and gets a response, asks for existing rows and gets a map. That is what makes
		 * every branch of it — paging, backoff, partial failure — testable without a database.
		 */
		const dependencies = (
			integrationName: string,
			subject: Identity.Subject
		): PullDependencies => ({
			request: (effectId, connectorName, descriptor) =>
				connector
					.execute(effectId, {
						connector: connectorName,
						operation: INTEGRATION_HTTP_OPERATION,
						input: {
							method: descriptor.method,
							url: descriptor.url,
							headers: descriptor.headers,
							...(descriptor.body === undefined ? {} : { body: descriptor.body })
						}
					})
					.pipe(
						Effect.flatMap((response) =>
							Schema.decodeUnknownEffect(IntegrationHttpResponse)(response.output).pipe(
								Effect.mapError((issue) => ({
									message: `connector answered something that is not an HTTP response: ${describeCause(issue)}`,
									retryable: false
								}))
							)
						),
						// A facility failure the host marked retryable is a transport hiccup; one it did not is a
						// refusal, and the retry policy needs to be able to tell them apart.
						Effect.catch((error) =>
							error instanceof Database.FacilityError
								? Effect.fail({ message: error.message, retryable: error.retryable })
								: Effect.fail(error)
						)
					),
			secret: (effectId, name) =>
				secrets.read(effectId, name).pipe(
					Effect.mapError((error) => ({ message: describeCause(error) })),
					Effect.flatMap((value) =>
						value === null
							? Effect.fail({
									message: `${integrationName} needs the environment variable ${name}, and the vault has no value for it`
								})
							: Effect.succeed(value)
					)
				),
			existing: (effectId, collection, column, keys) =>
				collections
					.findMany(effectId, subject, {
						collection,
						predicate: { _tag: 'In', field: column, values: [...keys] },
						// Not `keys.length`: a record may fan out into several rows sharing one identity value, and
						// a limit sized for one row per key truncates the very rows that make a re-run an update
						// rather than a duplicate. Bounded well above any sane fan-out so a runaway mapping still
						// cannot pull an unbounded page into memory.
						limit: Math.min(keys.length * MAX_FAN_OUT, MAX_EXISTING_ROWS)
					})
					.pipe(
						Effect.map((rows) => {
							const found = new Map<string, Array<string>>();
							for (const row of rows) {
								if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
								const key = Reflect.get(row, column);
								const id = Reflect.get(row, 'norbital_id');
								if (typeof key !== 'string' || typeof id !== 'string') continue;
								const bucket = found.get(key);
								if (bucket === undefined) found.set(key, [id]);
								else bucket.push(id);
							}
							// Sorted so `before[offset]` is a stable address across runs: the derived ids do not come
							// back from the database in any guaranteed order, and an unstable pairing would rewrite
							// each fanned-out row into a different sibling's id on every run.
							for (const bucket of found.values()) bucket.sort();
							return found;
						}),
						Effect.mapError((error) => ({ message: describeCause(error) }))
					),
			remove: (effectId, collection, ids) =>
				Effect.forEach(ids, (id) => collections.delete(effectId, subject, collection, id), {
					discard: true
				}).pipe(Effect.mapError((error) => ({ message: describeCause(error) }))),
			write: (effectId, collection, id, values, mode) =>
				(mode === 'create'
					? collections.create(effectId, subject, { collection, id, values })
					: collections.update(effectId, subject, { collection, id, values })
				).pipe(Effect.mapError((error) => ({ message: describeCause(error) }))),
			pipeline: (effectId, collection, record) => {
				const declared = authored.pipelines[collection]?.import;
				if (declared === undefined) return undefined;
				// One record per call, so a pipeline that refuses a record costs that record. The `input` it
				// receives is an array of one, which is the shape `Collections.import` already hands it.
				const api = makeAuthoringApi(
					makeBoundAuthoringOps(effectId, subject, collections, ai, files)
				);
				return Effect.suspend(() =>
					runAuthoredHandler(declared.handler({ input: [record], api }, api))
				).pipe(
					Effect.flatMap((rows) =>
						Array.isArray(rows)
							? Effect.succeed(
									rows.flatMap((row) =>
										row !== null && typeof row === 'object' && !Array.isArray(row)
											? [row as Readonly<Record<string, unknown>>]
											: []
									)
								)
							: Effect.fail({
									message: `the import pipeline for ${collection} returned something that is not a list of rows`
								})
					),
					Effect.catch((error) => Effect.fail({ message: describeCause(error) }))
				);
			},
			resolve: (effectId, run) => {
				// The same api a hook and an import pipeline receive, built through the same two functions, so
				// a batch lookup queries under exactly the integration's own subject and nothing wider.
				const api = makeAuthoringApi(
					makeBoundAuthoringOps(effectId, subject, collections, ai, files)
				);
				// `catchCause` rather than `catch`: an authored `resolve` may throw synchronously, and a
				// rejected promise arrives here as a defect because `runAuthoredHandler` dies on one. Either
				// would otherwise escape as an unhandled defect and take down a run that should have failed
				// with a sentence naming the integration.
				return Effect.suspend(() => runAuthoredHandler(run(api))).pipe(
					Effect.catchCause((cause) =>
						Effect.fail({
							message: `${integrationName} failed to resolve a batch: ${describeCause(cause)}`
						})
					)
				);
			},
			sleep: (milliseconds) => Effect.sleep(milliseconds),
			now: () => Date.now()
		});

		/**
		 * The physical work a pushed delivery needs, which is the pull's set plus the delivery ledger.
		 *
		 * Built on top of `dependencies` rather than beside it, so the secret a webhook verifies against is
		 * resolved by literally the same function that resolves a pull's bearer token: one vault read, one
		 * "the vault has no value for it" message, one place where a missing secret is refused. A second
		 * resolver would be a second place for the two to disagree about what a configured secret is.
		 */
		const webhookDependencies = (
			integrationName: string,
			subject: Identity.Subject
		): WebhookDependencies => {
			const bound = dependencies(integrationName, subject);
			return {
				existing: bound.existing,
				remove: bound.remove,
				write: bound.write,
				pipeline: bound.pipeline,
				resolve: bound.resolve,
				secret: bound.secret,
				now: bound.now,
				/**
				 * Records the delivery and answers what the ledger held before.
				 *
				 * `on conflict do nothing ... returning` is the arbiter rather than a preceding `select`,
				 * because providers retry in parallel and two concurrent deliveries of one event would both
				 * read an empty table and both absorb. Postgres returns a row only to the insert that won, so
				 * exactly one caller sees `new`.
				 */
				remember: (effectId, entry) =>
					database
						.execute(effectId, {
							_tag: 'Query',
							sql: "insert into bolt_integration_inbox (integration_name, binding_name, receipt_id, payload, status) values ($1, $2, $3, $4, 'pending') on conflict (integration_name, receipt_id) do nothing returning receipt_id",
							parameters: [integrationName, entry.binding, entry.receiptId, entry.payload]
						})
						.pipe(
							Effect.flatMap((inserted): Effect.Effect<LedgerState, Database.FacilityError> =>
								inserted.rows.length === 1
									? Effect.succeed('new')
									: database
											.execute(effectId, {
												_tag: 'Query',
												sql: 'select status from bolt_integration_inbox where integration_name = $1 and receipt_id = $2',
												parameters: [integrationName, entry.receiptId]
											})
											.pipe(
												Effect.map((existing) => {
													const row = existing.rows[0];
													const status =
														row === null ||
														row === undefined ||
														typeof row !== 'object' ||
														Array.isArray(row)
															? undefined
															: Reflect.get(row, 'status');
													// Anything other than a recorded `absorbed` is treated as unfinished and
													// absorbed again. The upsert makes that harmless, and the opposite default
													// would silently drop the redelivery meant to finish an interrupted batch.
													return status === 'absorbed' ? 'absorbed' : 'pending';
												})
											)
							),
							Effect.mapError((error) => ({ message: describeCause(error) }))
						),
				settle: (effectId, entry) =>
					database
						.execute(effectId, {
							_tag: 'Query',
							sql: "update bolt_integration_inbox set status = 'absorbed', processed_at = now() where integration_name = $1 and receipt_id = $2",
							parameters: [entry.integration, entry.receiptId]
						})
						.pipe(
							Effect.asVoid,
							Effect.mapError((error) => ({ message: describeCause(error) }))
						)
			};
		};

		/**
		 * The physical work a drain needs: the pull's request and credential, plus the outbound ledger.
		 *
		 * Built on `dependencies` for the reason `webhookDependencies` is — the credential a send presents
		 * is resolved by literally the same function that resolves a pull's bearer token, so a
		 * header-authenticated connection cannot work in one direction and not the other.
		 */
		const deliverDependencies = (integrationName: string): DeliverDependencies => {
			const bound = dependencies(integrationName, integrationSubject(integrationName));
			return {
				request: bound.request,
				secret: bound.secret,
				now: bound.now,
				/**
				 * Claims the next due deliveries and marks them in flight, in one statement.
				 *
				 * Two things are happening here and both are load-bearing.
				 *
				 * The inner `distinct on (collection_name, record_id)` is the **ordering guarantee**: only the
				 * lowest pending sequence for each record is ever a candidate, so two updates to one row go
				 * out in the order they happened and the second waits while the first is backing off. The
				 * due-time filter is applied *after* that pick rather than inside it — filtering first would
				 * skip a record's backing-off head and select the delivery behind it, which is exactly the
				 * silent reordering this is written to prevent.
				 *
				 * The outer `OUTBOX_CLAIMABLE` is the **concurrency arbiter**, and the same predicate is what
				 * recovers an abandoned claim. A cron drain and a manual flush genuinely overlap, and both
				 * would compute the same candidate set from their own snapshot; under read-committed the
				 * second update blocks on the row and then re-checks this predicate against the version the
				 * first one wrote, sees a fresh `updated_at`, and skips. A drain that instead *died* leaves
				 * the same `inflight` row with an `updated_at` that keeps ageing, so the lease expires and
				 * the next drain takes it back rather than leaving it queued forever.
				 */
				claim: (effectId, integrationName_, limit) =>
					database
						.execute(effectId, {
							_tag: 'Query',
							sql: `update bolt_integration_outbox set status = 'inflight', attempts = attempts + 1, updated_at = now()
						where sequence in (
							select head.sequence from (
								select distinct on (collection_name, record_id) sequence, next_attempt_at
								from bolt_integration_outbox
								where integration_name = $1 and ${OUTBOX_CLAIMABLE}
								order by collection_name, record_id, sequence
							) head
							where head.next_attempt_at <= now()
							order by head.sequence
							limit $2
						)
						and ${OUTBOX_CLAIMABLE}
						returning sequence, binding_name, collection_name, record_id, operation, path, payload, attempts`,
							parameters: [integrationName_, limit]
						})
						.pipe(
							// Sorted here rather than trusted from `returning`, which has no defined order: the
							// drain delivers in the order it reads, so an unsorted batch would undo the ordering the
							// claim just went to the trouble of establishing.
							Effect.map((result) =>
								claimedDeliveries(result.rows).toSorted(
									(left, right) => left.sequence - right.sequence
								)
							),
							Effect.mapError((error) => ({ message: describeCause(error) }))
						),
				settle: (effectId, settlement) =>
					database
						.execute(
							effectId,
							settlement._tag === 'Delivered'
								? {
										_tag: 'Query',
										sql: "update bolt_integration_outbox set status = 'delivered', delivered_at = now(), last_status = $2, last_error = null, updated_at = now() where sequence = $1",
										parameters: [settlement.sequence, settlement.status]
									}
								: settlement._tag === 'Retry'
									? {
											_tag: 'Query',
											// Back to `pending` with a future due time. The backoff lives in the row rather
											// than in a sleep, so a partner that is down for an hour costs an hour of ticks
											// and not an invocation held open until a host's deadline kills it.
											sql: "update bolt_integration_outbox set status = 'pending', next_attempt_at = now() + ($4::double precision * interval '1 millisecond'), last_status = $2, last_error = $3, updated_at = now() where sequence = $1",
											parameters: [
												settlement.sequence,
												settlement.status,
												settlement.reason,
												settlement.delayMs
											]
										}
									: {
											_tag: 'Query',
											sql: "update bolt_integration_outbox set status = 'failed', last_status = $2, last_error = $3, updated_at = now() where sequence = $1",
											parameters: [settlement.sequence, settlement.status, settlement.reason]
										}
						)
						.pipe(
							Effect.asVoid,
							Effect.mapError((error) => ({ message: describeCause(error) }))
						)
			};
		};

		/**
		 * Claims the exclusive right to pull this integration, and reads the resumption point with it.
		 *
		 * One statement rather than a read followed by a write, because the two-statement version is the
		 * race: with the schedule now firing pulls on its own clock, a slow run and the next tick overlap,
		 * both read the same stored cursor, and the one that finishes second persists a cursor computed
		 * from a page the first had already moved past. Nothing errors; the mirror just re-reads the same
		 * window forever.
		 *
		 * Returns `null` when another run holds the lease — `on conflict do update ... where` updates no
		 * row and therefore returns none, so "somebody else is pulling" and "I now hold it" are told
		 * apart by the row count rather than by a second query that could be stale by the time it runs.
		 */
		const claimPull = Effect.fn('Integrations.claimPull')(function* (
			effectId: EffectId,
			name: string
		) {
			const result = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `insert into bolt_integrations (name, enabled, cursor, lease_until) values ($1, true, null, now() + interval '${PULL_LEASE}') on conflict (name) do update set lease_until = excluded.lease_until where bolt_integrations.lease_until is null or bolt_integrations.lease_until < now() returning cursor`,
				parameters: [name]
			});
			const row = result.rows[0];
			if (row === undefined) return null;
			const value =
				row === null || typeof row !== 'object' || Array.isArray(row)
					? null
					: Reflect.get(row, 'cursor');
			return { cursor: Schema.is(Schema.Json)(value) ? value : null };
		});

		/**
		 * Persists what this run advanced and hands the lease back.
		 *
		 * The merge happens in the database — `cursor || $2` — rather than in this process. A run that
		 * pulled one binding must leave every other binding's cursor exactly as it found it, and a
		 * client-side `{ ...stored, ...advanced }` cannot promise that: `stored` is a snapshot from the
		 * top of the run, so it writes back a stale value for every binding it did not touch.
		 */
		const releasePull = (
			effectId: EffectId,
			name: string,
			cursors: Readonly<Record<string, string>>
		) =>
			database.execute(effectId, {
				_tag: 'Query',
				sql: "update bolt_integrations set cursor = coalesce(cursor, '{}'::jsonb) || $2::jsonb, lease_until = null, updated_at = now() where name = $1",
				parameters: [name, cursors]
			});

		return Service.of({
			install: Effect.fn('Integrations.install')(function* (effectId, name) {
				yield* requireIntegration(name);
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_integrations (name, enabled, cursor) values ($1, true, $2) on conflict (name) do update set enabled = true',
					parameters: [name, null]
				});
				yield* tasks.execute(effectId, {
					_tag: 'Enqueue',
					command: 'integrations.pull',
					input: { name, cursor: null }
				});
			}),
			/**
			 * Runs every receive binding this integration declares, and returns what each one did.
			 *
			 * `cursor` is an override, not the resumption point: pass `null` — which is what the enqueued
			 * task carries — and each binding resumes from the cursor the last run persisted. Pass a
			 * `{ binding: cursor }` object to replay from a chosen point, which is what a backfill is.
			 *
			 * A binding that fails does not stop the ones after it, and the cursor is written for every
			 * binding that got as far as reading a page. The report is the return value rather than a log
			 * line because "the pull ran" and "the pull imported nothing" look identical from the outside,
			 * and only one of them is fine.
			 *
			 * `binding` narrows the run to one, which is what the host's schedule sends: each binding
			 * declares its own cron and is registered on its own. A run that could not claim the lease
			 * answers `skipped: true` rather than failing — the next tick of a cron is not an error, and a
			 * scheduled pull that reported failure every time a longer one was still running would page
			 * somebody nightly about a system working exactly as designed.
			 */
			pull: Effect.fn('Integrations.pull')(function* (effectId, name, cursor, binding) {
				const integration = yield* requireIntegration(name);
				const module: AuthoredIntegrationModule | undefined = authored.integrations[name];
				if (module === undefined) {
					return yield* new IntegrationError({
						integration: name,
						message: `${name} is declared but its authored module did not reach the runtime`
					});
				}
				const selected =
					binding === undefined
						? integration.receive
						: integration.receive.filter((candidate) => candidate.name === binding);
				// A schedule that names a binding the workspace no longer declares is a broken registration,
				// not an empty run: reporting "0 bindings, no failures" would look identical to a feed that
				// had nothing new, and the host would never learn its registration had gone stale.
				if (selected.length === 0) {
					return yield* new IntegrationError({
						integration: name,
						message: `${name} declares no receive binding named ${String(binding)}`
					});
				}
				const claim = yield* claimPull(effectId, name);
				if (claim === null) {
					return {
						integration: name,
						collection: integration.collection,
						skipped: true,
						reason: 'another run of this integration still holds the pull lease',
						bindings: [],
						failures: []
					};
				}
				const overrides = cursorsOf(cursor);
				const stored = cursorsOf(claim.cursor);
				const subject = integrationSubject(name);
				const bound = dependencies(name, subject);
				const reports: Array<BindingReport> = [];
				const failures: Array<{ readonly binding: string; readonly reason: string }> = [];
				for (const declared of selected) {
					const authoredBinding = module.receive[declared.name];
					if (authoredBinding === undefined) {
						failures.push({
							binding: declared.name,
							reason: 'the authored binding did not reach the runtime'
						});
						continue;
					}
					const from = overrides[declared.name] ?? stored[declared.name] ?? null;
					const outcome = yield* Effect.result(
						runPullBinding(bound, effectId, integration, declared, authoredBinding, from)
					);
					if (Result.isFailure(outcome)) {
						failures.push({ binding: declared.name, reason: outcome.failure.message });
						continue;
					}
					reports.push(outcome.success);
				}
				// Only what this run advanced. Everything else is left to the database's own merge, so a
				// binding this run did not touch keeps whatever the run that did touch it wrote.
				const cursors: Record<string, string> = {};
				for (const report of reports)
					if (report.cursor !== null) cursors[report.binding] = report.cursor;
				yield* releasePull(effectId, name, cursors);
				return {
					integration: name,
					collection: integration.collection,
					skipped: false,
					// Stated as `null` rather than omitted, so both shapes this function returns have the same
					// keys and a reader never has to tell "no reason" from "a key this branch does not carry".
					reason: null,
					bindings: reports.map((report) => ({
						...report,
						rejected: report.rejected.map(({ index, reason }) => ({ index, reason }))
					})),
					failures
				};
			}),
			/**
			 * Absorbs one pushed delivery, if it proves it came from the source.
			 *
			 * The signature is the credential. Everything else about a webhook is attacker-controlled by
			 * construction: the route is public, the body is whatever was posted, and the headers are
			 * whatever was sent. So the only question worth asking first is whether the bytes carry a digest
			 * that only a holder of the declared secret could have produced, and this refuses before it
			 * reads anything if they do not.
			 *
			 * `body` is a string and not the parsed document, and that is not an inconvenience to route
			 * around — it is the requirement. The digest was taken over the exact bytes the source sent, and
			 * `JSON.stringify(JSON.parse(body))` is a different string for the same document. The previous
			 * shape of this method took `input: Schema.Json` and a caller-supplied `receiptId`, which could
			 * not have verified anything even if there had been code here to verify it with.
			 *
			 * Nothing here trusts the caller for identity either. The receipt is derived from a header the
			 * source set or from the verified digest, and each record's identity is read through the
			 * binding's declared `identity` — never from a field the body nominates.
			 */
			receive: Effect.fn('Integrations.receive')(function* (effectId, name, bindingName, delivery) {
				const integration = yield* requireIntegration(name);
				const binding = integration.webhooks.find((candidate) => candidate.name === bindingName);
				if (binding === undefined) {
					// Named rather than fallen through to a generic handler. A route that answers "fine" for a
					// binding nobody declared is the shape of the unauthenticated command port this codebase
					// already shipped once.
					return yield* new IntegrationError({
						integration: name,
						message: `${name} declares no webhook binding named ${bindingName}`
					});
				}
				const module: AuthoredIntegrationModule | undefined = authored.integrations[name];
				const authoredBinding = module?.receive[bindingName];
				if (authoredBinding === undefined) {
					return yield* new IntegrationError({
						integration: name,
						message: `${name}.${bindingName} is declared but its authored binding did not reach the runtime`
					});
				}
				const subject = integrationSubject(name);
				const report = yield* runWebhookDelivery(
					webhookDependencies(name, subject),
					effectId,
					integration,
					binding,
					authoredBinding,
					delivery
				).pipe(
					Effect.mapError(
						(error) => new IntegrationError({ integration: name, message: error.message })
					)
				);
				return { integration: name, collection: integration.collection, ...report };
			}),
			/**
			 * Drains this integration's outbox: the sending half of the pattern.
			 *
			 * Nothing here decides *whether* to send. That was decided on the write path, inside the same
			 * transaction as the row, by the binding's own trigger — so by the time this runs the queue is
			 * a list of facts about writes that already committed, and this is only responsible for getting
			 * them there and recording what happened.
			 *
			 * That split is the answer to the question a send binding actually poses. A hook firing the
			 * request inline is the obvious shape and the wrong one: every create in the collection would
			 * then wait on a partner's response time, a partner's outage would present to a tenant as a
			 * failed write, and a crash between the commit and the request would lose the event with no
			 * trace. Enqueue-then-drain costs a delay — a delivery is sent on the next drain rather than in
			 * the same millisecond — and that is the price of the other three properties.
			 *
			 * `input` may narrow the batch (`{ limit }`). It carries no delivery identity and no payload:
			 * what is sent is what the write path queued, and a caller that could name a delivery could
			 * replay one.
			 */
			flush: Effect.fn('Integrations.flush')(function* (effectId, name, input) {
				const integration = yield* requireIntegration(name);
				if (integration.send.length === 0) {
					// Refused rather than answered with an empty report, for the reason a scheduled pull
					// refuses a binding the workspace no longer declares: "drained nothing" and "there is
					// nothing here that could ever be drained" look identical from a host's side, and a
					// registration pointing at a removed binding should be discoverable.
					return yield* new IntegrationError({
						integration: name,
						message: `${name} declares no send binding, so it has no outbox to flush.`
					});
				}
				const limit =
					input !== null &&
					typeof input === 'object' &&
					!Array.isArray(input) &&
					typeof Reflect.get(input, 'limit') === 'number'
						? Number(Reflect.get(input, 'limit'))
						: DRAIN_BATCH_DEFAULT;
				const report = yield* runOutboxDrain(
					deliverDependencies(name),
					effectId,
					integration,
					limit
				).pipe(
					Effect.mapError(
						(error) => new IntegrationError({ integration: name, message: error.message })
					)
				);
				return {
					integration: report.integration,
					collection: report.collection,
					claimed: report.claimed,
					delivered: report.delivered,
					retrying: report.retrying,
					failed: report.failed,
					deliveries: report.deliveries.map((delivery) => ({ ...delivery }))
				};
			}),
			reconcile: Effect.fn('Integrations.reconcile')(function* (effectId, name) {
				yield* requireIntegration(name);
				// A reconcile is a full re-read: the cursor is cleared first, so the enqueued pull starts
				// from the beginning and the idempotent upsert absorbs everything it has already seen.
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'update bolt_integrations set cursor = null where name = $1',
					parameters: [name]
				});
				yield* tasks.execute(effectId, {
					_tag: 'Enqueue',
					command: 'integrations.pull',
					input: { name, cursor: null }
				});
			}),
			disable: Effect.fn('Integrations.disable')(function* (effectId, name) {
				yield* requireIntegration(name);
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'update bolt_integrations set enabled = false where name = $1',
					parameters: [name]
				});
			}),
			status: Effect.fn('Integrations.status')(function* (effectId, name) {
				yield* requireIntegration(name);
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'select enabled, cursor from bolt_integrations where name = $1',
					parameters: [name]
				});
				const row = result.rows[0];
				const record =
					row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)
						? undefined
						: row;
				const cursor = record === undefined ? null : Reflect.get(record, 'cursor');
				// The outbound queue's depth, counted rather than assumed. `inflight` counts as pending
				// because a drain that died mid-batch left rows in it, and reporting those as neither
				// pending nor failed is how a stuck queue looks empty.
				const outbox = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: "select count(*) filter (where status in ('pending', 'inflight')) as pending, count(*) filter (where status = 'failed') as failed from bolt_integration_outbox where integration_name = $1",
					parameters: [name]
				});
				const counts = outbox.rows[0];
				const counted = (key: string): number => {
					const value =
						counts === null ||
						counts === undefined ||
						typeof counts !== 'object' ||
						Array.isArray(counts)
							? undefined
							: Reflect.get(counts, key);
					return Number(value ?? 0) || 0;
				};
				return {
					name,
					enabled: record !== undefined && Reflect.get(record, 'enabled') === true,
					cursor: Schema.is(Schema.Json)(cursor) ? cursor : null,
					pending: counted('pending'),
					failed: counted('failed')
				};
			})
		});
	})
);
export * as Integrations from './integrations.js';
