import type { PodRequestEvent } from '$lib/server/request-context.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { runWithWorkspaceContext } from '$lib/server/bootstrap/workspace_runtime.js';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { toRelationsFilter } from '$lib/authoring/workspace/relations-filter.js';
import { abortableDelay } from '$lib/shared/abortable-delay.js';
import { syncNotificationGeneration, waitForSyncNotification } from './db-notifications.server.js';
import { error } from '../http_error.js';
import { isUnexpectedMutationError, mutationRejection } from './mutation-rejection.server.js';
import {
	createRecord,
	updateRecord,
	deleteRecord,
	findManyPage,
	findFirst
} from '../collection_ops.server.js';
import {
	readSyncOutboxBatch,
	outboxCursorForSeq,
	currentOutboxWatermark,
	pruneSyncOutbox,
	syncCompactionBoundary,
	isCursorTooOld,
	OUTBOX_CURSOR_START,
	type OutboxCursor
} from './outbox-tailer.server.js';
import { SYNC_REPLICA_EPOCH_HEADER, SYNC_REPLICA_STAMP_HEADER } from '$lib/ui/sync/types.js';
import { quoteSqlIdentifier } from '../sql-identifier.server.js';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { CLIENT_OPAQUE_COLLECTIONS } from '../access_control/permission/collection_permission.guard.server.js';

/** A change to any of these can alter the policy scope represented by an open stream context. */
const SCOPE_BEARING_COLLECTIONS = new Set(['policy', 'team', 'team_members', 'user']);

/**
 * `/_runtime/sync/*` — the sync-engine wire protocol. Routed in runtime_request.server.ts
 * BEFORE the JSON body is read so `stream` can hold the request open for SSE. All handlers
 * run under the request's workspace context and reuse the authoritative mutation pipeline
 * (collection_ops) and policy filter (compilePolicyWhere, applied inside findMany/findFirst),
 * so the untrusted client can neither self-authorize nor read outside its policy scope.
 */
export function handleSyncRequest(
	action: string,
	event: PodRequestEvent,
	ctx: ProvisionedContext,
	headers: HeadersInit
): Promise<Response> {
	if (action === 'shape') return handleShape(event, ctx, headers);
	if (action === 'head') return handleHead(ctx, headers);
	if (action === 'stream') return handleStream(event, ctx);
	if (action === 'mutate') return handleMutate(event, ctx, headers);
	if (action === 'schema') return handleSchema(ctx, headers);
	throw error(404, `Unknown sync route: sync/${action}`);
}

/** Ordered feed position visible at document boot; restored replicas cross this before local use. */
async function handleHead(ctx: ProvisionedContext, headers: HeadersInit): Promise<Response> {
	return jsonResponse({ sequence: await currentOutboxWatermark(ctx) }, headers);
}

// ---------------------------------------------------------------------------
// schema — GET → client-applicable DDL, introspected from the live database so the local replica
// schema always matches the server (no separate build artifact to keep in sync). Tables only, no
// defaults/NOT-NULL/indexes: the client is a cache that receives complete rows.
//
// The DDL is *additive and idempotent*: a bare CREATE TABLE IF NOT EXISTS carrying only the
// primary key, followed by one ADD COLUMN IF NOT EXISTS per column. Replaying it against a warm
// replica adds new tables and new columns while preserving every synced row, so an ordinary
// workspace schema edit costs an ALTER instead of a full local wipe and re-sync. Emitting each
// column as its own statement also lets the client parse the target column set back out (see
// reconcileSchema) without a SQL parser.
// ---------------------------------------------------------------------------

const REPLICA_EXCLUDED_TABLES = [
	'sync_outbox',
	'_norbital_sync_epoch',
	'_norbital_sync_compaction',
	'_norbital_automation_cursor',
	'_norbital_automation_job',
	'_approval_lock',
	'_norbital_internal_schema',
	'mutation_log',
	'integration_outbox',
	'integration_cursor',
	'notification_outbox',
	...CLIENT_OPAQUE_COLLECTIONS,
	'__drizzle_migrations'
];

/**
 * Everything a browser needs to open its local replica: the DDL, the database name, and the epoch
 * that says whether the rows already on the device are still about the same database.
 *
 * The workspace shell embeds this so the replica can start opening on the same response that
 * initializes the client, rather than after a second round trip. `handleSchema` below is the same
 * data over the wire, for the sync protocol's own tests and for any client that wants it alone.
 */
