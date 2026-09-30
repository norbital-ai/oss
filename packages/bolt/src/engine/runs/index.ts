/// <reference types="node" />
// The runs area (A8, rules 48–56, 70): the tick a deadline wakes, the run's bridge and journal, attempts, starts, the
// boot read, run visibility and the daily prune. Every queued run is a `sys_run` row with a `due_at` (queue.ts); the
// host's `deadlines` port wakes a scope once per due instant and nothing else asks the database anything.
import type { Json } from '../../decl/values.ts';
import type { Holder } from '../access/authority.ts';
import { durationMs } from '../access/pred.ts';
import type {
	Authority, Bindings, Captured, CrossAnswer, CrossCall, DeadlinesPort, EngineActor, GuestOutcome, GuestPort, Outcome, ReadIR
} from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import type { Engine } from '../index.ts';
import { offsetMs } from '../query/eval.ts';
import { pruneHistory } from '../query/history.ts';
import type { Verb } from '../write/act.ts';
import { actorRef } from '../write/commit.ts';
import { answer, canonical, Chain, GATED, hex, noticeCaptures, noticeInsert, sha256 } from '../write/sql.ts';
import { nextSlot } from './cron.ts';
import { BUCKET_MS, dueAt, iso, REPLACE_QUEUED, triggersOf, type NewRun } from './queue.ts';
import { deliverWebhook, type WebhookRequest, type WebhookResponse } from './webhook.ts';
import { authorDecide, authorEmbed, readableFile, storedFiles, type AuthorDecideConfig } from '../decisions/index.ts';
import { prepareSend, sendPiece } from '../channels/outbound.ts'; // hook:envoys
import { FILE_METHODS, runConvert, runFiles } from './files.ts';
import { INFER_MS, inferFacility, type InferTool } from '../agent/ai.ts';
import type { AgentConfig } from '../agent/index.ts';
import { connectionCall } from '../connections.ts';
import type { HttpPort } from '../integrations/runner.ts';

export type RunsConfig = {
	engine: Engine; deadlines: DeadlinesPort;
	/** The workspace environment this engine serves (one deadlines scope). */
	scope: string;
	/** Runs automation bodies; without it every run fails `noGuest`. */
	guest?: GuestPort;
	clock?: () => number;
	/** `ctx.http(connection)`: the declared connections, answered by the engine (§3.3.8). */
	http?: HttpPort;
	/** The automation-only facilities (`http`, `web`, `files`, `ai`, `geo`); absent → `unavailable`. */
	facility?: (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal) => Promise<CrossAnswer>;
	/** `ctx.ai.sys_1.decide` (P36: `sys_1`, the `decision.made` event and the meter) and `ctx.ai.embed` (P39: the engine reads its files). */
	decide?: AuthorDecideConfig;
	/** The host tools `ctx.ai.sys_2.infer({ tools })` may offer (the agent's, rule 58); absent → a named tool is `unavailable`. */
	hostTools?: AgentConfig['hostTools'];
	/** Webhook secrets by `EnvName`. */
	env?: (name: string) => string | undefined;
	/** Rule 70: the seed pack's `start` list, queued once on the environment's first admission. */
	start?: readonly string[];
	/** Platform runs by name (`collections.resume`, …, rule 48): their owners' handlers, run as the workspace's own work (`<c>.pipeline` as its starter). */
	platform?: { readonly [name: string]: (input: Json, run: { id: string; starter: Holder | null }) => Promise<Json> };
	/** `sys_event` retention in hours (§5.12; `BOLT_TELEMETRY_RETAIN_HOURS`), default 72. */
	eventRetainHours?: number;
};
export type RunHandle = { id: string; automation: string };
/** Rule 56: the full row for holders of `automations` for it, admins and a `'trigger'` run's starter; the causing actor sees less. */
export type RunView = { id: string; automation: string; cause: string; status: string; due_at: string; started: string | null;
	progress: Json; error: { code: string; message?: string } | null; attempt_count: number; result?: Json; input?: Json; attempts?: Json };
export type Runs = {
	/** Restart recovery and release install: one statement, then `settle` (rule 52a). */
	boot(): Promise<void>;
	/**
	 * One wake: claim every due run, run them, settle with the next due time. Workspace automations run one at a
	 * time, platform runs beside them, and the wake stays open while any runs: a run queued meanwhile and
	 * `nudge`d is claimed then, never behind a long run.
	 */
	tick(): Promise<void>;
	/** A run queued for `at` (an `agent.triage` decision): an open wake claims it when due. The host is announced separately. */
	nudge(at: string): void;
	view(authority: Authority, id: string): Promise<RunView | null>;
	/**
	 * Stops a queued or running run for a viewer who reads it in full (rule 56); `null` when there is none or no access.
	 * A queued run never starts; a running one fails its next crossing `stopped` and keeps the state.
	 */
	stop(authority: Authority, id: string): Promise<RunView | null>;
	webhook(path: string, request: WebhookRequest): Promise<WebhookResponse>;
};

type Row = { id: string; automation: string; input: Json; due_at: string; run_key: string | null; cause: string; depth: number;
	attempts: number; leases: number; actor: string | null; starter: Holder | null };
const EVENTS = new Set(['created', 'updated', 'deleted']);
const MAX_IDS = 10_000;
const TRANSIENT = new Set(['upstream', 'timeout', 'rateLimited', 'conflict']);
const DAY = 86_400_000;
/** Workspace automations one wake runs at once; platform runs (`agent.triage`, deliveries) never wait for a lane. */
// One: two automations on the same event read and write the same rows, and side by side the second loses its write to
// a revision conflict an author never sees in sequence. ponytail: a long automation delays the tenant's next ones
// (never platform runs); lane by the rows a run touches if that matters.
const LANES = 1;
/** The platform run a capped prune queues to continue (rule 25a). */
export const PRUNE = 'bolt.prune';

