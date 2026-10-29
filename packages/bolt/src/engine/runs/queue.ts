// The one queue (rules 48–52a): `sys_run` rows with a `due_at`. A model's effect runs are a piece of the causing write's
// statement (`queueEffects`); a due time 5 minutes or more ahead is rounded up to a 5-minute bucket.
// Crons are not queued: the host's clock fires them (`Runs.fire`), automations' and remote syncs' reads alike
// (`syncTriggers`, engine/sync/index.ts).
import { Result, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS, type Authority, type CronEntry, type QueuedRun } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { Holder } from '../access/authority.ts';
import type { EngineManifest } from '../manifest.ts';
import { catalogOf } from '../access/pred.ts';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import { EFFECT_VERBS } from '../../decl/model.ts';
import { type Chain } from '../write/sql.ts';
import { actorRef } from '../write/commit.ts';

/** Every run INSERT belongs to this builder; the registry also supplies the commit's exact wake time. */
const pieces = new WeakMap<Chain, string[]>();
export function enqueue(
	c: Chain,
	rows: readonly QueuedRun[] | { readonly select: string },
	options: {
		readonly when?: string | undefined;
		readonly conflict?: 'replace' | 'keep' | undefined;
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
		options.conflict === 'replace'
			? `ON CONFLICT (key) DO UPDATE SET input = excluded.input, due_at = excluded.due_at
		WHERE sys_run.automation = excluded.automation AND sys_run.state = 'queued' AND sys_run.attempts = 0`
			: options.conflict === 'keep'
				? 'ON CONFLICT DO NOTHING'
				: '';
	return c.cte(
		name,
		`INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth, actor, starter, trigger, state, attempts, started_at, error, finished_at)
	SELECT coalesce(r.j->>'id', gen_random_uuid()::text), r.j->>'automation', coalesce(r.j->'input', '{}'::jsonb),
		coalesce(r.j->>'due_at', r.j->>'dueAt', 'now')::timestamptz, r.j->>'key', r.j->>'cause', coalesce((r.j->>'depth')::int, 0),
		r.j->>'actor', r.j->'starter', r.j->'trigger', coalesce(r.j->>'state', 'queued'), coalesce((r.j->>'attempts')::int, 0),
		(r.j->>'started_at')::timestamptz, r.j->'error', (r.j->>'finished_at')::timestamptz
	FROM (${source}) v CROSS JOIN LATERAL (SELECT ${json} AS j) r
	${options.when === undefined ? '' : `WHERE ${options.when}`} ${conflict}
	RETURNING id, CASE WHEN state = 'queued' THEN due_at ELSE NULL END AS due_at`
	);
}
export function nextDue(c: Chain): string {
	const selects = [
		...(pieces.get(c) ?? []).map((name) => `SELECT due_at FROM ${name}`),
		...c.notices.map((name) => `SELECT (image->>'at')::timestamptz AS due_at FROM ${name}`)
	];
	return selects.length === 0
		? 'NULL::timestamptz'
		: `(SELECT min(due_at) FROM (${selects.join(' UNION ALL ')}) queued_due)`;
}

const TriggerSpec = Schema.Union([
	Schema.Struct({ cron: Schema.String, tz: Schema.optionalKey(Schema.String) }),
	Schema.Struct({
		webhook: Schema.String,
		verify: Schema.Struct({ scheme: Schema.String, secret: Schema.String })
	})
]);
export type WebhookTrigger = { automation: string; path: string; scheme: string; secret: string };
export type Triggers = {
	crons: readonly CronEntry[];
	webhooks: readonly WebhookTrigger[];
};

// Effect's `Cron` takes fields only: a declared macro is its five fields
const MACROS: { readonly [macro: string]: string } = {
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
	'@monthly': '0 0 1 * *',
	'@weekly': '0 0 * * 0',
	'@daily': '0 0 * * *',
	'@hourly': '0 * * * *'
};
const fields = (cron: string) => MACROS[cron.trim()] ?? cron;
const cache = new WeakMap<EngineManifest, Triggers>();
/** Every declared trigger, compiled once per manifest; the host's clock computes the crons' slots. */
export function triggersOf(m: EngineManifest): Triggers {
	const cached = cache.get(m);
	if (cached !== undefined) return cached;
	const crons: CronEntry[] = [],
		webhooks: WebhookTrigger[] = [];
	for (const [automation, spec] of Object.entries(m.automations)) {
		const decoded = Schema.decodeUnknownResult(Schema.Array(TriggerSpec))(
			spec.on === undefined ? [] : Array.isArray(spec.on) ? spec.on : [spec.on]
		);
		if (Result.isFailure(decoded))
			throw BoltError.make(
				'invalid',
				'decode',
				`automation ${automation}: ${decoded.failure.message}`
			);
		const on = decoded.success;
		for (const x of on) {
			if ('cron' in x) {
				crons.push({ id: automation, cron: fields(x.cron), zone: x.tz ?? m.workspace.tz });
				continue;
			}
			const v = x.verify;
			webhooks.push({ automation, path: x.webhook, scheme: v.scheme, secret: v.secret });
		}
	}
	const triggers = { crons, webhooks };
	cache.set(m, triggers);
	return triggers;
}

/**
 * Who committed a write: the holder its model effects run as (`sys_run.starter`), its actor ref, and the depth the
 * effects run at (one below the run that wrote, 0 for a write outside any run).
 */
export type Writer = { readonly starter: Json; readonly actor: string; readonly depth: number };
/**
 * The holder an authority is compiled from: a run's own (`Authority.run`, never a delegation's added policies), else
 * the authority's. A platform or sync actor stays the platform.
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
		starter: Schema.encodeSync(Schema.Json)(holder),
		actor: actorRef(holder.actor),
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
	return verb !== undefined && m.exposures[model]?.effect?.[verb] === true
		? { model, verb }
		: undefined;
}

const OP = { created: 'create', updated: 'update', deleted: 'delete' } as const;
/** Fields whose change runs an `updated` effect: stored values, never roll-ups, computed or system columns. */
function storedFields(m: EngineManifest, model: string): readonly string[] {
	const info = catalogOf(m).models.get(model);
	if (info === undefined)
		throw BoltError.make('internal', 'decode', `the effect names missing model ${model}`);
	return [
		...[...info.fields.values()]
			.filter(
				(f) => !f.derived && !f.computed && !(SYSTEM_COLUMNS as readonly string[]).includes(f.name)
			)
			.map((f) => f.column),
		...[...info.one.keys()].filter((k) => !info.fields.has(k))
	];
}

/**
 * The causing statement's piece: reads its own row changes (`source`: `c, id, op, o, n`) and queues one run per model
 * effect verb they reach, as `writer` (`'trigger'` authority), with the committed images: `{ ids, rows }` (created: the
 * new rows; deleted: the old) or `{ ids, changes: [{ before, after }] }` (updated, when a stored field changed). Past
 * the chain depth the run is recorded failed instead, which ends an effect loop.
 */
export function queueEffects(
	m: EngineManifest,
	c: Chain,
	now: string,
	writer: Writer,
	source = 'allp'
): void {
	const selects = Object.entries(m.exposures).flatMap(([model, spec]) =>
		EFFECT_VERBS.filter((verb) => spec.effect?.[verb] === true).map((verb) => {
			const changed =
				verb !== 'updated'
					? 'true'
					: `(${
							storedFields(m, model)
								.map((f) => `(x.o -> ${c.p(f)}) IS DISTINCT FROM (x.n -> ${c.p(f)})`)
								.join(' OR ') || 'false'
						})`;
			const images =
				verb === 'updated'
					? `'changes', jsonb_agg(jsonb_build_object('before', x.o, 'after', x.n) ORDER BY x.id)`
					: `'rows', jsonb_agg(x.${verb === 'deleted' ? 'o' : 'n'} ORDER BY x.id)`;
			return `SELECT ${c.p(effectRun(model, verb))}::text AS a, jsonb_build_object('ids', jsonb_agg(x.id ORDER BY x.id), ${images}) AS input
		FROM ${source} x WHERE x.c = ${c.p(model)} AND x.op = '${OP[verb]}' AND ${changed} HAVING count(*) > 0`;
		})
	);
	if (selects.length === 0) return;
	const deep = writer.depth > LIMITS.writeDepth;
	enqueue(c, {
		select: `SELECT t.a AS automation, t.input, ${c.p(now)}::timestamptz AS due_at, 'effect'::text AS cause,
		${c.p(writer.depth)}::int AS depth, ${c.p(writer.actor)}::text AS actor, ${c.p(writer.starter)}::jsonb AS starter${
			deep
				? `, 'failed'::text AS state, ${c.p({ code: 'depth', message: `Effects chain at most ${LIMITS.writeDepth} deep: this write's effect did not run.` })}::jsonb AS error, ${c.p(now)}::timestamptz AS finished_at`
				: ''
		}
		FROM (${selects.join(' UNION ALL ')}) t`
	});
}
