import { Clock, Context, Effect, Layer, Result, Schema } from 'effect';
import { EffectId, type IntegrationSyncStatus, type SyncReport } from '@norbital-ai/bolt-protocol';
import type {
	AuthoredSync,
	HttpRecordsSpec,
	IntegrationDeclaration,
	SyncDeclaration
} from '#lib/authoring/integrations-schema.js';
import type { HttpConnection } from '#lib/authoring/contracts-schema.js';
import {
	AuthoredRuntimeService,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler
} from '#lib/runtime/collections/authored.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import { AI, Connector, Files } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { integrationSubject } from '#lib/runtime/identity/static-identity.js';
import {
	canonical,
	contentVersion,
	localChanges,
	mergeRemote,
	same,
	syncedValues,
	versionOrder,
	type Conflict
} from '#lib/runtime/integrations/engine.js';
import { place, resolveConnection, retryDelayMs, walk } from '#lib/runtime/integrations/http.js';
import { verifyDelivery } from '#lib/runtime/integrations/signature.js';
import { describeSourceFailure, httpSource, type SourceAdapter, type SourceFailure } from '#lib/runtime/integrations/sources.js';
import { Secrets } from '#lib/runtime/secrets/secrets.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { describeCause } from '#lib/runtime/workspace.js';

