// Collection queries and actions, and run starts (rules 31, 33, 33a, 38d, 51): each reachable only by policy. A query is
// a `/q` read: one guest invocation reading as its caller, nothing recorded. An action is one act: its body runs in one
// invocation per target (reads as its caller), every `ctx.act` it makes passes the generated-verb pipeline as the caller
// and is recorded, not written (`sink`), and the recorded writes, `ctx.schedule` runs and `ctx.notify` rows commit in the
// action's one statement under its idempotency key; a refusal after guest code is the outcome record (rule 20). `start`
// is one `sys_run` insert keyed by the client-minted run id.
import type { Json } from '../../decl/values.ts';
import {
	BoltError, LIMITS, type Authority, type Bindings, type Bridge, type Captured, type CrossAnswer, type CrossCall, type DeadlinesPort,
	type EngineActor, type EngineManifest, type GuestPort, type Invocation, type NoticeRow, type Outcome, type ReadIR, type RowData
} from '../contracts.ts';
import { catalogOf, durationMs } from '../access/pred.ts';
import type { Engine } from '../index.ts';
import * as ir from '../../protocol/ir.ts';
import { constraintIndex } from '../schema/ddl.ts';
import { schemaSlice } from '../schema/plan.ts';
import type { ActRequest, Verb } from '../write/act.ts';
import { actorId, actorRef, compileCommit, compileOutcomeRecord, type Commit, type RateCharge } from '../write/commit.ts';
import { canonical, decided, hex, KEY_REUSE, minter, sha256, storedOutcome } from '../write/sql.ts';
import { decodeInput, type Decoded, type InputSpec } from './decode.ts';

export type CallablesConfig = {
	/** The engine's own runner (its console, metering and generation scope; one prepared-isolate pool per program). */
	engine: Engine; guest?: GuestPort;
	/** Rule 52a: a statement that queues a run announces its `due_at` first. */
	deadlines?: DeadlinesPort; scope?: string;
};
/** Rule 33a: `server` is `ctx.act`/`ctx.query` from server code; everything else (`/act`, `/q`, `$bolt`, HTTP, agent) is `client`. */
export type Entry = 'client' | 'server';
type Caller = { authority: Authority; bindings: Bindings; invocationId: string; from: Entry };
export type QueryRequest = Caller & { collection: string; query: string; input: Json };
export type ActionRequest = Caller & { collection: string; action: string; input: Json; key: string; issuedAt: string; retry?: boolean;
	rate?: readonly RateCharge[] };
export type StartRequest = { automation: string; input: Json; id: string; authority: Authority; bindings: Bindings };
/** An action's answer; `error` is the cause behind an `unknown` outcome (a guest throw or budget, rule 72a). */
export type CallResult = { outcome: Outcome; captured: readonly Captured[]; error?: BoltError };
export type Callables = {
	query(r: QueryRequest): Promise<Json>;
	action(r: ActionRequest): Promise<CallResult>;
	start(r: StartRequest): Promise<Outcome>;
};

type Refused = Extract<Outcome, { kind: 'refused' }>;
type Planned = Parameters<NonNullable<ActRequest['sink']>>[0];
/** What one action act has recorded so far; nested `ctx.act` actions record into their caller's. */
type Recorder = { commits: Planned[]; runs: Commit['runs'][number][]; notices: (NoticeRow & { id: string })[];
	refusals: Map<string, Outcome>; issuedAt: string;
	/** Rows created by earlier `ctx.act` calls of this act, readable as refs by later ones (keyed `collection␀id`). */
	pending: Map<string, RowData> };
type Performed = { output: Json } | { outcome: Outcome; guest: boolean } | { error: BoltError };