/** Rule 54: only `Transient` retries — a facility `upstream`/`timeout`/`rateLimited` or an act `conflict` left uncaught. */
export function transient(g: GuestOutcome): boolean {
	if (g.kind !== 'failed') return false;
	if (TRANSIENT.has(g.error.code)) return true;
	if (g.error.code !== 'guestError') return false;
	try {
		const thrown = JSON.parse(g.error.message) as { kind?: unknown };
		return TRANSIENT.has(String(thrown.kind));
	} catch {
		return false;
	}
}
const todayIn = (ms: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const fail = (code: string, message: string): CrossAnswer => ({ ok: false, error: { kind: 'bolt', code, message } });
const unavailable = (facility: string): CrossAnswer => ({ ok: false, error: { kind: 'unavailable', facility, reason: `the host provides no ${facility}` } });
/** Rule 55: facility calls that effect something are journalled; the rest are reads. */
const effecting = (c: Extract<CrossCall, { op: 'facility' }>): boolean => c.facility === 'ai'
	|| (c.facility === 'http' && c.method !== 'get')
	|| c.facility === 'convert'
	|| (c.facility === 'files' && (c.method === 'put' || (c.method === 'image' && JSON.stringify(c.args).includes('"jpeg"'))));

export function runs(cfg: RunsConfig): Runs {
	const { engine: e, deadlines, scope } = cfg;
	const m = e.manifest, db = e.db;
	const clock = cfg.clock ?? Date.now;
	let prunedDay = -1;
	/** Runs this process stopped while they run: their next crossing answers `stopped`. */
	const stopping = new Set<string>();
	/** The open wake's `nudge` (`tick`); nothing between wakes. */
	let nudged: ((at: number) => void) | undefined;
	/** A run this area queued: the host's wake and, while one is open, this wake's. */
	const announce = (at: string): void => { deadlines.announce(scope, at); nudged?.(Date.parse(at)); };

	const insertRuns = (c: Chain, name: string, rows: readonly NewRun[], conflict: string) =>
		c.cte(name, `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth, actor, starter)
		SELECT v.id, v.automation, v.input, v.due, v.key, v.cause, v.depth, v.actor, v.starter FROM jsonb_to_recordset(${c.p(rows as unknown as Json)}::jsonb)
		AS v(id text, automation text, input jsonb, due timestamptz, key text, cause text, depth int, actor text, starter jsonb) ${conflict} RETURNING id, due_at`);

	const settleFrom = (...dues: readonly (string | number | null | undefined)[]): void => {
		const ms = dues.flatMap((d) => d === null || d === undefined ? [] : [typeof d === 'number' ? d : Date.parse(d)]);
		deadlines.settle(scope, ms.length === 0 ? null : iso(Math.min(...ms)));
	};

	// ── boot (rule 52a restart recovery; rule 54 lost leases; rule 52 cron slots; rule 70 first admission) ──
	async function boot(): Promise<void> {
		const now = clock(), c = new Chain();
		c.cte('lost', `UPDATE sys_run SET leases = leases + 1, due_at = ${c.p(iso(now))}::timestamptz,
			state = CASE WHEN leases < 3 THEN 'queued' ELSE 'failed' END,
			error = CASE WHEN leases < 3 THEN error ELSE '{"code":"lostLease","message":"The run lost its lease 3 times."}'::jsonb END
		WHERE state = 'running' RETURNING id, state, due_at`);
		const crons = triggersOf(m).crons;
		c.cte('gone', `DELETE FROM sys_run WHERE state = 'queued' AND cause = 'cron'
			AND NOT (jsonb_build_array(automation, key) IN (SELECT e.value FROM jsonb_array_elements(${c.p(crons.map((t) => [t.automation, t.key]))}::jsonb) e)) RETURNING id`);
		insertRuns(c, 'slots', crons.map((t) => ({ id: crypto.randomUUID(), automation: t.automation, input: {}, due: iso(slotDue(t, now)), key: t.key,
			cause: 'cron', depth: 0, actor: null, starter: null })), `WHERE NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = v.automation
			AND (r.key = v.key OR (r.run_key = v.key AND r.state = 'running'))) ON CONFLICT (key) DO NOTHING`);
		const start = cfg.start ?? [];
		if (start.length > 0) {
			c.cte('admitted', `INSERT INTO bolt_run_admitted (at) SELECT ${c.p(iso(now))}::timestamptz WHERE NOT EXISTS (SELECT 1 FROM bolt_run_admitted) RETURNING at`);
			c.cte('started', `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT gen_random_uuid()::text, a, '{}'::jsonb, x.at, 'start', 0
			FROM admitted x, jsonb_array_elements_text(${c.p(start)}::jsonb) a RETURNING due_at`);
		}
		const [row] = (await db.write(c.sql(`least((SELECT min(due_at) FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM gone)),
			(SELECT min(due_at) FROM slots), (SELECT min(due_at) FROM lost WHERE state = 'queued')${start.length > 0 ? ', (SELECT min(due_at) FROM started)' : ''})::text AS next`))).rows;
		settleFrom(row?.['next'] as string | null);
	}

	/** A cron slot's due time: bucketed when its period is 5 minutes or more (rule 52a). */
	function slotDue(t: ReturnType<typeof triggersOf>['crons'][number], after: number): number {
		const slot = nextSlot(t.cron, after, t.tz);
		return t.bucket ? Math.ceil(slot / BUCKET_MS) * BUCKET_MS : slot;
	}

	/** Claims the due runs whose automation is not running (rule 51); `next` is the earliest queued run left. */
	async function claim(now: number): Promise<{ claimed: Row[]; next: string | null }> {
		const c = new Chain();
		// a workspace run's key moves to `run_key` when it starts (rule 51: a started run is never replaced); platform runs keep theirs
		c.cte('claimed', `UPDATE sys_run s SET state = 'running', attempts = s.attempts + 1, started_at = ${c.p(iso(now))}::timestamptz,
			run_key = coalesce(s.key, s.run_key), key = CASE WHEN s.automation IN (SELECT jsonb_array_elements_text(${c.p(Object.keys(m.automations))}::jsonb)) THEN NULL ELSE s.key END
		WHERE s.id IN (SELECT r.id FROM sys_run r WHERE r.state = 'queued' AND r.due_at <= ${c.p(iso(now))}::timestamptz
			AND NOT EXISTS (SELECT 1 FROM sys_run x WHERE x.automation = r.automation AND x.state = 'running')
			ORDER BY r.due_at LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING s.*`);
		const [res] = (await db.write(c.sql(`(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_at, x.id), '[]'::jsonb) FROM claimed x) AS runs,
			(SELECT min(due_at)::text FROM sys_run WHERE state = 'queued' AND id NOT IN (SELECT id FROM claimed)) AS next`))).rows;
		return { claimed: res!['runs'] as unknown as Row[], next: res!['next'] as string | null };
	}

	// ── the tick ──
	async function tick(): Promise<void> {
		const now = clock();
		const first = await claim(now);
		let next = first.next;
		const dues: number[] = [];
		// the daily prune rides this wake (rule 56): never a wake of its own
		if (Math.floor(now / DAY) !== prunedDay) {
			prunedDay = Math.floor(now / DAY);
			// no run to fail here: a pass without progress is a telemetry event, and nothing is re-queued
			const pass = await prune(now).catch(async (err: unknown) => {
				if (!(err instanceof BoltError && err.code === 'noProgress')) throw err;
				await db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, 'warn', 'prune.noProgress', $2, $3::jsonb)`,
					params: [iso(now), PRUNE, { code: err.code, message: err.message }] });
				return null;
			});
			if (pass?.continued !== undefined) dues.push(pass.continued);
		}
		// one lane per automation, its batches in order; lanes run side by side, and a lane that throws fails the wake at its end
		const inflight = new Set<Promise<void>>(), thrown: unknown[] = [];
		const track = (p: Promise<void>): void => { const q = p.catch((err: unknown) => { thrown.push(err); }).finally(() => inflight.delete(q)); inflight.add(q); };
		let free = LANES;
		const waiting: (() => void)[] = [];
		const start = (claimed: readonly Row[]): void => {
			for (const [automation, groups] of Map.groupBy(batches(claimed), (g) => g[0]!.automation)) {
				const platform = m.automations[automation] === undefined;
				track((async () => {
					if (!platform) { if (free > 0) free--; else await new Promise<void>((r) => waiting.push(r)); }
					try {
						for (const g of groups) dues.push(...await execute(g));
					} finally {
						if (!platform) { const w = waiting.shift(); if (w === undefined) free++; else w(); }
					}
				})());
			}
		};
		// a run nudged while lanes run is claimed at its due time, not after the longest lane
		let timer: ReturnType<typeof setTimeout> | undefined, wakeAt = Infinity;
		nudged = (at) => {
			if (at >= wakeAt) return;
			clearTimeout(timer);
			wakeAt = at;
			timer = setTimeout(() => {
				wakeAt = Infinity;
				track(claim(clock()).then((r) => { next = r.next; start(r.claimed); }));
			}, Math.max(0, at - clock()));
		};
		try {
			start(first.claimed);
			while (inflight.size > 0) await Promise.all([...inflight]);
		} finally {
			nudged = undefined;
			clearTimeout(timer);
		}
		if (thrown.length > 0) throw thrown[0];
		settleFrom(next, ...dues);
	}

	/** Rule 50: event runs of one automation claimed together merge into one invocation (`ids ∪`, ≤ 10,000 ids each). */
	function batches(rows: readonly Row[]): Row[][] {
		const out: Row[][] = [];
		for (const [, rs] of Map.groupBy(rows, (r) => `${r.automation}\u0000${EVENTS.has(r.cause) ? 'event' : r.id}`)) {
			let batch: Row[] = [], n = 0;
			for (const r of rs) {
				const size = ((r.input as { ids?: readonly Json[] }).ids ?? []).length;
				if (batch.length > 0 && n + size > MAX_IDS) { out.push(batch); batch = []; n = 0; }
				batch.push(r);
				n += size;
			}
			out.push(batch);
		}
		return out;
	}

	/**
	 * One prune pass (rule 56), at most 10,000 rows per table (rule 25a): a pass that selected rows and deleted none stops
	 * `noProgress`; a table at its cap queues one `bolt.prune` continuation run, due now. Rows are picked by `ctid`.
	 */
	async function prune(now: number): Promise<{ deleted: number; continued?: number }> {
		const aged = {
			sys_run: `state IN ('succeeded', 'failed', 'stopped', 'skipped') AND finished_at < $1::timestamptz - interval '90 days'`,
			// a pruned run's journal goes with it, in this pass or (past the cap) as an orphan in a later one
			bolt_idem: `(run IS NOT NULL AND (run IN (SELECT id FROM sel_sys_run) OR NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.id = bolt_idem.run)))
				OR (run IS NULL AND issued_at < $1::timestamptz - interval '24 hours')`,
			sys_event: `at < $1::timestamptz - make_interval(hours => $2::int)`,
			bolt_rate: `window_start < $1::timestamptz - interval '1 day'`,
			sys_notification: `(read_at < $1::timestamptz - interval '90 days') OR at < $1::timestamptz - interval '365 days'`, // L-BOLT-354
			bolt_host_nonce: `at < $1::timestamptz - CASE WHEN key LIKE 'nonce:%' THEN interval '10 minutes' ELSE interval '30 days' END`,
		};
		const tables = Object.keys(aged);
		const ctes = Object.entries(aged).map(([t, where]) => `sel_${t} AS (SELECT ctid${t === 'sys_run' ? ', id' : ''} FROM ${t} WHERE ${where} LIMIT ${MAX_IDS}),
			del_${t} AS (DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM sel_${t}) RETURNING 1)`);
		const counts = tables.map((t) => `(SELECT count(*) FROM sel_${t})::int AS "sel_${t}", (SELECT count(*) FROM del_${t})::int AS "del_${t}"`);
		const [r] = (await db.write({ text: `WITH ${ctes.join(',\n')} SELECT ${counts.join(', ')}`, params: [iso(now), cfg.eventRetainHours ?? 72] })).rows;
		const selected = tables.reduce((n, t) => n + Number(r![`sel_${t}`]), 0), deleted = tables.reduce((n, t) => n + Number(r![`del_${t}`]), 0);
		// the history horizon (rule 17, L-BOLT-182): 256 revisions per row, never an open restore point or an erased revision
		// ponytail: uncapped by rule 25a's 10,000; cap it with a ctid select if a backlog ever makes this pass long
		const pruned = await pruneHistory(db);
		if (selected > 0 && deleted === 0) throw new BoltError('noProgress', 'commit', `bolt.prune: a pass selected ${selected} rows and deleted 0; it stops (rule 25a)`);
		if (!tables.some((t) => Number(r![`sel_${t}`]) >= MAX_IDS)) return { deleted: deleted + pruned };
		await db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) SELECT $1, $2, '{}'::jsonb, $3::timestamptz, 'continue', 0
			WHERE NOT EXISTS (SELECT 1 FROM sys_run WHERE automation = $2 AND state = 'queued')`, params: [crypto.randomUUID(), PRUNE, iso(now)] });
		return { deleted: deleted + pruned, continued: now };
	}

	/** Runs one batch to its end; returns the due times it queued (retries, schedules, the next cron slot). */
	async function execute(rows: readonly Row[]): Promise<number[]> {
		const head = rows[0]!, spec = m.automations[head.automation], now = clock();
		const dues: number[] = [], warnings: string[] = [];
		const input: Json = EVENTS.has(head.cause) ? {
			...(head.input as object),
			ids: rows.flatMap((r) => (r.input as { ids?: Json[] }).ids ?? []),
			...(head.cause === 'deleted' ? { rows: rows.flatMap((r) => (r.input as { rows?: Json[] }).rows ?? []) } : {}),
		} : head.input;
		let outcome: GuestOutcome;
		let holder: Holder | undefined;
		const handler = head.automation === PRUNE ? async () => (await prune(now)) as unknown as Json : cfg.platform?.[head.automation];
		if (spec === undefined && handler !== undefined) outcome = await handler(input, head).then((output): GuestOutcome => ({ kind: 'ok', output, cpuMs: 0 }),
			(err: unknown): GuestOutcome => ({ kind: 'failed', error: err instanceof BoltError ? err : new BoltError('internal', 'guest', String(err)), cpuMs: 0 }));
		else if (spec === undefined) outcome = { kind: 'failed', error: new BoltError('unknownAutomation', 'admission', `no automation '${head.automation}'`), cpuMs: 0 };
		else if (cfg.guest === undefined) outcome = { kind: 'failed', error: new BoltError('noGuest', 'guest', 'this host runs no guest code'), cpuMs: 0 };
		else {
			holder = spec.runAs === 'trigger' ? head.starter ?? undefined
				: { actor: { kind: 'system', run: head.id, by: { automation: head.automation } }, policies: spec.runAs, admin: false };
			if (holder === undefined) outcome = { kind: 'failed', error: new BoltError('noTrigger', 'admission', 'the run has no starter'), cpuMs: 0 };
			else outcome = await invoke(head, rows.map((r) => r.id), holder, masked(input, holder), dues, warnings);
		}

		// rule 71a: an interrupted run keeps its lease row `running` with the reason; the next boot re-queues it as a lost
		// lease (rule 54) and it resumes from its journal. On a discarded generation nothing reads the row again.
		if (outcome.kind === 'failed' && outcome.error.code === 'interrupted') {
			await db.write({ text: `UPDATE sys_run SET error = $2::jsonb WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				params: [rows.map((r) => r.id), { code: 'interrupted', message: outcome.error.message }] });
			return dues;
		}
		for (const r of rows) stopping.delete(r.id);
		// attempts (rule 54): only Transient retries, by re-queueing the same row; its journal carries over
		const attempts = spec?.retry?.attempts ?? 1;
		const retry = transient(outcome) && head.attempts < attempts;
		const at = clock();
		const backoff = Math.min(durationMs(spec?.retry?.backoff ?? '10s') * 2 ** (head.attempts - 1), 3_600_000) * (0.5 + Math.random());
		const state = retry ? 'queued' : outcome.kind === 'ok' ? 'succeeded' : 'failed';
		const error = outcome.kind === 'ok' ? null : outcome.kind === 'refused' ? { code: 'refused', message: outcome.message }
			: { code: outcome.error.code, message: outcome.error.message };
		const result = { attempt: head.attempts, at: iso(at), state, ...(outcome.kind === 'ok' ? { output: outcome.output } : { error }),
			...(warnings.length === 0 ? {} : { warnings }),
			...(head.cause === 'cron' && now - Date.parse(head.due_at) > 60_000 ? { missed: true } : {}) };
		const due = retry ? dueAt(at, at + backoff) : null;
		if (due !== null) dues.push(due);

		const c = new Chain();
		c.cte('done', `UPDATE sys_run s SET state = ${c.p(state)}, output = ${c.p(outcome.kind === 'ok' ? JSON.stringify(outcome.output) : null)}::jsonb,
			error = ${c.p(error)}::jsonb, finished_at = ${state === 'queued' ? 'NULL' : `${c.p(iso(at))}::timestamptz`},
			due_at = coalesce(${c.p(due === null ? null : iso(due))}::timestamptz, s.due_at), results = s.results || jsonb_build_array(${c.p(result)}::jsonb)
		WHERE s.id IN (SELECT jsonb_array_elements_text(${c.p(rows.map((r) => r.id))}::jsonb)) AND s.state <> 'stopped' RETURNING s.id`);
		// the cron chain continues when the slot's run is over (rule 52: missed slots after downtime fire once)
		const cron = head.cause === 'cron' && !retry ? triggersOf(m).crons.find((t) => t.automation === head.automation && t.key === head.run_key) : undefined;
		if (cron !== undefined) {
			const next = slotDue(cron, at);
			dues.push(next);
			insertRuns(c, 'slot', [{ id: crypto.randomUUID(), automation: cron.automation, input: {}, due: iso(next), key: cron.key, cause: 'cron', depth: 0,
				actor: null, starter: null }], `ON CONFLICT (key) DO NOTHING`);
		}
		await db.write(c.sql(`(SELECT count(*) FROM done)::int AS n`));
		return dues;
	}

	/** Rule 50: a `deleted` run's `rows` are masked to its `runAs` read grant. ponytail: field-level (the union of read arms). */
	function masked(input: Json, holder: Holder): Json {
		const rows = (input as { rows?: readonly { [f: string]: Json }[] } | null)?.rows;
		if (rows === undefined || holder.admin) return input;
		const auth = e.authority(holder);
		const collection = triggersOf(m).events.find((t) => t.event === 'deleted')?.collection;
		const arms = collection === undefined ? [] : auth.collections[collection]?.read ?? [];
		const all = arms.some((a) => a.fields === 'all');
		const keep = new Set(['id', 'revision', ...arms.flatMap((a) => a.fields === 'all' ? [] : a.fields)]);
		return { ...(input as object), rows: arms.length === 0 ? [] : all ? rows : rows.map((r) => Object.fromEntries(Object.entries(r).filter(([f]) => keep.has(f)))) };
	}

	// ── one invocation and its bridge (rule 55: each effect its own journalled statement) ──
	async function invoke(run: Row, ids: readonly string[], holder: Holder, input: Json, dues: number[], warnings: string[]): Promise<GuestOutcome> {
		const now = clock(), tz = m.workspace.tz;
		const b: Bindings = { now: iso(now), today: todayIn(now, tz), tz, params: {} };
		const authority = e.authority(holder);
		const replaying = run.attempts > 1 || run.leases > 0;
		const journal = new Map<string, Json>();
		if (replaying) {
			const [rows] = await db.read([{ text: `SELECT i.key, o.outcome FROM bolt_idem i JOIN bolt_idem_outcome o USING (key) WHERE i.run = $1`, params: [run.id] }]);
			for (const r of rows!.rows) journal.set(String(r['key']), r['outcome']!);
		}
		/** hook:runner — a journal hit consumes its entry (rule 12). */
		const hit = (key: string): Json => { const v = journal.get(key)!; journal.delete(key); return v; };
		const seen = new Map<string, number>();
		const keyOf = async (kind: string, target: string, args: Json): Promise<{ key: string; digest: string }> => {
			const digest = hex(await sha256(canonical([kind, target, args])));
			const k = seen.get(digest) ?? 0;
			seen.set(digest, k + 1);
			return { key: `${run.id}:${digest}:${k}`, digest };
		};
		/** An effect's gate row, its pieces and its outcome in one statement; a closed gate answers the recorded outcome. */
		const journalled = async (key: string, digest: string, pieces: (c: Chain) => void, outcome: (c: Chain) => string): Promise<Json> => {
			const c = new Chain();
			c.cte('idem', `INSERT INTO bolt_idem (key, digest, issued_at, run) VALUES (${c.p(key)}, ${c.p(digest)}, ${c.p(b.now)}::timestamptz, ${c.p(run.id)})
			ON CONFLICT (key) DO NOTHING RETURNING key`);
			pieces(c);
			const [row] = (await db.write(c.sql(`${answer(c, key, digest, outcome(c))}, ${noticeCaptures(c)} AS notices`))).rows;
			e.live.publish(row!['notices'] as unknown as Captured[]); // L-BOLT-354: the inbox is a live read
			return row!['outcome']!;
		};

		const readable = async (id: string, field: string) => field.includes('.') ? readableFile({ manifest: m, db, read: e.read, authority, bindings: b }, id, field)
			: authority.admin || field === run.automation || authority.automations.includes(field);
		const fileFacility = e.files && runFiles({ manifest: m, db, files: e.files, automation: run.automation, now: b.now, readable });
		const convertFacility = e.files && e.convert && runConvert({ manifest: m, db, files: e.files, convert: e.convert, now: b.now, readable });
		/**
		 * `sys_2.infer` with `tools` (rule 58, L-BOLT-372): the engine runs the loop, offering only host tools the run's
		 * `runAs` policies name (`capabilities.tools`) and the host binds; any other name is `unavailable` at call time.
		 */
		const inferWithTools = async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal): Promise<CrossAnswer> => {
			const names = [...new Set((call.args[0] as { tools: unknown[] }).tools.map(String))];
			const hosted = cfg.hostTools === undefined ? [] : typeof cfg.hostTools === 'function' ? await cfg.hostTools(authority, run.id) : cfg.hostTools;
			const missing = names.find((n) => !(authority.admin || authority.capabilities.tools.includes(n)) || !hosted.some((t) => t.name === n));
			if (missing !== undefined) return { ok: false, error: { kind: 'unavailable', facility: `tool ${missing}`, reason: `'${missing}' is not a host tool this run's policies name` } };
			const tools: InferTool[] = hosted.filter((t) => names.includes(t.name)).map((t) => ({ name: t.name, description: t.description, input: t.input,
				// ponytail: an image a tool attaches is dropped; route it into the next step's files when a research body needs screenshots
				call: (input, s) => t.call(input, { actor: authority.actor, conversation: run.id, turn: run.id, callId: crypto.randomUUID(), attach: () => {} }, s) }));
			const rows = await storedFiles(db, (call.args[0] as { files?: Json }).files ?? null);
			const load = async (id: string, s: AbortSignal) => {
				const f = rows.get(id);
				if (f === undefined || cfg.decide?.files === undefined || !await readableFile({ manifest: m, db, read: e.read, authority, bindings: b }, id, f.field))
					throw new BoltError('invalid', 'guest', `this run cannot read file ${id}`);
				return { mime: f.mime, bytes: await cfg.decide.files.get(f.key, LIMITS.storedFileBytes, s) };
			};
			return inferFacility(cfg.decide?.ai, { load })(call, signal, tools);
		};
		/** The host's facility; `files` reads and puts the host does not answer are the engine's (files.ts). */
		const facility = async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal): Promise<CrossAnswer> => {
			// conversion is the engine's over the host's optional port: it reads a reference file and stores its output
			if (call.facility === 'convert') return convertFacility === undefined ? unavailable('convert')
				: convertFacility(call, signal).catch((err: unknown): CrossAnswer => ({ ok: false, error: { kind: 'upstream', message: err instanceof Error ? err.message : String(err) } }));
			if (call.facility === 'http' && cfg.http !== undefined) return connectionCall(cfg.http, call, signal, holder.actor.kind === 'member' ? holder.actor.id : undefined);
			if (call.facility === 'ai' && call.method === 'sys_2.infer' && ((call.args[0] as { tools?: unknown } | null)?.tools as unknown[] | undefined)?.length) return inferWithTools(call, signal);
			// the wall is the engine's: a host call that ignores its signal (a stalled stream) still ends at it (rule 72)
			const host = cfg.facility === undefined ? unavailable(call.facility) : await new Promise<CrossAnswer>((resolve, reject) => {
				const stop = () => resolve({ ok: false, error: { kind: 'timeout', message: `${call.facility}.${call.method} did not answer in time` } });
				if (signal.aborted) return stop();
				signal.addEventListener('abort', stop, { once: true });
				cfg.facility!(call, signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
			});
			if (fileFacility === undefined || call.facility !== 'files' || !FILE_METHODS.has(call.method) || host.ok || host.error.kind !== 'unavailable') return host;
			return fileFacility(call, signal).catch((err: unknown): CrossAnswer => ({ ok: false, error: { kind: 'upstream', message: err instanceof Error ? err.message : String(err) } }));
		};

		/** Each facility call ends by its own wall or the crossing's (rule 72), or when the generation drains (rule 71a). */
		const effect = async (call: Exact, signal: AbortSignal): Promise<CrossAnswer> => {
			switch (call.op) {
				case 'progress': { // L-BOLT-336: not journalled (a replay reports again); the answer carries a stop recorded by any process
					const p = call.progress as { ratio?: unknown; text?: unknown } | null;
					const ratio = p?.ratio ?? null, text = p?.text ?? null;
					if ((ratio !== null && (typeof ratio !== 'number' || !(ratio >= 0 && ratio <= 1))) || (text !== null && typeof text !== 'string'))
						return fail('invalidInput', 'progress takes { ratio?: 0..1, text?: string }');
					const [r] = (await db.write({ text: `UPDATE sys_run SET progress = CASE WHEN state = 'running' THEN $2::jsonb ELSE progress END
						WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) RETURNING state`,
					params: [ids as unknown as Json, { ratio, text: text === null ? null : text.slice(0, 500) }] })).rows;
					if (r?.['state'] === 'stopped') { stopping.add(run.id); return fail('stopped', 'The run was stopped.'); }
					return { ok: true, value: null };
				}
				case 'act': {
					const dot = call.callable.lastIndexOf('.'), verb = call.callable.slice(dot + 1);
					const { key } = await keyOf('act', call.callable, call.input);
					const k = call.options?.once === undefined ? key : `once:${call.options.once}`;
					// hook:callables — X-24: a collection action is one act (its recorded writes one statement), keyed like any act
					if (!['create', 'update', 'delete', 'upsert'].includes(verb)) {
						const r = await e.calls.action({ collection: call.callable.slice(0, dot), action: verb, input: call.input, key: k, issuedAt: b.now,
							retry: replaying, authority, bindings: b, invocationId: k, from: 'server' });
						return { ok: true, value: r.outcome as Json };
					}
					const r = await e.act({ collection: call.callable.slice(0, dot), verb: verb as Verb, input: call.input, key: k, issuedAt: b.now,
						retry: replaying, authority, bindings: b, invocationId: k,
						...(call.options?.onConflict === undefined ? {} : { onConflict: call.options.onConflict }) }); // hook:ctx-types (rule 28)
					return { ok: true, value: r.outcome as Json };
				}
				case 'schedule': {
					const target = m.automations[call.automation];
					if (target === undefined) return fail('invalidInput', `no automation '${call.automation}'`);
					const self = call.automation === run.automation;
					if (self && call.at === undefined && canonical(call.input) === canonical(run.input))
						return fail('hotLoop', 'A run cannot schedule itself at once with the same input.');
					const depth = self ? run.depth : run.depth + 1;
					if (depth > LIMITS.writeDepth) return fail('depth', `Runs chain at most ${LIMITS.writeDepth} deep.`);
					const at = call.at === undefined ? now : typeof call.at === 'string' ? Date.parse(call.at) : now + offsetMs(call.at.now);
					if (Number.isNaN(at)) return fail('invalidInput', 'schedule: `at` is not an instant');
					const { key, digest } = await keyOf('schedule', call.automation, [call.input, call.at ?? null, call.key ?? null]);
					if (journal.has(key)) return { ok: true, value: hit(key), journal: true }; // hook:runner
					const due = iso(dueAt(now, at));
					const runKey = call.key === undefined ? null : target.runAs === 'trigger' ? `${actorRef(holder.actor)}:${call.key}` : call.key;
					const value = await journalled(key, digest, (c) => insertRuns(c, 'q', [{ id: crypto.randomUUID(), automation: call.automation, input: call.input,
						due, key: runKey, cause: 'schedule', depth, actor: actorRef(holder.actor), starter: target.runAs === 'trigger' ? holder as unknown as Json : null }],
					`WHERE ${GATED} ${REPLACE_QUEUED}`),
					(c) => `jsonb_build_object('id', (SELECT id FROM q), 'automation', ${c.p(call.automation)}::text)`);
					dues.push(Date.parse(due));
					announce(due);
					return { ok: true, value };
				}
				case 'notify': {
					const notices = (Array.isArray(call.notices) ? call.notices : [call.notices]) as { to: Json; title: Json; body?: Json; link?: Json; once?: string }[];
					// L-BOLT-340: a notice that names no recipient has nowhere to go
					if (notices.some((n) => n.to === null || n.to === undefined || (Array.isArray(n.to) && n.to.length === 0))) return fail('invalidInput', 'notify: a notice names at least one recipient');
					const { key, digest } = await keyOf('notify', '', call.notices);
					// rule 21: an inbox notice that reaches no member is never refused; it is reported in the attempt's `warnings`
					const report = (recorded: Json) => {
						for (const title of (recorded as { unaddressed?: string[] } | null)?.unaddressed ?? []) warnings.push(`notify: '${title}' reached no member`);
					};
					if (journal.has(key)) { report(hit(key)); return { ok: true, value: null, journal: true }; } // hook:runner
					const rows = notices.map((n) => ({ id: crypto.randomUUID(), to: n.to, title: typeof n.title === 'string' ? n.title : JSON.stringify(n.title),
						body: n.body === undefined ? null : typeof n.body === 'string' ? n.body : JSON.stringify(n.body), link: n.link ?? null, once: n.once ?? null }));
					report(await journalled(key, digest, (c) => noticeInsert(c, 'n', rows, b.now, m.teams),
						() => `jsonb_build_object('unaddressed', (SELECT coalesce(jsonb_agg(title), '[]'::jsonb) FROM n_to
							WHERE member IS NULL AND coalesce("to"->>'channel', 'inbox') = 'inbox'))`));
					return { ok: true, value: null };
				}
				case 'send': { // hook:envoys — `ctx.send` (rule 61): one queued outbound row and its delivery run, journalled
					const prepared = await prepareSend(m, db, call.channel, call.message);
					if ('error' in prepared) return fail('invalidInput', prepared.error);
					const { key, digest } = await keyOf('send', call.channel, call.message);
					if (journal.has(key)) return { ok: true, value: hit(key), journal: true }; // hook:runner
					const value = await journalled(key, digest, (c) => { sendPiece(c, { ...prepared, id: crypto.randomUUID() }, b.now, true); }, () => 'to_jsonb((SELECT id FROM sent))');
					announce(b.now);
					return { ok: true, value };
				}
				case 'facility': {
					if (call.facility === 'ai' && call.method === 'sys_1.decide') {
						// read-like (P36): journalled by content hash plus ordinal; the state is text only (P37 (3))
						const { key, digest } = await keyOf('ai.sys_1.decide', '', [call.args[0] ?? null]);
						if (journal.has(key)) return { ...hit(key) as unknown as CrossAnswer, journal: true }; // hook:runner
						const got = cfg.decide === undefined ? unavailable('ai') : await authorDecide(cfg.decide, call.args[0] ?? null, { id: run.id, automation: run.automation });
						// only an answer is recorded: a failed call is asked again on the retry, as a read would be
						if (got.ok) await journalled(key, digest, () => {}, (c) => `${c.p(got as unknown as Json)}::jsonb`);
						return got;
					}
					if (call.facility === 'ai' && call.method === 'embed') {
						// read-like (P39): a file input hashes as its content digest; it never enters the guest (the engine reads it)
						const files = await storedFiles(db, call.args[0] ?? null);
						const digests = [...files.entries()].map(([id, f]) => [id, f.sha256]).sort() as Json;
						const { key, digest } = await keyOf('ai.embed', '', [...call.args, digests]);
						if (journal.has(key)) return { ...hit(key) as unknown as CrossAnswer, journal: true }; // hook:runner
						const got = cfg.decide === undefined ? unavailable('ai') : await authorEmbed(cfg.decide, call.args,
							(id, field) => readableFile({ manifest: m, db, read: e.read, authority, bindings: b }, id, field));
						if (got.ok) await journalled(key, digest, () => {}, (c) => `${c.p(got as unknown as Json)}::jsonb`);
						return got;
					}
					if (!effecting(call)) return facility(call, AbortSignal.any([signal, AbortSignal.timeout(LIMITS.callMs.other)]));
					const { key, digest } = await keyOf(`${call.facility}.${call.method}`, '', call.args);
					if (journal.has(key)) return { ...hit(key) as unknown as CrossAnswer, journal: true }; // hook:runner
					const got = await facility(call, AbortSignal.any([signal, AbortSignal.timeout(call.facility === 'ai' && call.method === 'sys_2.infer' ? INFER_MS : LIMITS.callMs.database)]));
					// bytes are not journalled: a replay of a byte-returning effect answers its JSON only
					const recorded: CrossAnswer = got.ok ? { ok: true, value: got.value } : got;
					await journalled(key, digest, () => {}, (c) => `${c.p(recorded as unknown as Json)}::jsonb`);
					return got;
				}
			}
		};
		type Exact = Exclude<CrossCall, { op: 'read' }>;

		const invocation = {
			id: `${run.id}:${run.attempts}`, kind: 'automation' as const, target: run.automation, input,
			ctx: { actor: holder.actor as EngineActor, now: b.now, today: b.today, tz, seed: run.id },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.automation, readBytes: LIMITS.readBytes },
		};
		return cfg.guest!.invoke(invocation, {
			async cross(calls, signal) {
				const reads = calls.flatMap((x) => x.op === 'read' ? [x.read as ReadIR] : []);
				let answered: readonly CrossAnswer[] = [];
				if (reads.length > 0) {
					try {
						answered = (await e.read(reads, { as: 'caller', authority }, b)).map((value): CrossAnswer => ({ ok: true, value }));
					} catch (err) {
						answered = reads.map(() => fail(err instanceof BoltError ? err.code : 'internal', err instanceof Error ? err.message : String(err)));
					}
				}
				let i = 0;
				const out: CrossAnswer[] = [];
				for (const call of calls) {
					if (call.op === 'read') { out.push(answered[i++]!); continue; }
					if (stopping.has(run.id)) { out.push(fail('stopped', 'The run was stopped.')); continue; }
					try {
						out.push(await effect(call, signal));
					} catch (err) {
						out.push(fail(err instanceof BoltError ? err.code : 'internal', err instanceof Error ? err.message : String(err)));
					}
				}
				return out;
			},
		});
	}

	// ── visibility, webhooks (`$bolt.start` is the callables area's `start`) ──
	async function view(auth: Authority, id: string): Promise<RunView | null> {
		const [rows] = await db.read([{ text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`, params: [id] }]);
		const r = rows!.rows[0];
		return r === undefined ? null : runView(auth, r);
	}

	async function stop(auth: Authority, id: string): Promise<RunView | null> {
		const [rows] = await db.read([{ text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`, params: [id] }]);
		const r = rows!.rows[0];
		if (r === undefined || !('input' in (runView(auth, r) ?? {}))) return null;
		// ponytail: a stopped run no longer holds its automation's one running slot, so a queued successor may start while
		// its body winds down to its next crossing
		const [done] = (await db.write({ text: `UPDATE sys_run SET state = 'stopped', key = NULL, finished_at = $2::timestamptz,
			error = jsonb_build_object('code', 'stopped', 'message', 'The run was stopped.') WHERE id = $1 AND state IN ('queued', 'running')
			RETURNING ${RUN_VIEW_COLUMNS}`, params: [id, iso(clock())] })).rows;
		if (done !== undefined && r['state'] === 'running') stopping.add(id);
		return runView(auth, done ?? r);
	}

	return {
		boot, tick, view, stop,
		nudge: (at) => nudged?.(Date.parse(at)),
		webhook: (path, request) => deliverWebhook({ manifest: m, db, env: cfg.env ?? (() => undefined), now: clock,
			queued: (due) => deadlines.announce(scope, due) }, path, request),
	};
}