/** Carries an integration failure through its typed channel without losing the sentence. */
export class IntegrationError extends Schema.TaggedError<IntegrationError>()('Bolt.Integrations.Error', {
	integration: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'integration' as const;
	readonly retryable = false;
}

type Values = Readonly<Record<string, unknown>>;
type Failure = IntegrationError | Database.FacilityError;

/** Pages one run may read before it hands the rest of a sweep to a continuation (§13.4). */
const PAGE_BUDGET = 20;
/** Markers one push drains before it re-queues itself. */
const PUSH_BATCH = 50;
/** How long one claimed run may hold a sync before another may start. */
const LEASE_SECONDS = 600;
const SAMPLES = 20;

const syncKey = (integration: string, sync: string): string => `${integration}.${sync}`;

const Row = Schema.Record(Schema.String, Schema.Unknown);
const decodeRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<Values> =>
	rows.flatMap((row) => {
		const decoded = Schema.decodeUnknownResult(Row)(row);
		return Result.isSuccess(decoded) ? [decoded.success] : [];
	});
const text = (value: unknown): string | null =>
	typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
const numeric = (value: unknown): number => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

type Counts = Record<
	'matched' | 'created' | 'updated' | 'deleted' | 'pushed' | 'unmatched' | 'rejected' | 'conflicts',
	number
>;
const emptyCounts = (): Counts => ({
	matched: 0,
	created: 0,
	updated: 0,
	deleted: 0,
	pushed: 0,
	unmatched: 0,
	rejected: 0,
	conflicts: 0
});
type Sweep = {
	readonly id: string;
	readonly mode: 'backfill' | 'reconcile';
	page: number;
	pageCursor: string | null;
	counts: Counts;
	samples: Record<string, Array<string>>;
	complete: boolean;
};
const Sweep = Schema.Struct({
	id: Schema.String,
	mode: Schema.Literals(['backfill', 'reconcile']),
	page: Schema.Number,
	pageCursor: Schema.NullOr(Schema.String),
	counts: Schema.Record(Schema.String, Schema.Number),
	samples: Schema.Record(Schema.String, Schema.Array(Schema.String)),
	complete: Schema.Boolean
});

type Link = Readonly<{
	readonly record_id: string;
	readonly identity: string | null;
	readonly status: string;
	readonly shadow: Values;
	readonly version: string | null;
}>;

/** One remote record, decoded and mapped to local form, or a tombstone. */
type Change =
	| Readonly<{
			readonly kind: 'upsert';
			readonly identity: string;
			readonly version: string;
			readonly values: Values;
			readonly key?: string;
	  }>
	| Readonly<{ readonly kind: 'tombstone'; readonly identity: string }>;

/** A channel message as a channel-sourced sync reads it. */
export type ChannelRecord = Readonly<{
	readonly record: Values;
	readonly identity: string;
	readonly version: string;
	readonly deleted: boolean;
}>;

export type Interface = Readonly<{
	/** A scheduled or manual run: `changes` reads the delta; `reconcile` sweeps (a first one backfills). */
	readonly run: (
		effectId: EffectId,
		integration: string,
		sync: string,
		mode: 'changes' | 'reconcile'
	) => Effect.Effect<Schema.Json, Failure>;
	/** Drains local intent to the source (two-way). */
	readonly push: (effectId: EffectId, integration: string, sync: string) => Effect.Effect<Schema.Json, Failure>;
	/** One raw webhook delivery for a sync whose source subscribes by webhook. */
	readonly receive: (
		effectId: EffectId,
		integration: string,
		sync: string,
		delivery: Readonly<{ readonly headers: Readonly<Record<string, string>>; readonly body: string }>
	) => Effect.Effect<Schema.Json, Failure>;
	/** A channel's history changed: every sync sourced from it applies the change (subscribe). */
	readonly applyChannel: (
		effectId: EffectId,
		channel: string,
		records: ReadonlyArray<ChannelRecord>
	) => Effect.Effect<void, Failure>;
	readonly status: (effectId: EffectId) => Effect.Effect<ReadonlyArray<IntegrationSyncStatus>, Failure>;
	readonly control: (
		effectId: EffectId,
		integration: string,
		sync: string,
		action: 'start' | 'reconcile' | 'pause' | 'resume' | 'retry'
	) => Effect.Effect<Schema.Json, Failure>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Integrations');

type LayerServices =
	| Workspace.Interface
	| Database.Interface
	| TaskQueue.Interface
	| Collections.Interface
	| TenantScope.Interface
	| import('#lib/runtime/facilities/services.js').ConnectorInterface
	| import('#lib/runtime/facilities/services.js').AIInterface
	| import('#lib/runtime/facilities/services.js').FilesInterface
	| import('#lib/runtime/secrets/secrets.js').Interface
	| import('#lib/runtime/collections/authored.js').AuthoredRuntime;

export const layer: Layer.Layer<Interface, never, LayerServices> = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const database = yield* Database.Service;
		const queue = yield* TaskQueue.Service;
		const collections = yield* Collections.Service;
		const tenant = yield* TenantScope.Service;
		const connector = yield* Connector.Service;
		const ai = yield* AI.Service;
		const files = yield* Files.Service;
		const secrets = yield* Secrets.Service;
		const authored = yield* AuthoredRuntimeService;

		const query = (effectId: EffectId, sql: string, parameters: ReadonlyArray<Schema.Json>) =>
			database.execute(effectId, { _tag: 'Query', sql, parameters });
		const transaction = (
			effectId: EffectId,
			statements: ReadonlyArray<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }>
		) => database.execute(effectId, { _tag: 'Transaction', statements });

		const refuse = (integration: string, message: string) => new IntegrationError({ integration, message });

		const requireSync = Effect.fn('Integrations.requireSync')(function* (integration: string, sync: string) {
			const declared = workspace.definition.integrations.find(({ name }) => name === integration);
			const found = declared?.syncs.find(({ name }) => name === sync);
			const live = authored.integrations[integration]?.[sync];
			if (declared === undefined || found === undefined || live === undefined)
				return yield* refuse(integration, `Unknown sync ${syncKey(integration, sync)}`);
			return { integration: declared, sync: found, live };
		});

		const subjectOf = (integration: IntegrationDeclaration): Identity.Subject =>
			integrationSubject(integration, tenant.tenantId);

		const secretReader = (integration: string) => (effectId: EffectId, name: string) =>
			secrets.read(effectId, name).pipe(
				Effect.mapError((error) => ({ message: describeCause(error) })),
				Effect.flatMap((value) =>
					value === null || value === ''
						? Effect.fail({ message: `${integration} needs the environment variable ${name}, and the vault has no value for it` })
						: Effect.succeed(value)
				)
			);

		/** The source adapter one sync calls. A channel source reads the channel's own history. */
		const sourceFor = (integration: IntegrationDeclaration, sync: SyncDeclaration, live: AuthoredSync): SourceAdapter => {
			if (sync.source === 'http') {
				const spec = live.spec as HttpRecordsSpec<unknown> & { readonly connection: HttpConnection };
				return httpSource(connector, (effectId) => resolveConnection(secretReader(integration.name), effectId, spec.connection), spec);
			}
			const channel = sync.channel!;
			return {
				list: (effectId, page) =>
					Effect.gen(function* () {
						const after = page ?? '';
						const rows = yield* query(
							effectId,
							`select provider_message_id, version, direction, envelope, deleted_at from channel_messages where channel = $1 and provider_message_id > $2 ${channel.inbound ? "and direction = 'inbound'" : ''} order by provider_message_id limit 200`,
							[channel.name, after]
						).pipe(Effect.mapError((error): SourceFailure => ({ message: error.message, retryable: error.retryable })));
						const decoded = decodeRows(rows.rows);
						const last = text(decoded.at(-1)?.['provider_message_id']);
						return {
							records: decoded.map((row) => ({
								...(row['envelope'] as Values),
								direction: row['direction'],
								__version: row['version'],
								__deleted: row['deleted_at'] !== null
							})),
							...(decoded.length === 200 && last !== null ? { next: last } : {})
						};
					})
			};
		};

		/** Reads one remote record into a change: decode, identity, mapping, version. */
		const changeOf = (
			sync: SyncDeclaration,
			live: AuthoredSync,
			record: unknown,
			resolved: unknown
		): Change => {
			const spec = live.spec as Partial<HttpRecordsSpec<unknown>>;
			const decoded =
				live.record === undefined ? record : Schema.decodeUnknownSync(live.record)(record);
			const identity =
				sync.source === 'channel'
					? text(walk(decoded, 'messageId'))
					: text(walk(decoded, spec.identity));
			if (identity === null || identity === '') throw new Error('the record carries no identity');
			const deleted =
				sync.source === 'channel'
					? walk(decoded, '__deleted') === true
					: spec.deleted !== undefined && Boolean(walk(decoded, spec.deleted));
			if (deleted) return { kind: 'tombstone', identity };
			const values: Record<string, unknown> = { [sync.identity]: identity };
			for (const [column, mapping] of Object.entries(live.fields)) {
				values[column] =
					typeof mapping === 'string'
						? walk(decoded, mapping) ?? null
						: (mapping.in as (remote: unknown, context: { readonly resolve: unknown }) => unknown)(decoded, { resolve: resolved });
			}
			const version =
				sync.source === 'channel'
					? String(walk(decoded, '__version'))
					: spec.version === undefined
						? contentVersion(values)
						: String(walk(decoded, spec.version) ?? contentVersion(values));
			const key =
				spec.idempotencyKey !== undefined && 'field' in spec.idempotencyKey
					? text(walk(decoded, spec.idempotencyKey.field))
					: null;
			return { kind: 'upsert', identity, version, values, ...(key === null ? {} : { key }) };
		};

		/** The body a local row pushes: each pushed field placed at its remote path. */
		const remoteBody = (sync: SyncDeclaration, live: AuthoredSync, values: Values): Record<string, unknown> => {
			const body: Record<string, unknown> = {};
			for (const { column, pushed } of sync.fields) {
				if (!pushed || !(column in values)) continue;
				const mapping = live.fields[column]!;
				if (typeof mapping === 'string') place(body, mapping, values[column]);
				else if (mapping.out !== undefined && mapping.field !== undefined)
					place(body, mapping.field, (mapping.out as (local: unknown) => unknown)(values[column]));
			}
			return body;
		};

		const linksFor = Effect.fn('Integrations.links')(function* (
			effectId: EffectId,
			key: string,
			column: 'identity' | 'record_id',
			values: ReadonlyArray<string>
		) {
			if (values.length === 0) return new Map<string, Link>();
			const rows = yield* query(
				effectId,
				`select record_id, identity, status, shadow, version from bolt_integration_links where sync = $1 and ${column} = any($2::text[])`,
				[key, [...values]]
			);
			return new Map(
				decodeRows(rows.rows).map((row) => {
					const link: Link = {
						record_id: String(row['record_id']),
						identity: text(row['identity']),
						status: String(row['status']),
						shadow: (row['shadow'] as Values | null) ?? {},
						version: text(row['version'])
					};
					return [String(row[column]), link] as const;
				})
			);
		});

		/** Local rows by id or by the identity column, read as the sync subject. */
		const localRows = Effect.fn('Integrations.localRows')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			column: string,
			values: ReadonlyArray<string>
		) {
			if (values.length === 0) return new Map<string, Values>();
			const rows = yield* collections
				.findMany(effectId, subject, { collection, where: { [column]: { in: [...values] } }, limit: values.length * 2 })
				.pipe(Effect.mapError((error) => refuse(subject.userId, describeCause(error))));
			return new Map(decodeRows(rows).map((row) => [String(row[column]), row] as const));
		});

		const write = (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			action: 'create' | 'update' | 'delete',
			inputs: ReadonlyArray<Values>
		) =>
			inputs.length === 0
				? Effect.void
				: collections.write(effectId, subject, [{ collection, action, inputs }]).pipe(
						Effect.asVoid,
						Effect.mapError((error) => refuse(subject.userId, `${action} ${collection} refused: ${describeCause(error)}`))
					);

		/** The marker statement: one pending push per record, coalescing later edits into it. */
		const markStatement = (key: string, recordIds: ReadonlyArray<string>) => ({
			sql: `insert into bolt_integration_pushes (id, sync, record_id) select md5($1 || ':' || r)::uuid, $1, r from unnest($2::text[]) as r on conflict (sync, record_id) do update set revision = bolt_integration_pushes.revision + 1, status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()`,
			parameters: [key, [...recordIds]] as ReadonlyArray<Schema.Json>
		});
		const pushTask = (integration: string, sync: string, label: string) => ({
			sql: `insert into bolt_task (command, input, effect_id, status) values ('integrations.push', $1::jsonb, $2, 'pending') on conflict (effect_id) do nothing`,
			parameters: [JSON.stringify({ integration, sync }), `integrations.push:${syncKey(integration, sync)}:${label}`] as ReadonlyArray<Schema.Json>
		});

		const logConflicts = (key: string, recordId: string, conflicts: ReadonlyArray<Conflict>) =>
			conflicts.map((conflict) => ({
				sql: `insert into bolt_integration_conflicts (sync, record_id, field, base, local, remote, rule, winner) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)`,
				parameters: [
					key,
					recordId,
					conflict.field,
					canonical(conflict.base),
					canonical(conflict.local),
					canonical(conflict.remote),
					conflict.rule,
					conflict.winner
				] as ReadonlyArray<Schema.Json>
			}));

		/**
		 * Applies one page of remote changes (§8.1): idempotent, version-guarded, adopting existing
		 * rows by identity before creating any, writing as the sync subject and updating the shadow
		 * with the row. Returns what it did, for the sweep's report.
		 */
		const applyChanges = Effect.fn('Integrations.applyChanges')(function* (
			effectId: EffectId,
			integration: IntegrationDeclaration,
			sync: SyncDeclaration,
			changes: ReadonlyArray<Change>,
			sweepId: string | null,
			counts: Counts,
			samples: Record<string, Array<string>>
		) {
			const key = syncKey(integration.name, sync.name);
			const subject = subjectOf(integration);
			const sample = (kind: string, identity: string) => {
				const bucket = (samples[kind] ??= []);
				if (bucket.length < SAMPLES) bucket.push(identity);
			};
			const identities = changes.map(({ identity }) => identity);
			const links = yield* linksFor(EffectId.make(`${effectId}:links`), key, 'identity', identities);
			const unlinked = identities.filter((identity) => !links.has(identity));
			const adoptable = yield* localRows(EffectId.make(`${effectId}:adopt`), subject, sync.collection, sync.identity, unlinked);
			// A create whose answer was lost: the source stored our key, so the pending row is found by it.
			const keyed = changes.flatMap((change) =>
				change.kind === 'upsert' && change.key !== undefined && !links.has(change.identity) ? [change.key] : []
			);
			const pendingByKey = yield* linksFor(EffectId.make(`${effectId}:keyed`), key, 'record_id', keyed);
			const linkedIds = [...links.values(), ...pendingByKey.values()].map(({ record_id }) => record_id);
			const rows = yield* localRows(EffectId.make(`${effectId}:rows`), subject, sync.collection, 'id', linkedIds);
			const now = yield* Clock.currentTimeMillis;

			const creates: Array<Values> = [];
			const updates: Array<Values> = [];
			const deletes: Array<Values> = [];
			const linkRows: Array<Values> = [];
			const unlinks: Array<string> = [];
			const marks: Array<string> = [];
			const statements: Array<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> = [];
			const touched: Array<string> = [];

			const remoteDelete = (link: Link, row: Values | undefined, identity: string) => {
				const edited = row !== undefined && Object.keys(localChanges(sync, link.shadow, row)).length > 0;
				if (sync.direction === 'two_way' && edited && sync.deletes === 'edit_wins') {
					statements.push(...logConflicts(key, link.record_id, [{ field: '*', base: link.shadow, local: row, remote: null, rule: 'remote_wins', winner: 'local' }]));
					counts.conflicts += 1;
					linkRows.push({ record_id: link.record_id, identity: null, status: 'pending_link', shadow: {}, version: null, swept: sweepId });
					marks.push(link.record_id);
					return;
				}
				if (row !== undefined) deletes.push({ id: link.record_id });
				unlinks.push(link.record_id);
				counts.deleted += 1;
				sample('deleted', identity);
			};

			for (const change of changes) {
				const link = links.get(change.identity) ?? (change.kind === 'upsert' && change.key !== undefined ? pendingByKey.get(change.key) : undefined);
				if (change.kind === 'tombstone') {
					if (link !== undefined) remoteDelete(link, rows.get(link.record_id), change.identity);
					continue;
				}
				if (link !== undefined && link.status === 'linked') {
					const order = versionOrder(link.version, change.version);
					if (order <= 0) {
						touched.push(link.record_id);
						counts.matched += 1;
						continue;
					}
				}
				const row = link === undefined ? adoptable.get(change.identity) : rows.get(link.record_id);
				if (link !== undefined && row === undefined) {
					// Linked but gone locally: a local delete waiting to push. The rule decides.
					if (sync.direction === 'two_way' && sync.deletes === 'delete_wins') {
						marks.push(link.record_id);
						continue;
					}
					creates.push({ id: link.record_id, ...change.values });
					linkRows.push({ record_id: link.record_id, identity: change.identity, status: 'linked', shadow: change.values, version: change.version, swept: sweepId });
					counts.created += 1;
					continue;
				}
				if (row === undefined) {
					const id = deriveRecordId(`${key}:${change.identity}`);
					creates.push({ id, ...change.values });
					linkRows.push({ record_id: id, identity: change.identity, status: 'linked', shadow: change.values, version: change.version, swept: sweepId });
					counts.created += 1;
					sample('created', change.identity);
					continue;
				}
				const recordId = String(row['id']);
				const merge = mergeRemote(
					sync,
					link === undefined || link.status !== 'linked' ? undefined : link.shadow,
					row,
					change.values,
					{ local: text(row['updated_at']), remote: change.version }
				);
				if (Object.keys(merge.write).length > 0) {
					updates.push({ id: recordId, ...merge.write });
					counts.updated += 1;
				} else counts.matched += 1;
				if (merge.conflicts.length > 0) {
					statements.push(...logConflicts(key, recordId, merge.conflicts));
					counts.conflicts += merge.conflicts.length;
					sample('conflicts', change.identity);
				}
				if (merge.push && sync.direction === 'two_way') marks.push(recordId);
				linkRows.push({ record_id: recordId, identity: change.identity, status: 'linked', shadow: merge.shadow, version: change.version, swept: sweepId });
			}

			yield* write(EffectId.make(`${effectId}:create`), subject, sync.collection, 'create', creates);
			yield* write(EffectId.make(`${effectId}:update`), subject, sync.collection, 'update', updates);
			yield* write(EffectId.make(`${effectId}:delete`), subject, sync.collection, 'delete', deletes);
			if (linkRows.length > 0)
				statements.push({
					sql: `insert into bolt_integration_links (id, sync, record_id, identity, status, shadow, version, swept) select md5($1 || ':' || x.record_id)::uuid, $1, x.record_id, x.identity, x.status, x.shadow, x.version, x.swept from jsonb_to_recordset($2::jsonb) as x(record_id text, identity text, status text, shadow jsonb, version text, swept text) on conflict (sync, record_id) do update set identity = excluded.identity, status = excluded.status, shadow = excluded.shadow, version = excluded.version, swept = coalesce(excluded.swept, bolt_integration_links.swept), updated_at = now()`,
					parameters: [key, JSON.stringify(linkRows)]
				});
			if (touched.length > 0 && sweepId !== null)
				statements.push({
					sql: `update bolt_integration_links set swept = $3 where sync = $1 and record_id = any($2::text[])`,
					parameters: [key, touched, sweepId]
				});
			if (unlinks.length > 0)
				statements.push(
					{ sql: `delete from bolt_integration_links where sync = $1 and record_id = any($2::text[])`, parameters: [key, unlinks] },
					// A record gone from both sides has nothing left to push.
					{ sql: `delete from bolt_integration_pushes where sync = $1 and record_id = any($2::text[])`, parameters: [key, unlinks] }
				);
			if (marks.length > 0) {
				statements.push(markStatement(key, marks), pushTask(integration.name, sync.name, `${effectId}`));
				counts.pushed += marks.length;
			}
			if (statements.length > 0) {
				if (marks.length > 0) yield* queue.wake(EffectId.make(`${effectId}:wake`), now);
				yield* transaction(EffectId.make(`${effectId}:links`), statements);
			}
		});

		/** Decodes and maps one page; a record that fails is one rejection, never the page. */
		const readPage = Effect.fn('Integrations.readPage')(function* (
			effectId: EffectId,
			integration: IntegrationDeclaration,
			sync: SyncDeclaration,
			live: AuthoredSync,
			records: ReadonlyArray<unknown>,
			counts: Counts,
			samples: Record<string, Array<string>>
		) {
			const decodedRecords = records.flatMap((record) => {
				if (live.record === undefined) return [record];
				const decoded = Schema.decodeUnknownResult(live.record)(record);
				return Result.isSuccess(decoded) ? [decoded.success] : [];
			});
			const resolved =
				live.resolve === undefined
					? undefined
					: yield* runAuthoredHandler(() =>
							(live.resolve as (context: { readonly records: ReadonlyArray<unknown>; readonly api: unknown }) => unknown)({
								records: decodedRecords,
								api: makeAuthoringApi(makeBoundAuthoringOps(effectId, subjectOf(integration), collections, ai, files))
							})
						).pipe(Effect.catchCause((cause) => Effect.fail(refuse(integration.name, `resolve failed: ${describeCause(cause)}`))));
			const changes: Array<Change> = [];
			for (const [index, record] of records.entries()) {
				try {
					changes.push(changeOf(sync, live, record, resolved));
				} catch (cause) {
					counts.rejected += 1;
					const bucket = (samples['rejected'] ??= []);
					if (bucket.length < SAMPLES) bucket.push(`#${index}: ${describeCause(cause)}`);
				}
			}
			return changes;
		});

		const readState = Effect.fn('Integrations.readState')(function* (effectId: EffectId, key: string) {
			const rows = yield* query(effectId, `select state, detail, sweep, changes_cursor, report from bolt_integration_state where sync = $1`, [key]);
			return decodeRows(rows.rows)[0];
		});

		/** Claims the sync for one run; `undefined` when another run holds it or it is paused. */
		const claim = Effect.fn('Integrations.claim')(function* (effectId: EffectId, key: string) {
			const rows = yield* query(
				effectId,
				`insert into bolt_integration_state (sync, state, lease_until) values ($1, 'unlinked', now() + make_interval(secs => $2)) on conflict (sync) do update set lease_until = excluded.lease_until where bolt_integration_state.state <> 'paused' and (bolt_integration_state.lease_until is null or bolt_integration_state.lease_until < now()) returning state, sweep, changes_cursor`,
				[key, LEASE_SECONDS]
			);
			return decodeRows(rows.rows)[0];
		});

		const settleState = (
			effectId: EffectId,
			key: string,
			state: string,
			detail: string | null,
			sweep: Sweep | null,
			cursor: string | null | undefined,
			report: SyncReport | undefined
		) =>
			query(
				effectId,
				`update bolt_integration_state set state = $2, detail = $3, sweep = $4::jsonb, changes_cursor = case when $7 then $6 else changes_cursor end, report = coalesce($5::jsonb, report), lease_until = null, updated_at = now() where sync = $1`,
				[
					key,
					state,
					detail,
					sweep === null ? null : JSON.stringify(sweep),
					report === undefined ? null : JSON.stringify(report),
					cursor ?? null,
					cursor !== undefined
				]
			);

		/**
		 * Every local row the sync has never linked, in one anti-join. The collection name is a
		 * compiled declaration, never input, and is quoted as an identifier.
		 */
		const unmatchedLocal = Effect.fn('Integrations.unmatchedLocal')(function* (
			effectId: EffectId,
			key: string,
			collection: string
		) {
			const rows = yield* query(
				effectId,
				`select t.id::text as id from "${collection.replaceAll('"', '""')}" as t where not exists (select 1 from bolt_integration_links l where l.sync = $1 and l.record_id = t.id::text) order by t.id`,
				[key]
			);
			return decodeRows(rows.rows).map((row) => String(row['id']));
		});

		/** A completed sweep: absence becomes deletes, unmatched local rows are handled, a report lands. */
		const finishSweep = Effect.fn('Integrations.finishSweep')(function* (
			effectId: EffectId,
			integration: IntegrationDeclaration,
			sync: SyncDeclaration,
			sweep: Sweep
		) {
			const key = syncKey(integration.name, sync.name);
			const subject = subjectOf(integration);
			// Absence is inferred here and only here (§4.5): linked rows the full sweep never saw.
			const absent = decodeRows(
				(yield* query(
					EffectId.make(`${effectId}:absent`),
					`select record_id, identity, status, shadow, version from bolt_integration_links where sync = $1 and status = 'linked' and swept is distinct from $2`,
					[key, sweep.id]
				)).rows
			);
			if (absent.length > 0) {
				const changes: Array<Change> = absent.map((row) => ({ kind: 'tombstone', identity: String(row['identity']) }));
				yield* applyChanges(EffectId.make(`${effectId}:absence`), integration, sync, changes, sweep.id, sweep.counts, sweep.samples);
			}
			if (sync.direction === 'two_way') {
				const pending = decodeRows(
					(yield* query(EffectId.make(`${effectId}:pending`), `select record_id from bolt_integration_links where sync = $1 and status = 'pending_link'`, [key])).rows
				).map((row) => String(row['record_id']));
				const unmatched = yield* unmatchedLocal(EffectId.make(`${effectId}:unmatched`), key, sync.collection);
				sweep.counts.unmatched += unmatched.length;
				(sweep.samples['unmatched'] ??= []).push(...unmatched.slice(0, SAMPLES));
				const pushing = sweep.mode === 'backfill' && sync.onUnmatchedLocal === 'push' ? unmatched : [];
				const keeping = sync.onUnmatchedLocal === 'keep' ? unmatched : [];
				const statements = [
					...(pushing.length + keeping.length === 0
						? []
						: [
								{
									sql: `insert into bolt_integration_links (id, sync, record_id, status) select md5($1 || ':' || r.id)::uuid, $1, r.id, r.status from jsonb_to_recordset($2::jsonb) as r(id text, status text) on conflict (sync, record_id) do nothing`,
									parameters: [key, JSON.stringify([...pushing.map((id) => ({ id, status: 'pending_link' })), ...keeping.map((id) => ({ id, status: 'local_only' }))])] as ReadonlyArray<Schema.Json>
								}
							]),
					...([...pending, ...pushing].length === 0 ? [] : [markStatement(key, [...pending, ...pushing]), pushTask(integration.name, sync.name, sweep.id)])
				];
				sweep.counts.pushed += pushing.length + pending.length;
				if (statements.length > 0) {
					yield* queue.wake(EffectId.make(`${effectId}:wake`), yield* Clock.currentTimeMillis);
					yield* transaction(EffectId.make(`${effectId}:unmatched-links`), statements);
				}
			} else {
				const unmatched = yield* unmatchedLocal(EffectId.make(`${effectId}:unmatched`), key, sync.collection);
				sweep.counts.unmatched += unmatched.length;
				(sweep.samples['unmatched'] ??= []).push(...unmatched.slice(0, SAMPLES));
			}
			return {
				mode: sweep.mode,
				finishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
				...sweep.counts,
				samples: sweep.samples
			} satisfies SyncReport;
		});

		const run: Interface['run'] = Effect.fn('Integrations.run')(function* (effectId, integrationName, syncName, mode) {
			const { integration, sync, live } = yield* requireSync(integrationName, syncName);
			const key = syncKey(integrationName, syncName);
			const claimed = yield* claim(EffectId.make(`${effectId}:claim`), key);
			if (claimed === undefined) return { sync: key, skipped: true };
			const source = sourceFor(integration, sync, live);
			const stored = Schema.decodeUnknownResult(Sweep)(claimed['sweep']);
			let sweep: Sweep | null = Result.isSuccess(stored) ? (stored.success as Sweep) : null;
			const state = String(claimed['state']);
			const cursor = text(claimed['changes_cursor']);
			const failed = (failure: SourceFailure | IntegrationError, current: Sweep | null) =>
				settleState(
					EffectId.make(`${effectId}:failed`),
					key,
					'failed',
					'message' in failure && !('_tag' in failure) ? describeSourceFailure(failure as SourceFailure) : (failure as IntegrationError).message,
					current,
					undefined,
					undefined
				).pipe(Effect.as({ sync: key, state: 'failed' }));

			const sweeping = sweep !== null || mode === 'reconcile' || state === 'unlinked' || state === 'backfilling';
			if (sweeping) {
				sweep ??= {
					id: `${effectId}`,
					mode: state === 'unlinked' || state === 'backfilling' || (state === 'failed' && cursor === null) ? 'backfill' : 'reconcile',
					page: 0,
					pageCursor: null,
					counts: emptyCounts(),
					samples: {},
					complete: false
				};
				const active = sweep;
				yield* settleState(EffectId.make(`${effectId}:start`), key, active.mode === 'backfill' ? 'backfilling' : 'reconciling', null, active, undefined, undefined).pipe(
					// the lease stays held: settleState clears it, so re-take it for the pages below
					Effect.andThen(query(EffectId.make(`${effectId}:relet`), `update bolt_integration_state set lease_until = now() + make_interval(secs => $2) where sync = $1`, [key, LEASE_SECONDS]))
				);
				for (let budget = 0; budget < PAGE_BUDGET; budget += 1) {
					const page = yield* source.list(EffectId.make(`${effectId}:list:${active.page}`), active.pageCursor ?? undefined).pipe(Effect.result);
					if (Result.isFailure(page)) return yield* failed(page.failure, active);
					const changes = yield* readPage(EffectId.make(`${effectId}:read:${active.page}`), integration, sync, live, page.success.records, active.counts, active.samples);
					const applied = yield* applyChanges(EffectId.make(`${effectId}:apply:${active.page}`), integration, sync, changes, active.id, active.counts, active.samples).pipe(Effect.result);
					if (Result.isFailure(applied)) return yield* failed(applied.failure as IntegrationError, active);
					active.page += 1;
					active.pageCursor = page.success.next ?? null;
					if (page.success.next === undefined) {
						active.complete = true;
						break;
					}
					yield* query(EffectId.make(`${effectId}:progress:${active.page}`), `update bolt_integration_state set sweep = $2::jsonb, updated_at = now() where sync = $1`, [key, JSON.stringify(active)]);
				}
				if (!active.complete) {
					// Out of budget: the rest of the sweep is a continuation, resumed at this page.
					yield* settleState(EffectId.make(`${effectId}:pause`), key, active.mode === 'backfill' ? 'backfilling' : 'reconciling', null, active, undefined, undefined);
					yield* queue.enqueueClaimed(EffectId.make(`${effectId}:continue`), {
						command: 'integrations.run',
						input: { integration: integrationName, sync: syncName, mode: 'reconcile' },
						effectId: `integrations.run:${key}:${active.id}:${active.page}`,
						nowEpochMs: yield* Clock.currentTimeMillis
					});
					return { sync: key, state: active.mode === 'backfill' ? 'backfilling' : 'reconciling', page: active.page };
				}
				const report = yield* finishSweep(EffectId.make(`${effectId}:finish`), integration, sync, active);
				yield* settleState(EffectId.make(`${effectId}:live`), key, 'live', null, null, undefined, report);
				return { sync: key, state: 'live', report };
			}

			if (source.changes === undefined) {
				yield* settleState(EffectId.make(`${effectId}:idle`), key, 'live', null, null, undefined, undefined);
				return { sync: key, state: 'live' };
			}
			const counts = emptyCounts();
			const samples: Record<string, Array<string>> = {};
			let page: string | undefined;
			let next: string | null = cursor;
			for (let budget = 0; budget < PAGE_BUDGET; budget += 1) {
				const read = yield* source.changes(EffectId.make(`${effectId}:changes:${budget}`), cursor, page).pipe(Effect.result);
				if (Result.isFailure(read)) return yield* failed(read.failure, null);
				const changes = yield* readPage(EffectId.make(`${effectId}:read:${budget}`), integration, sync, live, read.success.records, counts, samples);
				const applied = yield* applyChanges(EffectId.make(`${effectId}:apply:${budget}`), integration, sync, changes, null, counts, samples).pipe(Effect.result);
				if (Result.isFailure(applied)) return yield* failed(applied.failure as IntegrationError, null);
				if (read.success.cursor !== undefined) next = read.success.cursor;
				if (read.success.next === undefined) break;
				page = read.success.next;
			}
			yield* settleState(EffectId.make(`${effectId}:live`), key, 'live', null, null, next, undefined);
			return { sync: key, state: 'live', ...counts };
		});

		const push: Interface['push'] = Effect.fn('Integrations.push')(function* (effectId, integrationName, syncName) {
			const { integration, sync, live } = yield* requireSync(integrationName, syncName);
			if (sync.direction !== 'two_way') return { sync: syncName, pushed: 0 };
			const key = syncKey(integrationName, syncName);
			const subject = subjectOf(integration);
			const source = sourceFor(integration, sync, live);
			const claimed = decodeRows(
				(yield* query(
					EffectId.make(`${effectId}:claim`),
					`update bolt_integration_pushes set status = 'inflight', attempts = attempts + 1, updated_at = now() where id in (select id from bolt_integration_pushes where sync = $1 and (status = 'pending' or (status = 'inflight' and updated_at < now() - interval '10 minutes')) and next_attempt_at <= now() order by next_attempt_at limit $2 for update skip locked) returning record_id, revision, attempts`,
					[key, PUSH_BATCH]
				)).rows
			);
			const ids = claimed.map((row) => String(row['record_id']));
			const links = yield* linksFor(EffectId.make(`${effectId}:links`), key, 'record_id', ids);
			const rows = yield* localRows(EffectId.make(`${effectId}:rows`), subject, sync.collection, 'id', ids);
			let pushed = 0;
			for (const marker of claimed) {
				const recordId = String(marker['record_id']);
				const revision = numeric(marker['revision']);
				const attempts = numeric(marker['attempts']);
				const row = rows.get(recordId);
				const link = links.get(recordId);
				const step = EffectId.make(`${effectId}:${recordId}:${revision}`);
				const outcome = yield* Effect.gen(function* () {
					if (row !== undefined && (link === undefined || link.status !== 'linked')) {
						const answer = yield* source.create!(step, remoteBody(sync, live, row), recordId);
						const change = changeOf(sync, live, answer, undefined);
						const identity = change.identity;
						const version = change.kind === 'upsert' ? change.version : contentVersion(syncedValues(sync, row));
						if (!same(row[sync.identity], identity))
							yield* write(EffectId.make(`${step}:identity`), subject, sync.collection, 'update', [{ id: recordId, [sync.identity]: identity }]);
						return { identity, status: 'linked', shadow: syncedValues(sync, row), version };
					}
					if (row !== undefined && link !== undefined) {
						const changes = localChanges(sync, link.shadow, row);
						if (Object.keys(changes).length === 0) return undefined;
						const answer = yield* source.update!(step, link.identity!, remoteBody(sync, live, changes), link.version);
						const shadow = { ...link.shadow, ...changes };
						const version = (live.spec as Partial<HttpRecordsSpec<unknown>>).version === undefined ? contentVersion(shadow) : text(walk(answer, (live.spec as HttpRecordsSpec<unknown>).version)) ?? contentVersion(shadow);
						return { identity: link.identity, status: 'linked', shadow, version };
					}
					if (row === undefined && link !== undefined && link.identity !== null) {
						yield* source.delete!(step, link.identity, link.version);
						return null;
					}
					return undefined;
				}).pipe(Effect.result);
				if (Result.isFailure(outcome)) {
					const failure = outcome.failure as SourceFailure | IntegrationError;
					if ('conflict' in failure && failure.conflict === true && source.get !== undefined && link?.identity) {
						// The source moved under us: re-read it, merge it (§8.2), and push what is still ours.
						const fresh = yield* source.get(EffectId.make(`${step}:reread`), link.identity).pipe(Effect.orElseSucceed(() => undefined));
						if (fresh !== undefined) {
							const counts = emptyCounts();
							const changes = yield* readPage(EffectId.make(`${step}:merge`), integration, sync, live, [fresh], counts, {});
							yield* applyChanges(EffectId.make(`${step}:apply`), integration, sync, changes, null, counts, {});
						}
						yield* query(EffectId.make(`${step}:retry`), `update bolt_integration_pushes set status = 'pending', next_attempt_at = now() where sync = $1 and record_id = $2`, [key, recordId]);
						continue;
					}
					// A record the source no longer has is a remote delete the next reconcile settles; until
					// then the push waits rather than dead-lettering a change nobody can apply.
					const gone = 'status' in failure && failure.status === 404 && link !== undefined;
					const retryable = gone || ('retryable' in failure && failure.retryable === true);
					const message = 'message' in failure ? String(failure.message) : describeCause(failure);
					const delay = retryDelayMs(attempts - 1, { initialDelayMs: 1000, maxDelayMs: 300_000 }, undefined, 0);
					yield* query(
						EffectId.make(`${step}:failed`),
						`update bolt_integration_pushes set status = $3, last_error = $4, last_status = $5, next_attempt_at = now() + make_interval(secs => $6), updated_at = now() where sync = $1 and record_id = $2`,
						[key, recordId, retryable && attempts < 8 ? 'pending' : 'failed', message.slice(0, 2000), 'status' in failure && typeof failure.status === 'number' ? failure.status : null, Math.ceil(delay / 1000)]
					);
					continue;
				}
				const settled = outcome.success;
				yield* transaction(EffectId.make(`${step}:settle`), [
					...(settled === undefined
						? []
						: settled === null
							? [{ sql: `delete from bolt_integration_links where sync = $1 and record_id = $2`, parameters: [key, recordId] as ReadonlyArray<Schema.Json> }]
							: [
									{
										sql: `insert into bolt_integration_links (id, sync, record_id, identity, status, shadow, version) values (md5($1 || ':' || $2)::uuid, $1, $2, $3, $4, $5::jsonb, $6) on conflict (sync, record_id) do update set identity = excluded.identity, status = excluded.status, shadow = excluded.shadow, version = excluded.version, updated_at = now()`,
										parameters: [key, recordId, settled.identity, settled.status, JSON.stringify(settled.shadow), settled.version] as ReadonlyArray<Schema.Json>
									}
								]),
					// Only the revision this push claimed: an edit made meanwhile keeps its marker.
					{ sql: `delete from bolt_integration_pushes where sync = $1 and record_id = $2 and revision = $3`, parameters: [key, recordId, revision] }
				]);
				if (settled !== undefined) pushed += 1;
			}
			const due = decodeRows(
				(yield* query(EffectId.make(`${effectId}:due`), `select min(next_attempt_at) as due from bolt_integration_pushes where sync = $1 and status = 'pending'`, [key])).rows
			)[0]?.['due'];
			const dueAt = typeof due === 'string' ? Date.parse(due) : Number.NaN;
			if (Number.isFinite(dueAt)) {
				yield* queue.wake(EffectId.make(`${effectId}:wake`), dueAt);
				yield* query(
					EffectId.make(`${effectId}:again`),
					`insert into bolt_task (command, input, effect_id, run_at, status) values ('integrations.push', $1::jsonb, $2, $3, 'pending') on conflict (effect_id) do nothing`,
					[JSON.stringify({ integration: integrationName, sync: syncName }), `integrations.push:${key}:${new Date(dueAt).toISOString()}`, new Date(dueAt).toISOString()]
				);
			}
			return { sync: key, pushed, claimed: claimed.length };
		});

		const receive: Interface['receive'] = Effect.fn('Integrations.receive')(function* (effectId, integrationName, syncName, delivery) {
			const { integration, sync, live } = yield* requireSync(integrationName, syncName);
			const spec = live.spec as Partial<HttpRecordsSpec<unknown>>;
			const webhook = spec.subscribe?.webhook;
			if (webhook === undefined) return yield* refuse(integrationName, `${syncName} does not subscribe by webhook`);
			const secret = yield* secretReader(integrationName)(effectId, webhook.signature.secret.env).pipe(Effect.mapError((error) => refuse(integrationName, error.message)));
			const verdict = yield* verifyDelivery(webhook.signature, secret, delivery, yield* Clock.currentTimeMillis).pipe(
				Effect.mapError((error) => refuse(integrationName, describeCause(error)))
			);
			if (!verdict.verified) return yield* refuse(integrationName, `delivery refused: ${verdict.refusal.reason}`);
			const body = yield* Effect.try({ try: () => JSON.parse(delivery.body) as unknown, catch: () => refuse(integrationName, 'delivery body is not JSON') });
			const found = walk(body, webhook.records);
			const records = Array.isArray(found) ? found : [found];
			const counts = emptyCounts();
			const samples: Record<string, Array<string>> = {};
			const changes = yield* readPage(EffectId.make(`${effectId}:read`), integration, sync, live, records, counts, samples);
			yield* applyChanges(EffectId.make(`${effectId}:apply`), integration, sync, changes, null, counts, samples);
			return { sync: syncKey(integrationName, syncName), ...counts, samples };
		});

		const applyChannel: Interface['applyChannel'] = Effect.fn('Integrations.applyChannel')(function* (effectId, channel, records) {
			for (const integration of workspace.definition.integrations)
				for (const sync of integration.syncs) {
					if (sync.channel?.name !== channel) continue;
					const live = authored.integrations[integration.name]?.[sync.name];
					if (live === undefined) continue;
					const wanted = records
						.filter(({ record }) => !sync.channel!.inbound || record['direction'] === 'inbound')
						.map(({ record, version, deleted }) => ({ ...record, __version: version, __deleted: deleted }));
					if (wanted.length === 0) continue;
					const counts = emptyCounts();
					const step = EffectId.make(`${effectId}:${integration.name}.${sync.name}`);
					const changes = yield* readPage(step, integration, sync, live, wanted, counts, {});
					yield* applyChanges(EffectId.make(`${step}:apply`), integration, sync, changes, null, counts, {});
				}
		});

		const status: Interface['status'] = Effect.fn('Integrations.status')(function* (effectId) {
			const states = new Map(
				decodeRows(
					(yield* query(
						effectId,
						`select s.sync, s.state, s.detail, s.sweep, s.report, (select count(*) from bolt_integration_pushes o where o.sync = s.sync and o.status <> 'failed') as pending, (select count(*) from bolt_integration_pushes o where o.sync = s.sync and o.status = 'failed') as dead, (select count(*) from bolt_integration_conflicts c where c.sync = s.sync) as conflicts from bolt_integration_state s`,
						[]
					)).rows
				).map((row) => [String(row['sync']), row] as const)
			);
			return workspace.definition.integrations.flatMap((integration) =>
				integration.syncs.map((sync): IntegrationSyncStatus => {
					const row = states.get(syncKey(integration.name, sync.name));
					const sweep = row?.['sweep'] as { page?: number } | null | undefined;
					return {
						integration: integration.name,
						sync: sync.name,
						collection: sync.collection,
						direction: sync.direction,
						state: (row?.['state'] as IntegrationSyncStatus['state'] | undefined) ?? 'unlinked',
						detail: text(row?.['detail']),
						bound: { subscribe: sync.webhook || sync.source === 'channel', changes: sync.changesSchedule ?? null, reconcile: sync.reconcileSchedule },
						page: typeof sweep?.page === 'number' ? sweep.page : null,
						report: (row?.['report'] as SyncReport | null | undefined) ?? null,
						pending: numeric(row?.['pending']),
						deadLetters: numeric(row?.['dead']),
						conflicts: numeric(row?.['conflicts'])
					};
				})
			);
		});

		const control: Interface['control'] = Effect.fn('Integrations.control')(function* (effectId, integrationName, syncName, action) {
			yield* requireSync(integrationName, syncName);
			const key = syncKey(integrationName, syncName);
			const now = yield* Clock.currentTimeMillis;
			if (action === 'pause') {
				yield* query(effectId, `insert into bolt_integration_state (sync, state) values ($1, 'paused') on conflict (sync) do update set state = 'paused', updated_at = now()`, [key]);
				return { sync: key, state: 'paused' };
			}
			if (action === 'resume') {
				yield* query(effectId, `update bolt_integration_state set state = case when changes_cursor is null and report is null then 'unlinked' else 'live' end, lease_until = null, updated_at = now() where sync = $1 and state = 'paused'`, [key]);
				return { sync: key, state: 'resumed' };
			}
			if (action === 'retry') {
				yield* query(effectId, `update bolt_integration_pushes set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now() where sync = $1 and status = 'failed'`, [key]);
				yield* queue.enqueueClaimed(EffectId.make(`${effectId}:push`), { command: 'integrations.push', input: { integration: integrationName, sync: syncName }, effectId: `integrations.push:${key}:retry:${now}`, nowEpochMs: now });
				return { sync: key, retried: true };
			}
			yield* queue.enqueueClaimed(EffectId.make(`${effectId}:run`), {
				command: 'integrations.run',
				input: { integration: integrationName, sync: syncName, mode: 'reconcile' },
				effectId: `integrations.run:${key}:${action}:${now}`,
				nowEpochMs: now
			});
			return { sync: key, queued: action };
		});

		return Service.of({ run, push, receive, applyChannel, status, control });
	})
);

