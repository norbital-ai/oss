import { actor_ref } from '../access/actor.ts';
import { runPiece } from './rows.ts';
// The one queue: `sys_run` rows with a `due_at`. A causing write queues its free effects and freezes
// held effects with their approval; the accepting decision releases them. Distant due times use five-minute buckets.
// Crons are not queued: the host's clock fires them (`Runs.fire`), automations' and remote syncs' reads alike
// (`syncTriggers`, engine/sync/index.ts).
import { Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS, type Authority, type CronEntry, type QueuedRun } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { Holder } from '../access/authority.ts';
import type { EngineManifest } from '../manifest.ts';
import { catalog_of } from '../access/pred.ts';
import { SYSTEM_COLUMN_SET } from '@norbital-ai/store';
import { EFFECT_VERBS } from '../../decl/model.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { storedImageSql } from '../db/stored.ts';

import { duration } from './time.ts';
import { cronFields } from './cron.ts';

/** Every run INSERT belongs to this builder; the registry also supplies the commit's exact wake time. */
const pieces = new WeakMap<Chain, string[]>();
export function enqueue(
	c: Chain,
	rows: readonly QueuedRun[] | { readonly select: string },
	options: {
		readonly when?: string | undefined;
		readonly conflict?: 'replace' | 'keep' | 'earliest' | undefined;
	} = {}
): string {
	const names = pieces.get(c) ?? [];
	pieces.set(c, names);
	const name = `run${names.length}`;
	names.push(name);
	const source =
		'select' in rows
			? rows.select
			: `SELECT * FROM jsonb_array_elements(${c.p(rows)}::jsonb) AS v(j)`;
	const json = 'select' in rows ? 'to_jsonb(v)' : 'v.j';
	const conflict =
		options.conflict === 'replace' || options.conflict === 'earliest'
			? `ON CONFLICT (key) DO UPDATE SET input = excluded.input, due_at = ${options.conflict === 'earliest' ? 'least(sys_run.due_at, excluded.due_at)' : 'excluded.due_at'}
		WHERE sys_run.automation = excluded.automation AND sys_run.state = 'queued' AND sys_run.attempts = 0`
			: options.conflict === 'keep'
				? 'ON CONFLICT DO NOTHING'
				: '';
	return runPiece(c,
		name,
		`INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth, actor, starter, trigger, state, attempts, started_at, error, finished_at)
	SELECT coalesce(r.j->>'id', gen_random_uuid()::text), r.j->>'automation', coalesce(r.j->'input', '{}'::jsonb),
		coalesce(r.j->>'due_at', 'now')::timestamptz, r.j->>'key', r.j->>'cause', coalesce((r.j->>'depth')::int, 0),
		r.j->>'actor', r.j->'starter', r.j->'trigger', coalesce(r.j->>'state', 'queued'), coalesce((r.j->>'attempts')::int, 0),
		(r.j->>'started_at')::timestamptz, r.j->'error', (r.j->>'finished_at')::timestamptz
	FROM (${source}) v CROSS JOIN LATERAL (SELECT ${json} AS j) r
	${options.when === undefined ? '' : `WHERE ${options.when}`} ${conflict}`,
		{ returning: "id, CASE WHEN state = 'queued' THEN due_at ELSE NULL END AS due_at" }
	);
}
/** Drain keys belong only to waiting work: claiming the run releases its key for the next pass. */
export const DRAIN_KEY_PREFIX = 'bolt.drain:';
const drains = new WeakMap<Chain, Map<string, string[]>>();
/** One queued drain per operation, brought forward by earlier work. `due` and `when` are SQL expressions. */
export const enqueueDrain = (c: Chain, automation: string, due: string, when?: string): string => {
	const queued = drains.get(c) ?? new Map<string, string[]>();
	drains.set(c, queued);
	const prior = queued.get(automation) ?? [];
	// A statement's callers share its clock; only the first admitted request writes this drain key.
	const admitted = [`(${when ?? 'true'})`, ...prior.map((name) => `NOT EXISTS (SELECT 1 FROM ${name})`)].join(' AND ');
	const name = enqueue(c, {
		select: `SELECT ${c.p(automation)}::text AS automation, '{}'::jsonb AS input,
		${due}::timestamptz AS due_at, ${c.p(`${DRAIN_KEY_PREFIX}${automation}`)}::text AS key,
		'schedule'::text AS cause, 0 AS depth WHERE ${admitted}`
	}, { conflict: 'earliest' });
	queued.set(automation, [...prior, name]);
	return name;
};
export function next_due(c: Chain): string {
	const selects = (pieces.get(c) ?? []).map((name) => `SELECT due_at FROM ${name}`);
	return selects.length === 0
		? 'NULL::timestamptz'
		: `(SELECT min(due_at) FROM (${selects.join(' UNION ALL ')}) queued_due)`;
}

type Triggers = {
	crons: readonly CronEntry[];
	/** How long each cron that declares `rest` may rest, in ms. */
	rests: ReadonlyMap<string, number>;
	/** Each automation listening to a model's committed writes (`on: [{ model, verbs }]`). */
	writes: readonly WriteTrigger[];
};
export type WriteTrigger = { readonly automation: string; readonly model: string; readonly verbs: readonly string[] };

