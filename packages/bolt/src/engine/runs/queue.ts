// The one queue (rules 48–52a): `sys_run` rows with a `due_at`. Event-triggered runs are a piece of the causing act's
// statement, their `where` evaluated there once; a due time 5 minutes or more ahead is rounded up to a 5-minute bucket.
// Crons are not queued: the host's clock fires them (`Runs.fire`), automations' and remote syncs' reads alike
// (`syncTriggers`, engine/sync/index.ts).
import { Result, Schema } from 'effect';
import { BoltError, storeSync } from '../../protocol/errors.ts';
import type { Json } from '../../decl/values.ts';
import type { CronEntry, QueuedRun } from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import { catalogOf, toPred } from '../access/pred.ts';
import { nullRowSql, SYSTEM_COLUMNS } from '@norbital-ai/store';
import { ownPredSql } from '@norbital-ai/store';
import { type Chain } from '../write/sql.ts';
import { duration, dueAt, iso } from './time.ts';

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
		`INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth, actor, starter, state, attempts, started_at, error, finished_at)
	SELECT coalesce(r.j->>'id', gen_random_uuid()::text), r.j->>'automation', coalesce(r.j->'input', '{}'::jsonb),
		coalesce(r.j->>'due_at', r.j->>'dueAt', 'now')::timestamptz, r.j->>'key', r.j->>'cause', coalesce((r.j->>'depth')::int, 0),
		r.j->>'actor', r.j->'starter', coalesce(r.j->>'state', 'queued'), coalesce((r.j->>'attempts')::int, 0),
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

const EventFields = {
	where: Schema.optionalKey(Schema.Json),
	fields: Schema.optionalKey(Schema.Array(Schema.String)),
	delay: Schema.optionalKey(Schema.String)
};
const TriggerSpec = Schema.Union([
	Schema.Struct({ cron: Schema.String, tz: Schema.optionalKey(Schema.String) }),
	Schema.Struct({
		webhook: Schema.String,
		verify: Schema.Struct({ scheme: Schema.String, secret: Schema.String })
	}),
	Schema.Struct({ created: Schema.String, ...EventFields }),
	Schema.Struct({ updated: Schema.String, ...EventFields }),
	Schema.Struct({ deleted: Schema.String, ...EventFields })
]);
export type EventTrigger = {
	automation: string;
	event: 'created' | 'updated' | 'deleted';
	collection: string;
	where?: Pred | undefined;
	fields?: readonly string[] | undefined;
	delayMs?: number | undefined;
};
export type WebhookTrigger = { automation: string; path: string; scheme: string; secret: string };
export type Triggers = {
	events: readonly EventTrigger[];
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
/** Every declared trigger, compiled once per manifest (`where` → Pred); the host's clock computes the crons' slots. */
export function triggersOf(m: EngineManifest): Triggers {
	const cached = cache.get(m);
	if (cached !== undefined) return cached;
	const events: EventTrigger[] = [],
		crons: CronEntry[] = [],
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
			if ('webhook' in x) {
				const v = x.verify;
				webhooks.push({ automation, path: x['webhook'], scheme: v.scheme, secret: v.secret });
				continue;
			}
			const event = 'created' in x ? 'created' : 'updated' in x ? 'updated' : 'deleted';
			const collection = 'created' in x ? x.created : 'updated' in x ? x.updated : x.deleted;
			events.push({
				automation,
				event,
				collection,
				where: x.where === undefined ? undefined : toPred(m, collection, x.where),
				fields: x.fields,
				delayMs: x.delay === undefined ? undefined : duration(x.delay)
			});
		}
	}
	const triggers = { events, crons, webhooks };
	cache.set(m, triggers);
	return triggers;
}

const OP = { created: 'create', updated: 'update', deleted: 'delete' } as const;
/** Fields whose change fires an `updated` trigger without `fields`: stored values, never roll-ups or computed (rule 50). */
function storedFields(m: EngineManifest, collection: string): readonly string[] {
	const model = catalogOf(m).models.get(collection);
	if (model === undefined)
		throw BoltError.make(
			'internal',
			'decode',
			`the event trigger names missing model ${collection}`
		);
	return [
		...[...model.fields.values()]
			.filter(
				(f) => !f.derived && !f.computed && !(SYSTEM_COLUMNS as readonly string[]).includes(f.name)
			)
			.map((f) => f.column),
		...[...model.one.keys()].filter((k) => !model.fields.has(k))
	];
}

/**
 * Rule 49/50: the causing statement's piece. Reads the statement's own row changes (`allp`: `c, id, op, o, n`), keeps
 * those each trigger admits (its `where` on the post-image, the pre-image for `deleted`; an `updated` one only when a
 * named or stored field changed), and inserts one queued run per trigger with `{ collection, ids }` (`rows` for
 * `deleted`); the collection is what lets one automation hold several triggers and tell them apart.
 */
export function queueTriggered(
	m: EngineManifest,
	c: Chain,
	now: string,
	actor: string,
	source = 'allp'
): void {
	const at = Date.parse(now);
	const selects = triggersOf(m).events.map((t) => {
		const image = t.event === 'deleted' ? 'x.o' : 'x.n';
		const row = `jsonb_populate_record(${nullRowSql(t.collection, catalogOf(m).models.get(t.collection)?.fields.keys() ?? [])}, ${image})`;
		const changed =
			t.event !== 'updated'
				? 'true'
				: `(${(t.fields ?? storedFields(m, t.collection)).map((f) => `(x.o -> ${c.p(f)}) IS DISTINCT FROM (x.n -> ${c.p(f)})`).join(' OR ') || 'false'})`;
		// CASE, not AND: Postgres may evaluate the predicate first, and another collection's image (a named
		// integration slot's text id) does not cast to this row type
		const where =
			t.where === undefined
				? 'true'
				: `CASE WHEN x.c = ${c.p(t.collection)} THEN ${storeSync(ownPredSql(t.where, row, c))} ELSE false END`;
		const event = `'collection', ${c.p(t.collection)}::text`;
		const input =
			t.event === 'deleted'
				? `jsonb_build_object('ids', jsonb_agg(x.id), 'rows', jsonb_agg(x.o), ${event})`
				: `jsonb_build_object('ids', jsonb_agg(x.id), ${event})`;
		return `SELECT ${c.p(t.automation)}::text AS a, ${input} AS input, ${c.p(iso(dueAt(at, at + (t.delayMs ?? 0))))}::timestamptz AS due, ${c.p(t.event)}::text AS cause
		FROM ${source} x WHERE x.c = ${c.p(t.collection)} AND x.op = '${OP[t.event]}' AND ${changed} AND ${where} HAVING count(*) > 0`;
	});
	if (selects.length === 0) return;
	enqueue(c, {
		select: `SELECT t.a AS automation, t.input, t.due AS due_at, t.cause, 0 AS depth, ${c.p(actor)}::text AS actor
		FROM (${selects.join(' UNION ALL ')}) t`
	});
}