const refused = (code: Refused['code'], message: string, field?: string): Refused => ({ kind: 'refused', code, message, ...(field === undefined ? {} : { field }) });
const HOUR = 3_600_000, BUCKET = 5 * 60_000;
const VERBS: readonly string[] = ['create', 'update', 'delete', 'upsert'];
const fail = (code: string, message: string): CrossAnswer => ({ ok: false, error: { kind: 'bolt', code, message } });
const failed = (e: unknown): CrossAnswer => fail(e instanceof BoltError ? e.code : 'internal', e instanceof Error ? e.message : String(e));
const problems = (d: Decoded) => d.problems.map((p) => `${p.path}: ${p.message}`).join('; ');
/** The `Holder` a `'trigger'` run is recompiled from (`sys_run.starter`, read by the runs area). */
const starterOf = (a: Authority): Json => ({ actor: a.actor, policies: a.policies, admin: a.admin, teamTree: a.teamTree, scopes: a.scopes }) as unknown as Json;
const split = (callable: string) => { const dot = callable.lastIndexOf('.'); return [callable.slice(0, dot), callable.slice(dot + 1)] as const; };

/** Rules 33, 33a, 38d: a declared callable, reachable by this caller from this entry. */
function reach(m: EngineManifest, auth: Authority, c: string, part: 'queries' | 'actions', name: string, from: Entry): Refused | null {
	const spec = m.collections[c]?.[part]?.[name] as { internal?: true } | undefined;
	if (spec === undefined) throw new BoltError('unknownCallable', 'decode', `'${c}.${name}' is not a declared ${part === 'queries' ? 'query' : 'action'}`);
	if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not call this.');
	if (spec.internal === true && from === 'client') return refused('forbidden', `'${c}.${name}' is callable only from server code.`);
	return auth.admin || (auth.collections[c]?.[part] ?? []).includes(name) ? null : refused('forbidden', `You may not call '${c}.${name}'.`);
}

/** Rule 52a: a `due_at` 5 minutes or more ahead rounds up to a 5-minute bucket; anything sooner is exact. */
export function dueAt(now: string, at?: Json): string {
	const t = Date.parse(now);
	const due = at === undefined || at === null ? t : typeof at === 'string' ? Date.parse(at) : t + signed((at as { now: string }).now);
	if (Number.isNaN(due)) throw new BoltError('invalidInput', 'decode', 'at is not an instant');
	return new Date(due - t >= BUCKET ? Math.ceil(due / BUCKET) * BUCKET : due).toISOString();
}
const signed = (offset: string) => offset === '' ? 0 : (offset.startsWith('-') ? -1 : 1) * durationMs(offset.replace(/^[+-]/, ''));