/**
 * The statements a local write owes the syncs over its collection, committed in that write's own
 * transaction (§4.3): one coalescing marker per record for each two-way sync, and the push task.
 * The sync subject's own writes owe nothing — the loop is broken by the writer and by the shadow.
 */
export const syncMarkStatements = (
	integrations: ReadonlyArray<IntegrationDeclaration>,
	collection: string,
	writer: string,
	recordIds: ReadonlyArray<string>,
	effectId: string
): ReadonlyArray<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> =>
	recordIds.length === 0
		? []
		: integrations.flatMap((integration) =>
				integration.syncs
					.filter((sync) => sync.collection === collection && sync.direction === 'two_way' && writer !== `integration:${integration.name}`)
					.flatMap((sync) => {
						const key = syncKey(integration.name, sync.name);
						return [
							{
								sql: `insert into bolt_integration_pushes (id, sync, record_id) select md5($1 || ':' || r)::uuid, $1, r from unnest($2::text[]) as r on conflict (sync, record_id) do update set revision = bolt_integration_pushes.revision + 1, status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()`,
								parameters: [key, [...recordIds]]
							},
							{
								sql: `insert into bolt_task (command, input, effect_id, status) values ('integrations.push', $1::jsonb, $2, 'pending') on conflict (effect_id) do nothing`,
								parameters: [JSON.stringify({ integration: integration.name, sync: sync.name }), `integrations.push:${key}:${effectId}`]
							}
						];
					})
			);

