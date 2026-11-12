// Native initialization of a write sync's current rows, one bounded page per durable run.
import { canonical, q, sha256_hex } from '@norbital-ai/store';
import { Clock, Effect, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { storedRowSql } from '../db/stored.ts';
import type { EngineManifest } from '../manifest.ts';
import { enqueue, next_due } from '../runs/queue.ts';
import { runPiece } from '../runs/rows.ts';
import { iso } from '../runs/time.ts';
import { Chain, GATED } from '../write/sql.ts';
import { syncs_of, type RemoteSync, type SyncEngine } from './index.ts';
import { enqueueReplicas, SYNC_EPOCH } from './outbox.ts';
import { open_sql } from '../approvals/sql.ts';

export const SYNC_BACKFILL = 'sync.backfill';
const PAGE_ROWS = 250;
const PAGE_BYTES = 1024 * 1024;
const pieces = new WeakMap<Chain, number>();
const generation = (m: EngineManifest, s: RemoteSync, c: Chain, updated: string) =>
	`md5(${c.p(sha256_hex(canonical({ sync: s.entry, model: m.models[s.model] })))} || ':' || ${SYNC_EPOCH} || ':' || extract(epoch from ${updated})::text)`;
const key = (sync: string, instance: string, generation: string, after: string) =>
	`'bolt.sync.backfill:' || ${sync} || ':' || ${instance} || ':' || ${generation} || ':' || coalesce(${after}, '')`;
const replayId = (run: string) => `'bolt.sync.replay:' || ${run}`;

/** Only the current source/connection generation owns initialization work. */
function currentBackfills(m: EngineManifest, c: Chain): string {
	const current = [...syncs_of(m).values()].filter((s) => s.write).map((s) =>
		`(r.input ->> 'sync' = ${c.p(s.name)} AND i.integration = ${c.p(s.definition)}
		AND r.input ->> 'generation' = ${generation(m, s, c, 'i.updated_at')})`);
	return `SELECT r.* FROM sys_run r
		JOIN sys_integration i ON i.id::text = r.input ->> 'instance'
		WHERE r.automation = ${c.p(SYNC_BACKFILL)} AND (${current.length === 0 ? 'false' : current.join(' OR ')})`;
}

/** The generation's first key prevents boot rescans; an unresolved failure must remain visible/replayable. */
export function retainedBackfills(m: EngineManifest, c: Chain): string {
	return `${currentBackfills(m, c)} AND ((r.input ->> 'after' IS NULL AND r.input ->> 'replay_of' IS NULL)
		OR (r.state IN ('failed', 'stopped') AND r.progress ->> 'replayed_by' IS NULL))`;
}

/** Failed work belongs to the current source/connection generation and has no replacement yet. */
export function failedBackfills(m: EngineManifest, c: Chain, instance: string): string {
	return `${currentBackfills(m, c)} AND i.id::text = ${c.p(instance)} AND r.state IN ('failed', 'stopped')
		AND r.progress ->> 'replayed_by' IS NULL`;
}

/** Replacement runs retain the original failed run/attempts and resume its exact cursor. */
export function replayBackfills(m: EngineManifest, c: Chain, instance: string, now: string): string {
	const failed = c.cte('backfills_to_replay', failedBackfills(m, c, instance));
	const replacement = enqueue(c, { select: `SELECT ${replayId('r.id::text')} AS id, ${c.p(SYNC_BACKFILL)}::text AS automation,
		jsonb_set(r.input, '{replay_of}', to_jsonb(r.id::text)) AS input,
		${c.p(now)}::timestamptz AS due_at, ${replayId('r.id::text')} AS key,
		'schedule'::text AS cause, 0 AS depth FROM ${failed} r`
	}, { conflict: 'keep' });
	runPiece(c, 'backfills_replayed', `UPDATE sys_run r
		SET progress = coalesce(r.progress, '{}'::jsonb) || jsonb_build_object('replayed_by', successor.id)
		FROM ${replacement} successor WHERE successor.id = ${replayId('r.id::text')}`);
	return replacement;
}

/** Boot and committed connection edits schedule initialization; ordinary delivery drains do no model scan. */
export function enqueueBackfills(m: EngineManifest, c: Chain, now: string, source?: string): void {
	const syncs = [...syncs_of(m).values()].filter((s) => s.write);
	if (syncs.length === 0) return;
	const index = pieces.get(c) ?? 0;
	pieces.set(c, index + 1);
	const connections = c.cte(`sync_initial_connections${index}`, source === undefined
		? 'SELECT id::text AS id, integration, updated_at FROM sys_integration WHERE active'
		: `SELECT x.id::text AS id, x.n ->> 'integration' AS integration,
			(x.n ->> 'updated_at')::timestamptz AS updated_at FROM ${source} x
			WHERE x.c = 'sys_integration' AND x.n ->> 'active' = 'true' AND ${GATED}`);
	enqueue(c, { select: syncs.map((s) => {
		const name = c.p(s.name), next = generation(m, s, c, 'i.updated_at');
		return `SELECT ${c.p(SYNC_BACKFILL)}::text AS automation,
			jsonb_build_object('sync', ${name}::text, 'instance', i.id, 'generation', ${next}, 'after', NULL) AS input,
			${c.p(now)}::timestamptz AS due_at, ${key(`${name}::text`, 'i.id', next, 'NULL::text')} AS key,
			'schedule'::text AS cause, 0 AS depth FROM ${connections} i WHERE i.integration = ${c.p(s.definition)}`;
	}).join(' UNION ALL ') }, { conflict: 'keep' });
}

const Input = Schema.Struct({
	sync: Schema.String,
	instance: Schema.String,
	generation: Schema.String,
	after: Schema.NullOr(Schema.String),
	replay_of: Schema.optionalKey(Schema.String)
});

export const makeBackfill = (e: SyncEngine) => Effect.fn('Syncs.backfill')(function* (input: Json) {
	const x = yield* Schema.decodeUnknownEffect(Input)(input).pipe(Effect.mapError((error) =>
		BoltError.make('bad_answer', 'decode', 'The sync backfill input is malformed.', error)));
	const m = e.manifest, s = syncs_of(m).get(x.sync);
	if (s === undefined || !s.write) return { queued: 0 };
	const cat = catalog_of(m);
	if (!cat.models.has(s.model))
		return yield* Effect.fail(BoltError.make('bad_answer', 'decode', `The sync model '${s.model}' is missing.`));
	const c = new Chain(), now = iso(yield* Clock.currentTimeMillis), at = c.p(now),
		name = c.p(s.name), instance = c.p(x.instance), version = c.p(x.generation), after = c.p(x.after);
	const target = c.cte('target', `SELECT i.id FROM sys_integration i WHERE i.id = ${instance}
		AND i.active AND i.integration = ${c.p(s.definition)} AND ${generation(m, s, c, 'i.updated_at')} = ${version}`);
	const candidates = c.cte('candidates', `SELECT t.id, t.revision, ${storedRowSql(cat, s.model, 't')} AS image
		FROM ${q(s.model)} t WHERE EXISTS (SELECT 1 FROM ${target})
		AND (${after}::text IS NULL OR t.id::text > ${after}::text) ORDER BY t.id::text LIMIT ${PAGE_ROWS}`);
	const page = c.cte('page', `SELECT id, revision, image FROM (
		SELECT *, row_number() OVER (ORDER BY id::text) AS n,
		sum(octet_length(image::text)) OVER (ORDER BY id::text) AS bytes FROM ${candidates}
	) bounded WHERE n = 1 OR bytes <= ${PAGE_BYTES}`);
	const queued = enqueueReplicas(c, now, `SELECT ${name}::text AS sync, ${instance}::text AS instance,
		${c.p(s.model)}::text AS model, p.id::text AS record,
			CASE WHEN r.id IS NULL THEN 'create' ELSE 'update' END AS op, p.revision AS record_revision, true AS preserve_local,
			(SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(p.image) k
			WHERE k NOT IN ('id', 'revision', 'created_at', 'created_by', 'updated_at', 'updated_by')) AS changed,
			p.image, NULL::text AS writer FROM ${page} p
		LEFT JOIN sys_sync_row r ON r.sync = ${name} AND r.instance = ${instance} AND r.record = p.id::text
		WHERE (r.acked_revision IS NULL OR r.acked_revision < p.revision)
		AND NOT EXISTS (SELECT 1 FROM sys_outbox o WHERE o.sync = ${name} AND o.instance = ${instance}
			AND o.record = p.id::text AND o.record_revision >= p.revision)
		AND NOT EXISTS (SELECT 1 FROM bolt_approvals a CROSS JOIN LATERAL jsonb_array_elements(a.records) held
			WHERE ${open_sql('a.state')} AND held ->> 'collection' = ${c.p(s.model)} AND held ->> 'id' = p.id::text)`);
	const next = `(SELECT max(id::text) FROM ${page})`;
	enqueue(c, { select: `SELECT ${c.p(SYNC_BACKFILL)}::text AS automation,
		jsonb_build_object('sync', ${name}::text, 'instance', ${instance}::text, 'generation', ${version}::text, 'after', ${next}) AS input,
		${at}::timestamptz AS due_at, ${key(`${name}::text`, `${instance}::text`, `${version}::text`, next)} AS key,
		'schedule'::text AS cause, 0 AS depth WHERE (SELECT count(*) FROM ${candidates}) = ${PAGE_ROWS}
		OR (SELECT count(*) FROM ${candidates}) > (SELECT count(*) FROM ${page})`
	}, { conflict: 'keep' });
	const result = yield* nativeCommit(
		(statement) => e.db.write(statement, { tables: [s.model, 'sys_outbox'].sort(), mode: 'SHARE ROW EXCLUSIVE' }),
		e.live.publish, c, Schema.Struct({
		...CapturedResult.fields, queued: Schema.Number, next: Schema.NullOr(Schema.String)
	}), `(SELECT count(*)::int FROM ${queued}) AS queued, ${next_due(c)}::text AS next`);
	if (result.next !== null) yield* e.announce(result.next);
	return { queued: result.queued };
});