export function callables(config: CallablesConfig): Callables {
	const e = config.engine, m = e.manifest, cat = catalogOf(m);
	const guest = config.guest;
	const constraints = constraintIndex(schemaSlice(m));

	/** Rule 36: every ref the input names must be readable by the caller, before any guest code. */
	async function unreadable(refs: Decoded['refs'], c: Caller): Promise<Refused | null> {
		if (refs.length === 0) return null;
		let rows: readonly Json[];
		try {
			rows = await e.read(refs.map((r) => ir.get(cat, r.collection, r.id, {})), { as: 'caller', authority: c.authority }, c.bindings);
		} catch {
			rows = refs.map(() => null);
		}
		const i = rows.findIndex((r) => r === null);
		return i < 0 ? null : refused('notFound', `No readable ${refs[i]!.collection} has this id.`, refs[i]!.field);
	}

	async function invoke(kind: 'query' | 'action', target: string, input: Json, c: Caller, id: string, rec: Recorder | null, row?: Json) {
		if (guest === undefined) throw new BoltError('noGuest', 'guest', 'this host runs no guest code');
		const inv: Invocation = { id, kind, target, input,
			ctx: { actor: c.authority.actor, now: c.bindings.now, today: c.bindings.today, tz: c.bindings.tz, seed: id,
				...(row === undefined ? {} : { row: row as never }) },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes } };
		return guest.invoke(inv, bridge(c, id, rec));
	}

	/** Reads as the caller (rule 15), one round trip per crossing; inside an action, `act`/`schedule`/`notify` are recorded. */
	function bridge(c: Caller, id: string, rec: Recorder | null): Bridge {
		let n = 0;
		return {
			async cross(calls) {
				const reads = calls.flatMap((x) => x.op === 'read' && x.read.kind !== 'query' ? [x.read] : []);
				let answers: CrossAnswer[] = [];
				try {
					answers = (await e.read(reads, { as: 'caller', authority: c.authority }, c.bindings)).map((value): CrossAnswer => ({ ok: true, value }));
				} catch (err) {
					answers = reads.map(() => failed(err));
				}
				let i = 0;
				const out: CrossAnswer[] = [];
				for (const x of calls) out.push(x.op === 'read' && x.read.kind !== 'query' ? answers[i++]! : await one(x, `${id}/${n++}`));
				return out;
			},
		};
		async function one(x: CrossCall, sub: string): Promise<CrossAnswer> {
			try {
				if (x.op === 'read') {
					const q = x.read as Extract<ReadIR, { kind: 'query' }>;
					return { ok: true, value: await query({ ...c, from: 'server', invocationId: sub, collection: q.collection, query: q.query, input: q.input }) };
				}
				if (rec === null || x.op === 'send' || x.op === 'facility' || x.op === 'progress') // hook:runtime (progress)
					return fail('unsupported', `a collection ${rec === null ? 'query' : 'action'} cannot ${x.op === 'facility' ? `call ${x.facility}` : x.op}; queue an automation (rule 31)`);
				if (x.op === 'act') return { ok: true, value: await recordAct(x.callable, x.input, { ...c, from: 'server', invocationId: sub }, rec, x.options?.onConflict) };
				if (x.op === 'notify') {
					const mint = await minter(sub, c.bindings.now);
					for (const notice of [x.notices].flat() as NoticeRow[]) rec.notices.push({ ...notice, id: mint() });
					return { ok: true, value: null };
				}
				return await schedule(x, c, sub, rec);
			} catch (err) {
				return failed(err);
			}
		}
	}

	/** `ctx.schedule` inside an action: a queued-run piece of the act's statement (rule 49), started as the caller (rule 33). */
	async function schedule(x: Extract<CrossCall, { op: 'schedule' }>, c: Caller, sub: string, rec: Recorder): Promise<CrossAnswer> {
		const no = startable(x.automation, c.authority, x.input);
		if (no !== null) {
			rec.refusals.set(no.message, no);
			return { ok: false, error: { kind: 'refused', code: no.code, message: no.message } };
		}
		const spec = m.automations[x.automation];
		const key = x.key === undefined ? undefined : spec?.runAs === 'trigger' ? `${actorRef(c.authority.actor)}\u0000${x.key}` : x.key;
		const id = (await minter(sub, c.bindings.now))();
		rec.runs.push({ id, automation: x.automation, input: x.input, dueAt: dueAt(c.bindings.now, x.at as Json), cause: 'schedule', depth: 0,
			actor: actorRef(c.authority.actor), ...(spec?.runAs === 'trigger' ? { starter: starterOf(c.authority) } : {}), ...(key === undefined ? {} : { key }) });
		return { ok: true, value: { id, automation: x.automation } };
	}

	/** Rule 33: a start or schedule needs the automation in `policy.automations`; its input decodes (rule 23). */
	function startable(name: string, auth: Authority, input: Json): Refused | null {
		const [c, v] = split(name);
		const feed = v === 'pipeline' ? m.pipelines?.[c] as { import?: unknown; export?: unknown } | undefined : undefined;
		const spec = v === 'integration' && m.integrations[c] !== undefined ? { input: { mode: { kind: 'enum', values: ['pull', 'push', 'reconcile'] } } }
			: feed !== undefined ? { input: { mode: { kind: 'enum', values: [...feed.import === undefined ? [] : ['import'], ...feed.export === undefined ? [] : ['export']] },
				file: { kind: 'text', optional: true } } } : m.automations[name];
		if (spec === undefined) return refused('notFound', `'${name}' is not an automation.`);
		if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not start runs.');
		// a pipeline is gated by the caller's grants on its collection (§3.3.5: its rows enter as the caller); the act judges each row again
		if (feed !== undefined) {
			const g = auth.collections[c], mode = (input as { mode?: Json } | null)?.mode;
			if (!auth.admin && (mode === 'export' ? (g?.read.length ?? 0) === 0 : (g?.create.length ?? 0) === 0)) return refused('forbidden', `You may not ${String(mode)} ${c}.`);
		} else if (!auth.admin && !auth.automations.includes(name)) return refused('forbidden', `You may not start '${name}'.`);
		const d = decodeInput(spec.input as InputSpec | undefined, input);
		return d.problems.length > 0 ? refused('invalidInput', problems(d), d.problems[0]!.path) : null;
	}

	/** One `ctx.act` inside an action: a generated verb through the act pipeline with `sink`, or a nested action. */
	async function recordAct(callable: string, input: Json, c: Caller, rec: Recorder, onConflict?: 'update' | 'keep'): Promise<Outcome> {
		const [collection, verb] = split(callable);
		let outcome: Outcome;
		if (VERBS.includes(verb)) {
			outcome = (await e.act({ collection, verb: verb as Verb, input, key: `${c.invocationId}`, issuedAt: rec.issuedAt, authority: c.authority,
				bindings: c.bindings, invocationId: c.invocationId, pending: rec.pending, ...(onConflict === undefined ? {} : { onConflict }), sink: (p) => {
					rec.commits.push(p);
					for (const w of p.commit.writes) if (w.op === 'create')
						rec.pending.set(`${w.collection}\u0000${w.id}`, { ...w.values, id: w.id, revision: 1, approval_id: null, created_by: actorId(c.authority.actor) });
				} })).outcome;
		} else {
			const p = await perform({ ...c, collection, action: verb, input, key: c.invocationId, issuedAt: rec.issuedAt }, rec);
			if ('error' in p) throw p.error;
			outcome = 'output' in p ? { kind: 'committed', output: p.output, records: [] } : p.outcome;
		}
		if (outcome.kind === 'refused') rec.refusals.set(outcome.message, outcome);
		return outcome;
	}

	/** The body of one action, once per target, recording into `rec`; `guest` says whether a refusal came after guest code. */
	async function perform(r: ActionRequest, rec: Recorder): Promise<Performed> {
		const no = reach(m, r.authority, r.collection, 'actions', r.action, r.from);
		if (no !== null) return { outcome: no, guest: false };
		const spec = m.collections[r.collection]!.actions![r.action]!;
		const record = spec.target === 'record';
		const arg = (record ? (r.input as { input?: Json } | null)?.input : r.input) ?? null;
		const d = decodeInput(spec.input as InputSpec, arg);
		if (d.problems.length > 0) return { outcome: refused('invalidInput', problems(d), d.problems[0]!.path), guest: false };
		const bad = await unreadable(d.refs, r);
		if (bad !== null) return { outcome: bad, guest: false };
		const target = record ? (r.input as { target?: Json } | null)?.target : undefined;
		const ids = record ? [target].flat() : [undefined];
		let rows: readonly Json[] = [];
		if (record) {
			if (ids.length === 0 || ids.some((id) => typeof id !== 'string')) return { outcome: refused('invalidInput', 'target: expected an id or a list of ids', 'target'), guest: false };
			rows = await e.read(ids.map((id) => ir.get(cat, r.collection, id as string, {})), { as: 'caller', authority: r.authority }, r.bindings)
				.catch(() => ids.map(() => null));
			if (rows.includes(null)) return { outcome: refused('notFound', 'The record does not exist.', 'target'), guest: false };
		}
		const outputs: Json[] = [];
		for (const [i] of ids.entries()) {
			const g = await invoke('action', `${r.collection}.${r.action}`, arg, r, ids.length > 1 ? `${r.invocationId}/${i}` : r.invocationId, rec, rows[i]);
			if (g.kind === 'failed') return g.error.code === 'readBudgetExceeded' ? { outcome: refused('readBudgetExceeded', g.error.message), guest: true } : { error: g.error };
			if (g.kind === 'refused')
				return { outcome: rec.refusals.get(g.message) ?? { ...refused('refused', g.message, g.field), rule: `${r.collection}.${r.action}` }, guest: true };
			outputs.push(g.output);
		}
		return { output: record && Array.isArray(target) ? outputs : outputs[0] ?? null };
	}

	async function query(r: QueryRequest): Promise<Json> {
		const no = reach(m, r.authority, r.collection, 'queries', r.query, r.from);
		if (no !== null) throw new BoltError(no.code, 'admission', no.message);
		const spec = m.collections[r.collection]!.queries![r.query]!;
		const d = decodeInput(spec.input as InputSpec, r.input);
		if (d.problems.length > 0) throw new BoltError('invalidInput', 'decode', problems(d));
		const bad = await unreadable(d.refs, r);
		if (bad !== null) throw new BoltError('notFound', 'admission', `${bad.field}: ${bad.message}`);
		const g = await invoke('query', `${r.collection}.${r.query}`, r.input ?? {}, r, r.invocationId, null);
		if (g.kind === 'ok') return g.output;
		throw g.kind === 'failed' ? g.error : new BoltError('refused', 'guest', g.message);
	}

	async function action(r: ActionRequest): Promise<CallResult> {
		const none = (outcome: Outcome, error?: BoltError): CallResult => ({ outcome, captured: [], ...(error === undefined ? {} : { error }) });
		const age = Date.parse(r.bindings.now) - Date.parse(r.issuedAt);
		if (!(age <= 23 * HOUR && age >= -5 * 60_000)) return none(refused('invalidInput', 'The request expired; send it again.'));
		const callable = `${r.collection}.${r.action}`, actor = r.authority.actor;
		const key = hex(await sha256(`${canonical({ actor: actor.kind === 'member' ? actor.id : actor, callable })}\u0000${r.key}`));
		const digest = hex(await sha256(canonical({ callable, input: r.input })));
		const stored = async (): Promise<Outcome | null> =>
			((await e.db.read([{ text: `SELECT ${storedOutcome('$1', '$2')} AS outcome`, params: [key, digest] }]))[0]!.rows[0]?.['outcome'] ?? null) as Outcome | null;
		if (r.retry) { const o = await stored(); if (o !== null) return none(o); }
		const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
		const record = async (outcome: Outcome): Promise<CallResult> =>
			none(((await e.db.write(compileOutcomeRecord(common, outcome as Json))).rows[0]?.['outcome'] as Outcome | null) ?? outcome);

		// rule 26: a serialization failure replays the body once with the same clock and minted ids
		for (let attempt = 0; ; attempt++) {
			const rec: Recorder = { commits: [], runs: [], notices: [], refusals: new Map(), issuedAt: r.issuedAt, pending: new Map() };
			const p = await perform(r, rec);
			if ('error' in p) return none({ kind: 'unknown', invocation: r.invocationId }, p.error);
			if ('outcome' in p) return p.guest ? record(p.outcome) : none(p.outcome);
			const writes = rec.commits.flatMap((x) => x.commit.writes);
			const seen = new Set<string>();
			const twice = writes.find((w) => seen.size === seen.add(`${w.collection}\u0000${w.id}`).size);
			if (twice !== undefined) return record(refused('invalidInput', `The action writes ${twice.collection} ${twice.id} twice; one act writes a row once (rule 21).`));
			const approvals = rec.commits.flatMap((x) => x.commit.approval === undefined ? [] : [x.commit.approval]);
			// ponytail: one approval route per action act; a second needs the approval area to merge requests
			if (approvals.length > 1) throw new BoltError('unsupported', 'admission', 'an action routes at most one write to approval');
			const tables = [...new Set(rec.commits.flatMap((x) => x.lock?.tables ?? []))].sort();
			const commit: Commit = { ...common, now: r.bindings.now, today: r.bindings.today, actor, writes, owned: rec.commits.flatMap((x) => x.commit.owned),
				runs: rec.runs, notices: [...rec.notices, ...rec.commits.flatMap((x) => x.commit.notices)], outbox: [], output: p.output, ...(approvals[0] === undefined ? {} : { approval: approvals[0] }) };
			const first = rec.runs.map((x) => x.dueAt).sort()[0];
			if (first !== undefined) config.deadlines?.announce(config.scope ?? '', first);
			try {
				const row = (await e.db.write(compileCommit(m, cat, commit), tables.length > 0 ? { tables, mode: 'SHARE ROW EXCLUSIVE' } : undefined)).rows[0]!;
				return { outcome: (row['outcome'] as Outcome | null) ?? await stored() ?? refused('refused', 'The outcome was lost.'), captured: row['captured'] as unknown as Captured[] };
			} catch (err) {
				const d = decided(err, constraints);
				if (d.replay && attempt === 0) continue;
				return d.record ? record(d.outcome) : none(d.outcome);
			}
		}
	}

	async function start(r: StartRequest): Promise<Outcome> {
		const no = startable(r.automation, r.authority, r.input);
		if (no !== null) return no;
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.id)) return refused('invalidInput', 'A run id is a client-minted uuid.', 'id');
		const due = dueAt(r.bindings.now);
		config.deadlines?.announce(config.scope ?? '', due);
		// the run row is the idempotency record (rule 31): the same id with the same automation and input is the same run
		// a `'trigger'` run records its starter: the run acts with the starter's authority (rule 53)
		// so does `<c>.pipeline`, which acts as its caller (§3.3.5)
		const [pc, pv] = split(r.automation);
		const starter = m.automations[r.automation]?.runAs === 'trigger' || (pv === 'pipeline' && m.pipelines?.[pc] !== undefined) ? JSON.stringify(starterOf(r.authority)) : null;
		const [row] = (await e.db.write({ text: `WITH ins AS (INSERT INTO sys_run (id, automation, input, due_at, cause, depth, actor, starter)
			VALUES ($1, $2, $3::jsonb, $4::timestamptz, 'start', 0, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id)
			SELECT EXISTS (SELECT 1 FROM ins) AS created, (SELECT automation = $2 AND input = $3::jsonb FROM sys_run WHERE id = $1) AS same`,
		params: [r.id, r.automation, JSON.stringify(r.input ?? {}), due, actorRef(r.authority.actor), starter] })).rows;
		return row!['created'] === true || row!['same'] === true ? { kind: 'committed', output: { id: r.id, automation: r.automation }, records: [] } : KEY_REUSE;
	}

	return { query, action, start };
}