const cache = new WeakMap<EngineManifest, Triggers>();
/** Every declared trigger, compiled once per manifest; the host's clock computes the crons' slots. */
export function triggers_of(m: EngineManifest): Triggers {
	const cached = cache.get(m);
	if (cached !== undefined) return cached;
	const crons: CronEntry[] = [],
		rests = new Map<string, number>(),
		writes: WriteTrigger[] = [];
	for (const [automation, spec] of Object.entries(m.automations)) {
		for (const x of spec.on ?? []) {
			if ('model' in x) {
				writes.push({ automation, model: x.model, verbs: x.verbs });
				continue;
			}
			crons.push({ id: automation, cron: cronFields(x.cron), zone: x.tz ?? m.workspace.tz });
			if (x.rest !== undefined) rests.set(automation, duration(x.rest));
		}
	}
	const triggers = { crons, rests, writes };
	cache.set(m, triggers);
	return triggers;
}

/**
 * Who committed a write: the holder its model effects run as (`sys_run.starter`), its actor ref, and the depth the
 * effects run at (one below the run that wrote, 0 for a write outside any run).
 */
export type Writer = { readonly starter: Json; readonly actor: string; readonly depth: number };
/**
 * The holder an authority is compiled from. A platform or sync actor stays the platform.
 */
export const holderOf = (a: Authority): Holder =>
	a.run?.holder ?? {
		actor: a.actor,
		policies: a.policies,
		admin: a.admin,
		teamTree: a.teamTree,
		scopes: a.scopes,
		...(a.actor.kind === 'system' && !('automation' in a.actor.by) ? { platform: true } : {})
	};
export const writerOf = (a: Authority): Writer => {
	const holder = holderOf(a);
	return {
		starter: holder,
		actor: actor_ref(holder.actor),
		depth: a.run === undefined ? 0 : a.run.depth + 1
	};
};
/** A model effect's run name, and back. */
export const effectRun = (model: string, verb: (typeof EFFECT_VERBS)[number]) =>
	`${model}.effect.${verb}`;
export function effectOf(
	m: EngineManifest,
	automation: string
): { readonly model: string; readonly verb: (typeof EFFECT_VERBS)[number] } | undefined {
	const at = automation.lastIndexOf('.effect.');
	if (at <= 0) return undefined;
	const model = automation.slice(0, at),
		verb = EFFECT_VERBS.find((v) => v === automation.slice(at + 8));
	return verb !== undefined && m.exposures[model]?.[verb]?.effect === true
		? { model, verb }
		: undefined;
}

/** Fields whose change runs an update effect: stored values, never roll-ups, computed or system columns. */
function storedFields(m: EngineManifest, model: string): readonly string[] {
	const info = catalog_of(m).models.get(model);
	if (info === undefined)
		throw BoltError.make('internal', 'decode', `the effect names missing model ${model}`);
	return [
		...[...info.fields.values()]
			.filter(
				(f) => !f.derived && !f.computed && !SYSTEM_COLUMN_SET.has(f.name)
			)
			.map((f) => f.column),
		...[...info.one.keys()].filter((k) => !info.fields.has(k))
	];
}

