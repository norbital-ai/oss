// The one queue (rules 48–52a): `sys_run` rows with a `due_at`. Event-triggered runs are a piece of the causing act's
// statement, their `where` evaluated there once; a due time 5 minutes or more ahead is rounded up to a 5-minute bucket.
import type { Json } from '../../decl/values.ts';
import type { Bindings, Captured, EngineManifest, Pred, RowData } from '../contracts.ts';
import { catalogOf, durationMs, holds3, toPred } from '../access/pred.ts';
import { q, SYSTEM_COLUMNS } from '../../protocol/catalog.ts';
import { ownPredSql, type Chain } from '../write/sql.ts';
import { parseCron, periodAtLeast5Min, type Cron } from './cron.ts';

/**
 * Rule 51: the same key replaces the queued run's input and `due_at`. ponytail: `key` is unique across automations (the
 * write area's constraint); a key reused by another automation's queued run is left alone, never overwritten.
 */
export const REPLACE_QUEUED = `ON CONFLICT (key) DO UPDATE SET input = excluded.input, due_at = excluded.due_at
	WHERE sys_run.automation = excluded.automation AND sys_run.state = 'queued' AND sys_run.attempts = 0`;

export const BUCKET_MS = 300_000;
/** Rule 52a: exact when less than 5 minutes ahead, else rounded up to the 5-minute bucket. */
export const dueAt = (now: number, at: number): number => at - now < BUCKET_MS ? at : Math.ceil(at / BUCKET_MS) * BUCKET_MS;
export const iso = (ms: number): string => new Date(ms).toISOString();

type Data = { readonly [k: string]: unknown };
export type EventTrigger = { automation: string; event: 'created' | 'updated' | 'deleted'; collection: string;
	where?: Pred; fields?: readonly string[]; delayMs?: number };
export type CronTrigger = { automation: string; key: string; cron: Cron; tz: string; bucket: boolean };
export type WebhookTrigger = { automation: string; path: string; scheme: string; secret: string };
export type Triggers = { events: readonly EventTrigger[]; crons: readonly CronTrigger[]; webhooks: readonly WebhookTrigger[] };

const cache = new WeakMap<EngineManifest, Triggers>();
/** Every declared trigger, compiled once per manifest (`where` → Pred, cron parsed). */
export function triggersOf(m: EngineManifest): Triggers {
	let t = cache.get(m);
	if (t !== undefined) return t;
	const events: EventTrigger[] = [], crons: CronTrigger[] = [], webhooks: WebhookTrigger[] = [];
	for (const [automation, spec] of Object.entries(m.automations)) {
		const on = spec.on === undefined ? [] : Array.isArray(spec.on) ? spec.on as readonly Data[] : [spec.on as Data];
		for (const x of on) {
			if (typeof x['cron'] === 'string') {
				const cron = parseCron(x['cron']), tz = typeof x['tz'] === 'string' ? x['tz'] : m.workspace.tz;
				crons.push({ automation, key: `cron:${x['cron']}@${tz}`, cron, tz, bucket: periodAtLeast5Min(cron) });
				continue;
			}
			if (typeof x['webhook'] === 'string') {
				const v = x['verify'] as { scheme: string; secret: string };
				webhooks.push({ automation, path: x['webhook'], scheme: v.scheme, secret: v.secret });
				continue;
			}
			const event = (['created', 'updated', 'deleted'] as const).find((e) => typeof x[e] === 'string')!;
			const collection = x[event] as string;
			events.push({ automation, event, collection, ...(x['where'] === undefined ? {} : { where: toPred(m, collection, x['where']) }),
				...(Array.isArray(x['fields']) ? { fields: x['fields'] as string[] } : {}),
				...(typeof x['delay'] === 'string' ? { delayMs: durationMs(x['delay']) } : {}) });
		}
	}
	cache.set(m, t = { events, crons, webhooks });
	return t;
}