/**
 * The client DDL, cached for the life of this runtime process.
 *
 * Building it introspects `pg_class`/`pg_attribute` for every collection — 41 tables and ~40 KB of
 * DDL on an ordinary workspace — and it is now on the critical path of every workspace load, since
 * the shell carries it. The answer only changes when the tenant schema does, and a schema change
 * redeploys the workspace, which replaces this process. So the cache cannot go stale while it
 * exists: there is no edit that changes the schema and leaves this runtime running.
 *
 * Keyed by manifest node anyway, so a runtime that somehow serves two manifests cannot serve one's
 * DDL for the other.
 */
const clientSchemaCache = new Map<string, string>();

export async function loadSyncBootstrap(ctx: ProvisionedContext): Promise<{
	schemaSql: string;
	replicaStamp: string;
	replicaEpoch: string;
}> {
	const schemaKey = ctx.manifestCtx.nodeId;
	const cachedSchema = clientSchemaCache.get(schemaKey);
	const [schemaSql, epochResult] = await Promise.all([
		cachedSchema ?? buildClientSchema(ctx),
		ctx.tenantDb.query<{ epoch: string }>(
			`SELECT epoch::text AS epoch FROM _norbital_sync_epoch WHERE singleton = TRUE`
		)
	]);
	if (!cachedSchema) clientSchemaCache.set(schemaKey, schemaSql);
	const replicaEpoch = epochResult.rows[0]?.epoch;
	if (!replicaEpoch) throw error(500, 'Tenant sync epoch is missing');
	return {
		schemaSql,
		// Names the local database. One tenant's rows can never land in another's replica because
		// this stamp differs, and switching organizations reloads the page.
		replicaStamp: `${ctx.organization.norbital_id}:${ctx.baseScope.requestor.norbital_id}`,
		replicaEpoch
	};
}

async function handleSchema(ctx: ProvisionedContext, headers: HeadersInit): Promise<Response> {
	const bootstrap = await loadSyncBootstrap(ctx);
	return new Response(bootstrap.schemaSql, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			[SYNC_REPLICA_STAMP_HEADER]: bootstrap.replicaStamp,
			[SYNC_REPLICA_EPOCH_HEADER]: bootstrap.replicaEpoch,
			...headers
		}
	});
}

async function buildClientSchema(ctx: ProvisionedContext): Promise<string> {
	const result = await ctx.tenantDb.query<{
		table_name: string;
		column_name: string;
		type: string;
	}>(
		`SELECT c.relname AS table_name, a.attname AS column_name,
		        format_type(a.atttypid, a.atttypmod) AS type
		   FROM pg_class c
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		   JOIN pg_attribute a ON a.attrelid = c.oid
		  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname !~ '_history$'
		    AND c.relname <> ALL($1::text[])
		    AND a.attnum > 0 AND NOT a.attisdropped
		    AND EXISTS (
		      SELECT 1 FROM pg_attribute p
		       WHERE p.attrelid = c.oid AND p.attname = 'norbital_id' AND NOT p.attisdropped
		    )
		  ORDER BY c.relname, a.attnum`,
		[REPLICA_EXCLUDED_TABLES]
	);
	const byTable = new Map<string, { column: string; type: string }[]>();
	for (const row of result.rows) {
		const columns = byTable.get(row.table_name) ?? [];
		columns.push({ column: row.column_name, type: row.type });
		byTable.set(row.table_name, columns);
	}
	const pkey = SYSTEM_COLUMN_NAMES.PKEY;
	const statements: string[] = [];
	for (const [table, columns] of byTable) {
		const pkeyColumn = columns.find((c) => c.column === pkey);
		if (!pkeyColumn) continue;
		statements.push(
			`CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(table)} (` +
				`${quoteSqlIdentifier(pkey)} ${clientColumnType(pkeyColumn.type)} PRIMARY KEY);`
		);
		for (const column of columns) {
			if (column.column === pkey) continue;
			statements.push(
				`ALTER TABLE ${quoteSqlIdentifier(table)} ADD COLUMN IF NOT EXISTS ` +
					`${quoteSqlIdentifier(column.column)} ${clientColumnType(column.type)};`
			);
		}
	}
	return statements.join('\n') + '\n';
}