/** hook:packaging-ui — rule 56's projection of one `sys_run` row (read with `RUN_VIEW_COLUMNS`), shared by `/runs`' list. */
export const RUN_VIEW_COLUMNS = `id, automation, cause, state, due_at::text AS due_at, started_at::text AS started, progress, output, error,
	attempts, results, input, actor, starter`;
export function runView(auth: Authority, r: { readonly [c: string]: Json }): RunView | null {
	const starter = (r['starter'] as { actor?: EngineActor } | null)?.actor;
	const full = auth.admin || auth.automations.includes(String(r['automation']))
		|| (starter !== undefined && JSON.stringify(starter) === JSON.stringify(auth.actor));
	const error = r['error'] as { code: string; message: string } | null;
	const base = { id: String(r['id']), automation: String(r['automation']), cause: String(r['cause']), status: String(r['state']),
		due_at: String(r['due_at']), started: r['started'] as string | null, progress: r['progress'] ?? null, attempt_count: Number(r['attempts']) };
	if (full) return { ...base, error, ...(r['output'] === null ? {} : { result: r['output']! }), input: r['input']!, attempts: r['results']! };
	if (r['actor'] === actorRef(auth.actor)) return { ...base, error: error === null ? null : { code: error.code } };
	return null;
}

export { announceTriggered, queueTriggered } from './queue.ts';
export { inProcessDeadlines } from './scheduler.ts';