/**
 * Why a principal other than a sync's subject may not make this write (§6), or `undefined`.
 *
 * A one-way mirror is read-only: no create, no delete, no change to a synced column — only its
 * local-only columns stay writable. A two-way sync refuses local changes to fields the remote owns.
 */
export const syncOwnershipRefusal = (
	integrations: ReadonlyArray<IntegrationDeclaration>,
	collection: string,
	writer: string,
	action: 'create' | 'update' | 'delete',
	columns: ReadonlyArray<string>
): string | undefined => {
	for (const integration of integrations)
		for (const sync of integration.syncs) {
			if (sync.collection !== collection || writer === `integration:${integration.name}`) continue;
			if (sync.direction === 'one_way') {
				if (action !== 'update') return `${collection} is owned by ${integration.name}: rows arrive from the source, and cannot be ${action}d here.`;
				const owned = new Set([sync.identity, ...sync.fields.map(({ column }) => column)]);
				const touched = columns.filter((column) => owned.has(column));
				if (touched.length > 0) return `${collection}.${touched.join(', ')} is owned by ${integration.name}.`;
			} else {
				const touched = columns.filter((column) => sync.owns.remote.includes(column));
				if (touched.length > 0) return `${collection}.${touched.join(', ')} is owned by ${integration.name}'s source.`;
			}
		}
	return undefined;
};