export const effectDepthFailure = {
	code: 'depth',
	message: `Effects chain at most ${LIMITS.writeDepth} deep: this write's effect did not run.`
};
/** Freeze the actual change and writer; held jobs have no runnable row until the approval accepts them. */
export function queue_effects(
	m: EngineManifest,
	c: Chain,
	now: string,
	writer: Writer,
	source: string,
	operation: string,
	requests: string | null
): void {
	const catalog = catalog_of(m);
	const rows = 'effect_rows';
	const selects = Object.entries(m.exposures).flatMap(([model, spec]) =>
		EFFECT_VERBS.filter((verb) => spec[verb]?.effect === true).map((verb) => {
			const changed =
				verb !== 'update'
					? 'true'
					: `(${
							storedFields(m, model)
								.map((f) => `(x.o -> ${c.p(f)}) IS DISTINCT FROM (x.n -> ${c.p(f)})`)
								.join(' OR ') || 'false'
						})`;
			const before = storedImageSql(catalog, [model], 'x.o');
			const after = storedImageSql(catalog, [model], 'x.n');
			const set = verb === 'delete' ? "'{}'::jsonb" : verb === 'create' ? after
				: `(SELECT coalesce(jsonb_object_agg(v.key, v.value), '{}'::jsonb) FROM jsonb_each(${after}) v WHERE (${before} -> v.key) IS DISTINCT FROM v.value)`;
			return `SELECT x.request,${c.p(effectRun(model, verb))}::text AS a,
			jsonb_build_object('event', jsonb_build_object('kind', 'write'), 'ids', jsonb_agg(x.id ORDER BY x.id), 'changes',
				jsonb_agg(jsonb_build_object('before', ${before}, 'set', ${set}, 'after', ${after}) ORDER BY x.id)) AS input
			FROM ${rows} x WHERE x.c = ${c.p(model)} AND x.op = '${verb}' AND ${changed}
			GROUP BY x.request HAVING count(*) > 0`;
		})
	);
	if (requests !== null) {
		c.cte(rows, `SELECT x.*,h.id AS request FROM ${source} x LEFT JOIN ${requests} h ON
		EXISTS (SELECT 1 FROM jsonb_array_elements(h.records) r
		WHERE r->>'collection'=x.c AND r->>'id'=x.id)`);
		c.assert(`NOT EXISTS (SELECT c,id FROM ${rows} GROUP BY c,id HAVING count(*)>1)`,
			'under_approval', 'A changed record belongs to more than one approval request.');
	} else if (selects.length > 0) c.cte(rows, `SELECT x.*,NULL::uuid AS request FROM ${source} x`);
	const { writes } = triggers_of(m);
	// built only when used: an unused parameter has no type PostgreSQL can determine
	if (writes.length > 0) queue_events(c, writes, `${c.shared('now', now)}::timestamptz`, requests === null ? source : `(SELECT * FROM ${rows} WHERE request IS NULL)`, writer.depth, GATED);
	if (selects.length === 0) return;
	const deep = writer.depth > LIMITS.writeDepth;
	const jobs = c.cte('effect_jobs',
		`SELECT t.request,t.a AS automation,t.input,${c.shared('now', now)}::timestamptz AS due_at,'effect'::text AS cause,
		${c.p(writer.depth)}::int AS depth,${c.p(writer.actor)}::text AS actor,${c.p(writer.starter)}::jsonb AS starter,
		${c.p(deep ? 'failed' : 'queued')}::text AS state,${c.p(deep ? effectDepthFailure : null)}::jsonb AS error,
		${c.p(deep ? now : null)}::timestamptz AS finished_at FROM (${selects.join(' UNION ALL ')}) t`);
	c.cte('ap_deferred_effects',
		`INSERT INTO bolt_approval_effect(request,operation,automation,input,due_at,actor,starter,depth,state,error,finished_at)
		SELECT request,${c.p(operation)}::text || ':' || pg_current_xact_id()::text,automation,input,due_at,actor,starter,depth,state,error,finished_at
		FROM ${jobs} WHERE request IS NOT NULL AND ${GATED}
		ON CONFLICT (request,operation,automation) DO NOTHING RETURNING request`);
	enqueue(c, { select: `SELECT automation,input,due_at,cause,depth,actor,starter,state,error,finished_at
		FROM ${jobs} WHERE request IS NULL AND ${GATED}` });
}

/**
 * One run per listening automation and verb for the rows `source` (`c`, `id`, `op`) committed, as the system identity
 * (no actor or starter: the executor holds the automation's policies). Past the write depth it is recorded failed.
 */
export function queue_events(
	c: Chain,
	writes: readonly WriteTrigger[],
	now: string,
	source: string,
	depth: number,
	when?: string
): void {
	if (writes.length === 0) return;
	const deep = depth > LIMITS.writeDepth;
	const selects = writes.map((w) => `SELECT ${c.p(w.automation)}::text AS automation,'{}'::jsonb AS input,${now} AS due_at,
	'event'::text AS cause,${c.p(depth)}::int AS depth,${c.p(deep ? 'failed' : 'queued')}::text AS state,
	${c.p(deep ? effectDepthFailure : null)}::jsonb AS error,CASE WHEN ${c.p(deep)}::boolean THEN ${now} END AS finished_at,
	jsonb_build_object('kind','system','cause','event','model',x.c,'verb',x.op,'records',jsonb_agg(x.id ORDER BY x.id)) AS trigger
	FROM ${source} x WHERE x.c = ${c.p(w.model)} AND x.op = ANY(ARRAY[${w.verbs.map((v) => c.p(v)).join(',')}]::text[]) GROUP BY x.c,x.op`);
	enqueue(c, { select: selects.join(' UNION ALL ') }, when === undefined ? {} : { when });
}

/**
 * The closing decision releases frozen jobs atomically, or discards them when the change is rejected. A standing
 * change emits its held records' write events now, each with its net verb, at the decider's depth.
 */
export function settleApprovalEffects(
	m: EngineManifest,
	c: Chain,
	request: string,
	stands: boolean,
	now: string,
	depth: number
): void {
	const released = c.cte('ap_released_effects',
		`DELETE FROM bolt_approval_effect WHERE request=${c.p(request)}::uuid
		AND EXISTS (SELECT 1 FROM up) AND ${GATED} RETURNING *`);
	if (!stands) return;
	enqueue(c, { select: `SELECT automation,input,due_at,'effect'::text AS cause,
		depth,actor,starter,state,error,finished_at FROM ${released}` });
	const { writes } = triggers_of(m);
	if (writes.length > 0)
		queue_events(c, writes, `${c.p(now)}::timestamptz`, `(SELECT r->>'collection' AS c,r->>'id' AS id,r->>'op' AS op
		FROM bolt_approvals a CROSS JOIN LATERAL jsonb_array_elements(a.records) r WHERE a.id IN (SELECT id FROM up))`, depth, GATED);
}