const OP = { created: 'create', updated: 'update', deleted: 'delete' } as const;
/** Fields whose change fires an `updated` trigger without `fields`: stored values, never roll-ups or computed (rule 50). */
function storedFields(m: EngineManifest, collection: string): readonly string[] {
	const model = catalogOf(m).models.get(collection)!;
	return [...[...model.fields.values()].filter((f) => !f.derived && !f.computed && !(SYSTEM_COLUMNS as readonly string[]).includes(f.name)).map((f) => f.column),
		...[...model.one.keys()].filter((k) => !model.fields.has(k))];
}

/**
 * Rule 49/50: the causing statement's piece. Reads the statement's own row changes (`allp`: `c, id, op, o, n`), keeps
 * those each trigger admits (its `where` on the post-image, the pre-image for `deleted`; an `updated` one only when a
 * named or stored field changed), and inserts one queued run per trigger with `{ ids }` (`rows` for `deleted`).
 */
export function queueTriggered(m: EngineManifest, c: Chain, now: string, actor: string): void {
	const at = Date.parse(now);
	const selects = triggersOf(m).events.map((t) => {
		const image = t.event === 'deleted' ? 'x.o' : 'x.n';
		const row = `jsonb_populate_record(null::${q(t.collection)}, ${image})`;
		const changed = t.event !== 'updated' ? 'true'
			: `(${(t.fields ?? storedFields(m, t.collection)).map((f) => `(x.o -> ${c.p(f)}) IS DISTINCT FROM (x.n -> ${c.p(f)})`).join(' OR ') || 'false'})`;
		const where = t.where === undefined ? 'true' : ownPredSql(t.where, row, c);
		const input = t.event === 'deleted' ? `jsonb_build_object('ids', jsonb_agg(x.id), 'rows', jsonb_agg(x.o))` : `jsonb_build_object('ids', jsonb_agg(x.id))`;
		return `SELECT ${c.p(t.automation)}::text AS a, ${input} AS input, ${c.p(iso(dueAt(at, at + (t.delayMs ?? 0))))}::timestamptz AS due, ${c.p(t.event)}::text AS cause
		FROM allp x WHERE x.c = ${c.p(t.collection)} AND x.op = '${OP[t.event]}' AND ${changed} AND ${where} HAVING count(*) > 0`;
	});
	if (selects.length === 0) return;
	c.cte('triggered', `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, actor)
	SELECT gen_random_uuid()::text, t.a, t.input, t.due, t.cause, 0, ${c.p(actor)} FROM (${selects.join(' UNION ALL ')}) t RETURNING id`);
}

/**
 * Rule 52a's announcement for runs an act queued: the earliest due time any captured change fires. The statement is the
 * authority; this judges `where` in JS only to avoid a spurious wake (a predicate JS cannot judge counts as a match).
 */
export function announceTriggered(m: EngineManifest, wake: (at: string) => void): (captured: readonly Captured[], b: Bindings) => void {
	return (captured, b) => {
		const at = Date.parse(b.now);
		let due: number | undefined;
		for (const t of triggersOf(m).events) {
			const hit = captured.some((x) => {
				if (x.collection !== t.collection || x.op !== OP[t.event]) return false;
				if (t.event === 'updated' && !(t.fields ?? storedFields(m, t.collection)).some((f) => JSON.stringify(x.old?.[f]) !== JSON.stringify(x.new?.[f]))) return false;
				const row = (t.event === 'deleted' ? x.old : x.new) as RowData;
				try {
					return t.where === undefined || holds3(t.where, row, { now: b.now, today: b.today, params: {}, actor: () => null }) === true;
				} catch {
					return true;
				}
			});
			if (hit) due = Math.min(due ?? Infinity, dueAt(at, at + (t.delayMs ?? 0)));
		}
		if (due !== undefined) wake(iso(due));
	};
}

/** A queued row as the runs area inserts it outside an act (schedule, start, webhook, cron, first admission). */
export type NewRun = { id: string; automation: string; input: Json; due: string; cause: string; depth: number; key: string | null;
	actor: string | null; starter: Json };