// ── visitors (rule 38d, §3.9) and what an outcome may say to whom (rule 32) ──

/** The surfaces a visitor request may reach (rule 38d (a)): `read`/`get` of granted reads and generated `create` only. */
export type Surface = { read: string } | { act: string; verb: string } | { other: string };
export function admitVisitor(auth: Authority, s: Surface): Refused | null {
	if (auth.actor.kind !== 'visitor') return null;
	const ok = 'read' in s ? (auth.collections[s.read]?.read.length ?? 0) > 0
		: 'act' in s ? s.verb === 'create' && (auth.collections[s.act]?.create.length ?? 0) > 0 : false;
	return ok ? null : refused('forbidden', 'Visitors may not do this.');
}
/**
 * Rule 32: only `ctx.refuse` and mapped constraint messages reach members; public and API-key actors receive codes
 * only. Rule 38d (d): a visitor gets codes and messages, and a held create no request id.
 */
export function forActor(o: Outcome, actor: EngineActor): Outcome {
	if (o.kind === 'refused' && (actor.kind === 'envoy' || actor.kind === 'apiKey')) return { kind: 'refused', code: o.code, message: o.code };
	if (o.kind === 'pendingApproval' && actor.kind === 'visitor') return { kind: 'pendingApproval', records: o.records } as unknown as Outcome;
	return o;
}