/** PGlite tracks an earlier Postgres core, so remap types it doesn't ship (uuidv7-era, xid8, pgvector). */
function clientColumnType(type: string): string {
	if (type === 'xid8' || type === 'xid') return 'text';
	// bit(n) / vector(n) need the `vector` extension; store opaque text on the replica.
	if (/^bit(\(|$)/i.test(type) || /^vector(\(|$)/i.test(type)) return 'text';
	return type;
}

// ---------------------------------------------------------------------------
// shape — POST { collection, cursor?, pageSize? } → { rows, nextCursor, watermark, cursor? }
//
// One keyset page of a policy-scoped collection. The server is stateless across pages: it reports
// `nextCursor` honestly — null means "no rows after this page" — and the client drives the paging
// loop and owns its residency budget, since only the client knows how much it has accumulated.
//
// The first page captures the watermark so the SSE stream resumes without a gap.
// ---------------------------------------------------------------------------

const DEFAULT_SHAPE_PAGE_SIZE = 1000;
const MAX_SHAPE_PAGE_SIZE = 5000;

async function handleShape(
	event: PodRequestEvent,
	ctx: ProvisionedContext,
	headers: HeadersInit
): Promise<Response> {
	const body = (await event.request.json().catch(() => ({}))) as {
		collection?: string;
		cursor?: string | null;
		pageSize?: number;
	};

	if (typeof body.collection !== 'string') throw error(400, 'shape requires a collection');

	// Retention is swept opportunistically here rather than on a schedule: this is the one call
	// every client makes, it is rate-limited internally, and a tenant nobody opens does not need
	// its feed trimmed.
	void pruneSyncOutbox(ctx).catch(() => undefined);

	const requestedSize =
		typeof body.pageSize === 'number' && body.pageSize > 0
			? body.pageSize
			: DEFAULT_SHAPE_PAGE_SIZE;
	const pageSize = Math.min(MAX_SHAPE_PAGE_SIZE, Math.max(1, Math.floor(requestedSize)));

	const watermark = body.cursor ? undefined : await currentOutboxWatermark(ctx);

	const cursor = body.cursor
		? undefined
		: watermark && watermark !== '0'
			? await outboxCursorForSeq(ctx, watermark)
			: undefined;

	// No `query` — the sync unit is the whole policy-scoped collection. Filters, sorts and
	// projections are the client's business, applied locally against the replica.
	const page = await findManyPage(ctx, body.collection, {
		after: body.cursor ?? undefined,
		limit: pageSize
	} as never);

	return jsonResponse(
		{
			rows: page.rows,
			nextCursor: page.nextCursor,
			watermark: watermark ?? '0',
			...(cursor ? { cursor } : {})
		},
		headers
	);
}

// ---------------------------------------------------------------------------
// mutate — POST { mutations:[{ clientId, collection, action, row, version }] }
//       → { results:[{ clientId, status, serverId?|reason?|currentRow? }] }
// ---------------------------------------------------------------------------

type WireMutation = {
	readonly clientId: string;
	readonly collection: string;
	readonly action: 'create' | 'update' | 'delete';
	readonly row?: Record<string, unknown>;
	readonly version?: number;
};

type MutationResult =
	| {
			clientId: string;
			status: 'confirmed';
			serverId: string | null;
			row?: Record<string, unknown>;
	  }
	| {
			clientId: string;
			status: 'rejected';
			reason: string;
			currentRow?: Record<string, unknown>;
			detail?: string;
	  };

async function handleMutate(
	event: PodRequestEvent,
	ctx: ProvisionedContext,
	headers: HeadersInit
): Promise<Response> {
	const body = (await event.request.json().catch(() => ({}))) as { mutations?: WireMutation[] };
	const mutations = Array.isArray(body.mutations) ? body.mutations : [];

	const results: MutationResult[] = [];
	// stupidity:allow A6 -- mutation order is observable and must match the submitted batch.
	for (const m of mutations) {
		results.push(await runOneMutation(ctx, m));
	}
	return jsonResponse({ results }, headers);
}

async function runOneMutation(ctx: ProvisionedContext, m: WireMutation): Promise<MutationResult> {
	try {
		if (m.action === 'create') {
			const recordId = pkeyOf(m.row ?? {});
			if (!recordId || !uuidValidate(recordId) || uuidVersion(recordId) !== 7) {
				return {
					clientId: m.clientId,
					status: 'rejected',
					reason: 'INVALID_CREATE_ID'
				};
			}
			const created = await createRecord(ctx, m.collection, m.row ?? {}, {
				recordId
			});
			return {
				clientId: m.clientId,
				status: 'confirmed',
				serverId: pkeyOf(created),
				row: created
			};
		}
		if (m.action === 'update') {
			const id = pkeyOf(m.row ?? {});
			if (!id) return { clientId: m.clientId, status: 'rejected', reason: 'MISSING_ID' };
			const updated = await updateRecord(ctx, m.collection, id, m.row ?? {}, {
				expectedVersion: m.version
			});
			return { clientId: m.clientId, status: 'confirmed', serverId: id, row: updated };
		}
		if (m.action === 'delete') {
			const id = pkeyOf(m.row ?? {});
			if (!id) return { clientId: m.clientId, status: 'rejected', reason: 'MISSING_ID' };
			await deleteRecord(ctx, m.collection, id);
			return { clientId: m.clientId, status: 'confirmed', serverId: id };
		}
		return { clientId: m.clientId, status: 'rejected', reason: 'UNKNOWN_ACTION' };
	} catch (err) {
		return mutationError(m.clientId, err);
	}
}

/**
 * A refusal the server deliberately wrote for the caller is repeated verbatim; anything else is
 * the server's own failure, logged here and reported generically. See mutation-rejection.server.ts
 * for where that line is drawn — the client must never surface prose that was not written to be
 * read, and must never swallow prose that was.
 */
function mutationError(clientId: string, err: unknown): MutationResult {
	if (isUnexpectedMutationError(err)) {
		console.error('[sync/mutate] mutation failed unexpectedly', err);
	}
	return { clientId, status: 'rejected', ...mutationRejection(err) };
}

// ---------------------------------------------------------------------------
// stream — GET ?cursor=<b64>|?since=<seq> → SSE diffs from the change feed
// ---------------------------------------------------------------------------

/**
 * A committed row is only safe to emit once its xid drops below the snapshot horizon, which can
 * lag the COMMIT that notified us by the lifetime of an older concurrent transaction. So a wake-up
 * that reads nothing is re-checked briefly instead of going straight back to sleep — otherwise a
 * row could wait for the *next* unrelated commit to be noticed. This settling retry runs only
 * after a notification, never in steady state.
 */
const HORIZON_SETTLE_MS = 25;
const HORIZON_SETTLE_ATTEMPTS = 20;

/**
 * How many of a batch's diffs are resolved at once. Each is an independent policy-scoped read, so
 * the ceiling is the tenant connection pool's appetite rather than anything about correctness.
 */
const DIFF_CONCURRENCY = 16;
/** Keep one tenant-runtime stdout frame small enough that ordinary responses can interleave. */
const STREAM_EMIT_CHUNK_SIZE = 25;

/** Map with a bounded number of in-flight tasks, preserving input order in the result. */
async function mapWithConcurrency<TIn, TOut>(
	items: readonly TIn[],
	limit: number,
	run: (item: TIn) => Promise<TOut>
): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		// stupidity:allow A6 -- each bounded worker intentionally drains several queued items.
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

async function handleStream(event: PodRequestEvent, ctx: ProvisionedContext): Promise<Response> {
	const url = new URL(event.request.url);
	const startCursor = resolveStreamCursor(url);
	// Interest is explicit. A client with nothing subscribed yet still needs the cursor to advance —
	// that is what a read-your-command barrier waits on — but it must not make the server resolve a
	// policy-scoped read for every row in the tenant to deliver contents nobody asked for.
	const subscriptions = new Set(
		url.searchParams
			.getAll('collection')
			.filter((collection) => collection && !CLIENT_OPAQUE_COLLECTIONS.has(collection))
	);
	const encoder = new TextEncoder();

	// Client disconnect is surfaced two ways: the request's own AbortSignal (when the host
	// wires it) and ReadableStream.cancel() (the standalone transport cancels the reader on
	// socket close). Both feed one internal controller that ends the poll loop.
	const abort = new AbortController();
	const signal = abort.signal;
	if (event.request.signal.aborted) abort.abort();
	else event.request.signal.addEventListener('abort', () => abort.abort(), { once: true });

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let cursor = startCursor;
			const send = (payload: string): boolean => {
				if (signal.aborted) return false;
				try {
					controller.enqueue(encoder.encode(payload));
					return true;
				} catch {
					abort.abort();
					return false;
				}
			};
			send(`retry: 3000\n\n`);

			// A resume point below the compaction boundary can no longer be honoured: the changes
			// this client missed have been pruned. Saying so is the whole reason the boundary is
			// durable — the alternative is resuming from the start of a truncated feed and leaving
			// the replica quietly missing everything that was discarded.
			//
			// Checked before every read, not only at connect. Falling behind retention is not
			// something only a *reconnecting* client can do: a stream stays open while its client
			// stops draining it — a sleeping laptop holding the socket, a tab throttled to a halt —
			// and the cursor sits still while an hourly prune walks past it. The read that follows
			// would then quietly skip the pruned range and deliver the rest, which is precisely the
			// silently-wrong replica the boundary exists to prevent. One primary-key lookup per
			// iteration; the loop already issues a batch read next.
			const cursorTooOld = async (): Promise<boolean> => {
				if (!isCursorTooOld(cursor.seq, await syncCompactionBoundary(ctx))) return false;
				send(`event: reset\ndata: {"reason":"cursor_too_old"}\n\n`);
				return true;
			};

			try {
				// `settling` counts down only while we have been told a row exists but the
				// snapshot horizon has not cleared it yet; at zero the loop sleeps until the
				// next commit wakes it.
				let settling = HORIZON_SETTLE_ATTEMPTS;
				// Whether the client has already been told it is caught up, so the event fires once
				// per catch-up rather than every idle wake — cleared the moment a batch has rows again.
				let announcedSynced = false;
				// stupidity:allow A6 -- this is the long-lived SSE pump, bounded by the abort signal.
				while (!signal.aborted) {
					// Snapshot before reading. If a commit lands after the query but before the idle wait,
					// the changed generation makes that wait resolve immediately and the loop re-reads.
					const notificationGeneration = syncNotificationGeneration();
					if (await cursorTooOld()) break;
					const batch = await runWithWorkspaceContext(ctx, () => readSyncOutboxBatch(ctx, cursor));
					if (batch.rows.length > 0) {
						announcedSynced = false;
						// The request's base scope is immutable. A policy/team/user edit can therefore make
						// every row in the replica wrong in either direction. Advance past the announcing
						// batch and require a fresh context + collection catch-up on reconnect.
						if (batch.rows.some((row) => SCOPE_BEARING_COLLECTIONS.has(row.collection))) {
							if (!send(`event: scope-reset\ndata: ${JSON.stringify(batch.cursor)}\n\n`)) break;
							cursor = batch.cursor;
							break;
						}
						const subscribedRows = batch.rows.filter((row) => subscriptions.has(row.collection));
						if (subscribedRows.length === 0) {
							if (!send(`event: cursor\ndata: ${JSON.stringify(batch.cursor)}\n\n`)) break;
							cursor = batch.cursor;
							settling = HORIZON_SETTLE_ATTEMPTS;
							continue;
						}
						// Resolve the batch concurrently, then write it as one chunk.
						//
						// Both halves matter, and for the same reason: a burst must not cost a round
						// trip per row. Resolving serially made the feed's latency the batch size
						// times one policy-scoped read (~18 diffs/s measured), and writing one chunk
						// per diff pushes that same per-row cost onto the client, which applies each
						// chunk as its own replica transaction. A bulk write of ~1,300 rows then
						// delays *everything committed after it* — a rollback, an approval, any
						// urgent single-row change — until the burst has drained.
						//
						// Resolution order carries no meaning (each row is read independently), but
						// emission order does, and concatenating in `diffs` order preserves it. SSE
						// frames are `\n\n`-delimited, so several in one write are indistinguishable
						// on the wire from several writes.
						const diffs = await runWithWorkspaceContext(ctx, () =>
							mapWithConcurrency(subscribedRows, DIFF_CONCURRENCY, (row) => buildDiff(ctx, row))
						);
						if (signal.aborted) break;
						for (let start = 0; start < diffs.length; start += STREAM_EMIT_CHUNK_SIZE) {
							const chunk = diffs.slice(start, start + STREAM_EMIT_CHUNK_SIZE);
							if (!send(chunk.map((diff) => `data: ${JSON.stringify(diff)}\n\n`).join(''))) break;
							// A backlog is the one producer here that is always ready to write more,
							// so it must yield between chunks. Draining without one starves every
							// other request in this process of the event loop until it finishes.
							await abortableDelay(0, signal);
						}
						if (signal.aborted) break;
						cursor = batch.cursor;
						settling = HORIZON_SETTLE_ATTEMPTS;
						continue; // drain fast when there is a backlog
					}
					if (settling > 0) {
						settling -= 1;
						await abortableDelay(HORIZON_SETTLE_MS, signal);
						continue;
					}
					if (!announcedSynced) {
						send(`event: synced\ndata: {}\n\n`);
						announcedSynced = true;
					}
					// Idle: no queries and no cadence of our own. Nothing wakes this but a real
					// commit, through the outbox trigger's NOTIFY — no keep-alive, no repoll.
					await waitForSyncNotification(notificationGeneration, signal);
					settling = HORIZON_SETTLE_ATTEMPTS;
				}
			} catch (err) {
				if (!signal.aborted) {
					console.error('[sync/stream] change feed failed', err);
					send(`event: error\ndata: ${JSON.stringify({ message: errMessage(err) })}\n\n`);
				}
			} finally {
				try {
					controller.close();
				} catch {
					// teardown — ignore; the client already closed the stream.
				}
			}
		},
		cancel() {
			abort.abort();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
}

type SyncDiff = {
	readonly seq: string;
	/** Writing transaction id. Paired with `seq` this is the full resume cursor — a client that
	 *  advanced `seq` alone would keep a stale `xid` and replay the whole feed on every reconnect. */
	readonly xid: string;
	readonly collection: string;
	readonly action: 'insert' | 'update' | 'delete' | 'leave';
	readonly id: string;
	readonly version: number | null;
	readonly row?: Record<string, unknown>;
};

/**
 * Turn a raw outbox row into a policy-scoped diff. A create/update whose row is no longer
 * visible under the user's policy (filtered out or already gone) becomes a `leave` so the
 * client evicts it locally — forbidden rows never reach local storage.
 */
async function buildDiff(
	ctx: ProvisionedContext,
	row: Awaited<ReturnType<typeof readSyncOutboxBatch>>['rows'][number]
): Promise<SyncDiff> {
	if (row.action === 'delete') {
		return {
			seq: row.seq,
			xid: row.xid,
			collection: row.collection,
			action: 'delete',
			id: row.recordId,
			version: row.rowVersion
		};
	}
	// findFirst AND-s the user's policy filter into the WHERE and returns the complete row (or
	// undefined when the record is outside policy scope / already gone → streamed as a `leave`,
	// so the client evicts it locally and forbidden rows never reach local storage).
	const current = await findFirst(ctx, row.collection, {
		where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: row.recordId })
	} as never).catch(() => undefined);
	if (!current) {
		return {
			seq: row.seq,
			xid: row.xid,
			collection: row.collection,
			action: 'leave',
			id: row.recordId,
			version: row.rowVersion
		};
	}
	return {
		seq: row.seq,
		xid: row.xid,
		collection: row.collection,
		action: row.action === 'create' ? 'insert' : 'update',
		id: row.recordId,
		version: row.rowVersion,
		row: current
	};
}

function resolveStreamCursor(url: URL): OutboxCursor {
	const encoded = url.searchParams.get('cursor');
	return (encoded && decodeCursor(encoded)) || OUTBOX_CURSOR_START;
}

function decodeCursor(encoded: string): OutboxCursor | null {
	try {
		// stupidity:allow R6b -- the decoded untrusted cursor is shape-checked immediately below.
		const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
		if (parsed && typeof parsed.xid === 'string' && typeof parsed.seq === 'string') {
			return { xid: parsed.xid, seq: parsed.seq };
		}
		// stupidity:allow S1 -- malformed untrusted cursors deliberately fall back to null.
	} catch {
		// Invalid untrusted cursors fall through to the safe start cursor.
	}
	return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pkeyOf(record: Record<string, unknown>): string | null {
	const id = record[SYSTEM_COLUMN_NAMES.PKEY];
	return typeof id === 'string' ? id : null;
}

function jsonResponse(payload: unknown, headers: HeadersInit): Response {
	return new Response(JSON.stringify(payload), {
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
