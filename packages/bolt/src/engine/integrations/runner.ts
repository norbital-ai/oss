// The integration runner (§3.3.5, P14, rule 23): pulls, pushes and reconciles of `<c>.integration`. A pull maps remote
// records through `fields` (`in` bodies in the guest, `resolve` once per batch as the integration actor) and upserts
// them by `identity` in one act, admitted by the declaration; a two_way pull merges each field against the shadow
// first. A push sends what local writes owe through the connection and records the shadow, or the failure on the row.
import type { Json } from '../../decl/values.ts';
import type {
	Authority, Bindings, Bridge, CrossAnswer, EngineActor, GuestPort, Invocation, Outcome, RowData, TransportEvent, TransportPort
} from '../contracts.ts';
import { BoltError, callPort, LIMITS } from '../contracts.ts';
import type { Engine } from '../index.ts';
import { q } from '../../protocol/catalog.ts';
import type { Verb } from '../write/act.ts';
import { changed } from '../write/flatten.ts';
import { canonical, hex, sha256, untag } from '../write/sql.ts';
import { localChanges, merge, pausedIntegrations, pushFields, shadowPiece, type Conflict, type HttpSource, type IntegrationData } from './sync.ts';

/** The host's HTTP client for a declared connection: base URL and auth resolved host-side (§3.3.8). */
export type HttpRequest = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: { readonly [name: string]: string }; body?: Json;
	/** An idempotency key: a create retried after a lost answer must not create twice. */
	key?: string };
export interface HttpPort {
	/** `as.user`: the member a call is made for (a `per: 'user'` OAuth2 connection); none is a system actor. */
	request(connection: string, request: HttpRequest, signal: AbortSignal, as?: { user?: string }): Promise<{ status: number; body: Json }>;
}
/** `deliver`: one inbound channel message, queued by `subscribe` as the run's `message`. */
export type Mode = 'pull' | 'push' | 'reconcile' | 'deliver';
/** A run's result (the run's `result`): conflicts logged with their field, base, sides, rule and winner. */
export type SyncReport = { mode: Mode; pulled: number; pushed: number; pruned: number;
	/** An administrator paused the integration: the run did nothing (L-BOLT-365). */
	paused?: true;
	/** Rule 25a: the list cursor a continuation run resumes from, when this run reached `MAX_PAGES`. */
	continued?: string;
	conflicts: (Conflict & { remote_id: string })[]; failures: { record: string; error: string }[] };
export type IntegrationsConfig = {
	engine: Pick<Engine, 'manifest' | 'db' | 'act' | 'read' | 'authority'>;
	guest?: GuestPort; http?: HttpPort; now?: () => string;
	/** Rule 52a: a statement that queues a run announces its `due_at`. */
	announce?: (at: string) => void;
};
type Obj = { readonly [k: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const messageOf = (o: Outcome): string => o.kind === 'refused' ? o.message : o.kind;
/** Rule 25a: list pages per run; past it the run queues one continuation run carrying the cursor. */
export const MAX_PAGES = 1_000;

export function integrations(config: IntegrationsConfig) {
	const { manifest: m, db } = config.engine;
	const now = config.now ?? (() => new Date().toISOString());
	const specOf = (c: string): IntegrationData => {
		const s = m.integrations[c] as unknown as IntegrationData | undefined;
		if (s === undefined) throw new BoltError('unknownIntegration', 'decode', `'${c}' has no integration`);
		return s;
	};

	/** One run's actor, clock, bodies and acts. */
	function session(c: string, run: string, report: SyncReport) {
		const spec = specOf(c), at = now();
		const bindings: Bindings = { now: at, today: at.slice(0, 10), tz: m.workspace.tz, params: {} };
		const actor: EngineActor = { kind: 'system', run, by: { integration: c } };
		const authority: Authority = config.engine.authority({ actor, policies: spec.policies, admin: false }, `integration:${c}`);
		let n = 0;
		const body = mappingBody(config, authority, bindings, run);
		const allowlist = [...new Set([...Object.keys(spec.fields), spec.identity])];
		/** An act on this collection as the integration actor, admitted by the declaration (rule 23). */
		const act = async (verb: Verb, input: Json, shadow?: Parameters<typeof shadowPiece>[3]): Promise<Outcome> => {
			const key = `${run}:${n++}`;
			return (await config.engine.act({ collection: c, verb, input, key, issuedAt: at, authority, bindings, invocationId: key,
				...(verb === 'upsert' ? { onConflict: 'update' as const } : {}),
				integration: { fields: allowlist, identity: spec.identity, ...(shadow === undefined ? {} : { pieces: shadowPiece(c, spec.identity, run, shadow) }) } })).outcome;
		};
		const http = async (request: HttpRequest): Promise<Json | { error: string }> => {
			const src = spec.source as HttpSource;
			const r = await callPort('http', config.http, LIMITS.callMs.http, (p, signal) => p.request(src.connection, request, signal));
			if ('kind' in r) return { error: 'message' in r ? r.message : r.reason };
			return r.status >= 400 ? { error: `${request.method} ${request.path} answered ${r.status}` } : r.body;
		};
		const failed = (x: Json | { error: string }): x is { error: string } => isObj(x) && typeof x['error'] === 'string' && Object.keys(x).length === 1;
		return { c, spec, run, report, body, act, http, failed };
	}
	type Session = ReturnType<typeof session>;

	/** One batch of remote records → one act (plus its shadow on two_way); returns the remote ids it saw. */
	async function pull(s: Session, all: readonly Obj[]): Promise<readonly string[]> {
		const { c, spec } = s;
		// a channel message its sender revoked or recalled (`deleted`) takes its mirrored row with it: the source wins
		const recalled = 'channel' in spec.source ? all.filter((r) => r['deleted'] === true) : [];
		if (recalled.length > 0) await recall(s, recalled);
		const records = recalled.length === 0 ? all : all.filter((r) => r['deleted'] !== true);
		if (records.length === 0) return [];
		const resolved = spec.resolve === undefined ? null : await s.body(`integration.${c}.spec.resolve`, [{ $ctx: true }]);
		const byRemote = new Map<string, RowData>(), source = new Map<string, Obj>();
		for (const record of records) {
			const values: Record<string, Json> = {};
			for (const [f, how] of Object.entries(spec.fields))
				values[f] = typeof how === 'string' ? record[how] ?? null : await s.body(`integration.${c}.spec.fields.${f}.in`, [record, { resolve: resolved }]);
			const remote = values[spec.identity] ?? record['id'];
			if (remote === null || remote === undefined) { s.report.failures.push({ record: '', error: `a remote record has no ${spec.identity}` }); continue; }
			byRemote.set(String(remote), { ...values, [spec.identity]: String(remote) });
			source.set(String(remote), record);
		}
		if (byRemote.size === 0) return [];
		let rows = [...byRemote.values()], shadow: { remote: string; base: RowData; expect: number | null }[] | undefined;
		if (spec.direction === 'two_way') {
			const ids = JSON.stringify([...byRemote.keys()]);
			const [res, gone] = await db.read([{ text: `SELECT t.*, t.id::text AS id, s.base AS "$base" FROM ${q(c)} t
				LEFT JOIN bolt_sync s ON s.collection = $1 AND s.record = t.id::text
				WHERE t.${q(spec.identity)}::text IN (SELECT jsonb_array_elements_text($2::jsonb))`, params: [c, ids] },
			// a row deleted locally and not yet pushed: its record must not come back
			{ text: `SELECT s.remote FROM bolt_sync s WHERE s.collection = $1 AND s.remote IN (SELECT jsonb_array_elements_text($2::jsonb))
				AND NOT EXISTS (SELECT 1 FROM ${q(c)} t WHERE t.id::text = s.record)`, params: [c, ids] }]);
			const local = new Map(res!.rows.map((r) => [String(r[spec.identity]), r]));
			const deleted = new Set(gone!.rows.map((r) => String(r['remote'])));
			shadow = [];
			rows = [...byRemote].filter(([remote]) => !deleted.has(remote)).map(([remote, values]) => {
				const row = local.get(remote);
				if (row === undefined) { shadow!.push({ remote, base: values, expect: 1 }); return values; }
				const base = isObj(row['$base']) ? row['$base'] : undefined;
				const mg = merge(spec, base, row, values, { local: row['updated_at'] ?? null, remote: source.get(remote)!['updated_at'] ?? null });
				for (const x of mg.conflicts) s.report.conflicts.push({ ...x, remote_id: remote });
				const writes = Object.keys(changed(row, mg.write)).length > 0;
				shadow!.push({ remote, base: values, expect: mg.push ? null : Number(row['revision']) + (writes ? 1 : 0) });
				return { [spec.identity]: remote, ...mg.write };
			});
		}
		if (rows.length === 0) return [...byRemote.keys()];
		const o = await s.act('upsert', rows, shadow);
		if (o.kind === 'committed') s.report.pulled += rows.length;
		else s.report.failures.push({ record: '', error: messageOf(o) });
		return [...byRemote.keys()];
	}

	/** Deletes the rows mirroring recalled messages, found by `identity` (its mapped key, else the message id). */
	async function recall(s: Session, records: readonly Obj[]): Promise<void> {
		const { c, spec } = s, how = spec.fields[spec.identity];
		const remotes = records.map((r) => r[typeof how === 'string' ? how : 'id']).filter((x) => x !== null && x !== undefined).map(String);
		const [res] = await db.read([{ text: `SELECT id::text AS id FROM ${q(c)} WHERE ${q(spec.identity)}::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(remotes)] }]);
		if (res!.rows.length === 0) return;
		const o = await s.act('delete', res!.rows.map((r) => ({ target: r['id']! })));
		if (o.kind === 'committed') s.report.pruned += res!.rows.length;
		else s.report.failures.push({ record: '', error: messageOf(o) });
	}

	/** The remote list, page by page (`list.cursor` names the answer's next-cursor key and the query parameter). */
	async function* pages(s: Session, cursor: string | null): AsyncGenerator<readonly Obj[]> {
		const { list } = s.spec.source as HttpSource;
		const seen = new Set<string>();
		for (let page = 0; page < MAX_PAGES; page++) {
			const body = await s.http({ method: 'GET', path: list.path, ...(cursor === null || list.cursor === undefined ? {} : { query: { [list.cursor]: cursor } }) });
			if (s.failed(body)) throw new BoltError('upstream', 'facility', body.error);
			const records = list.records === undefined ? body : isObj(body) ? body[list.records] : undefined;
			if (!Array.isArray(records)) throw new BoltError('upstream', 'facility', `${list.path} answered no record list`);
			yield records.filter(isObj);
			const next = list.cursor !== undefined && isObj(body) ? body[list.cursor] : null;
			if (typeof next !== 'string' || next === '') return;
			// rule 25a: a source that answers a cursor it already gave would page forever
			if (seen.has(next)) throw new BoltError('noProgress', 'commit', `${list.path} answered cursor '${next}' again after ${page + 1} pages; the pull stops`);
			seen.add(next);
			cursor = next;
		}
		// the cap (rule 25a): one continuation run resumes at the cursor, never an in-process retry
		const at = now();
		await db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth) VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5, 'continue', 0)
			ON CONFLICT (key) DO NOTHING`, params: [crypto.randomUUID(), `${s.c}.integration`, { mode: s.report.mode, cursor }, at, `${s.c}.integration:continue:${cursor}`] });
		config.announce?.(at);
		s.report.continued = cursor!;
	}

	/** Every row a local write left owing its source: creates, changed fields, and deletes. */
	async function push(s: Session): Promise<void> {
		const { c, spec } = s;
		const src = spec.source as HttpSource;
		const [owed, gone] = await db.read([
			{ text: `SELECT t.*, t.id::text AS id, s.base AS "$base" FROM ${q(c)} t LEFT JOIN bolt_sync s ON s.collection = $1 AND s.record = t.id::text
				WHERE s.revision IS DISTINCT FROM t.revision ORDER BY t.id`, params: [c] },
			{ text: `SELECT s.record, s.remote FROM bolt_sync s WHERE s.collection = $1 AND NOT EXISTS (SELECT 1 FROM ${q(c)} t WHERE t.id::text = s.record)`, params: [c] },
		]);
		const fail = (record: string, error: string) => {
			s.report.failures.push({ record, error });
			return db.write({ text: `INSERT INTO bolt_sync (collection, record, status, error, run) VALUES ($1, $2, 'failed', $3, $4)
				ON CONFLICT (collection, record) DO UPDATE SET status = 'failed', error = excluded.error, run = excluded.run`, params: [c, record, error, s.run] });
		};
		const payload = async (row: RowData, fields: readonly string[]) => {
			const out: Record<string, Json> = {}, map = pushFields(spec);
			for (const f of fields) {
				const how = map[f]!;
				if (typeof how === 'string') out[how] = untag(row[f] ?? null);
				else out[f] = await s.body(`integration.${c}.spec.push.${f}.out`, [row]);
			}
			return out;
		};
		const path = (p: string, remote: string) => p.replaceAll('{id}', encodeURIComponent(remote));
		for (const row of owed!.rows) {
			const id = String(row['id']), remote = row[spec.identity], revision = Number(row['revision']);
			const base = isObj(row['$base']) ? row['$base'] : {};
			const fields = remote === null ? Object.keys(pushFields(spec)).filter((f) => !spec.owns?.remote?.includes(f)) : localChanges(spec, base, row);
			const sent = Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
			if (remote === null) {
				const r = await s.http({ method: 'POST', path: src.create!.path, body: await payload(row, fields), key: id });
				if (s.failed(r)) { await fail(id, r.error); continue; }
				const made = isObj(r) ? r['id'] : undefined;
				if (made === undefined || made === null) { await fail(id, `${src.create!.path} answered no id`); continue; }
				// the remote id lands on the row with its shadow; a local write in between conflicts, and the next push
				// re-sends the create under the same key
				const o = await s.act('update', { target: id, set: { [spec.identity]: String(made) } }, [{ remote: String(made), base: sent, expect: revision + 1 }]);
				if (o.kind !== 'committed') { await fail(id, messageOf(o)); continue; }
			} else if (fields.length > 0) {
				const r = await s.http({ method: 'PATCH', path: path(src.update!.path, String(remote)), body: await payload(row, fields) });
				if (s.failed(r)) { await fail(id, r.error); continue; }
			}
			if (remote !== null) await db.write({ text: `INSERT INTO bolt_sync (collection, record, remote, base, revision, run) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
				ON CONFLICT (collection, record) DO UPDATE SET remote = excluded.remote, base = bolt_sync.base || excluded.base, revision = excluded.revision,
					status = 'ok', error = NULL, run = excluded.run`, params: [c, id, String(remote), JSON.stringify(sent), revision, s.run] });
			s.report.pushed += fields.length > 0 ? 1 : 0;
		}
		for (const g of gone!.rows) {
			if (src.delete !== undefined && g['remote'] !== null) {
				const r = await s.http({ method: 'DELETE', path: path(src.delete.path, String(g['remote'])) });
				if (s.failed(r) && !r.error.endsWith(' 404')) { await fail(String(g['record']), r.error); continue; }
				s.report.pushed++;
			}
			await db.write({ text: 'DELETE FROM bolt_sync WHERE collection = $1 AND record = $2', params: [c, g['record']!] });
		}
	}

	/** Rows whose remote record is gone: deleted locally, unless a two_way row still owes a push. */
	async function prune(s: Session, remotes: ReadonlySet<string>): Promise<void> {
		const { c, spec } = s;
		const owedOk = spec.direction === 'one_way' ? 'true' : 's.revision = t.revision';
		const [res] = await db.read([{ text: `SELECT t.id::text AS id FROM ${q(c)} t LEFT JOIN bolt_sync s ON s.collection = $1 AND s.record = t.id::text
			WHERE t.${q(spec.identity)} IS NOT NULL AND t.${q(spec.identity)}::text NOT IN (SELECT jsonb_array_elements_text($2::jsonb)) AND ${owedOk}`,
		params: [c, JSON.stringify([...remotes])] }]);
		if (res!.rows.length === 0) return;
		const o = await s.act('delete', res!.rows.map((r) => ({ target: r['id']! })));
		if (o.kind === 'committed') s.report.pruned += res!.rows.length;
		else s.report.failures.push({ record: '', error: messageOf(o) });
	}

	/** One inbound message on a channel: a pull run for every integration sourced by it. */
	async function deliver(event: TransportEvent, run: string): Promise<SyncReport[]> {
		if (event.kind !== 'inbound' || !isObj(event.message)) return [];
		const out: SyncReport[] = [];
		for (const [c, spec] of Object.entries(m.integrations as unknown as { [c: string]: IntegrationData }))
			if ('channel' in spec.source && spec.source.channel === event.channel) {
				const report: SyncReport = { mode: 'pull', pulled: 0, pushed: 0, pruned: 0, conflicts: [], failures: [] };
				await pull(session(c, `${run}:${c}`, report), [event.message]);
				out.push(report);
			}
		return out;
	}

	/** A run of `<collection>.integration`. A channel source has nothing to list: its runs are deliveries. */
	async function run(collection: string, mode: Mode, run: string, message?: Json, cursor: string | null = null): Promise<SyncReport> {
		const report: SyncReport = { mode, pulled: 0, pushed: 0, pruned: 0, conflicts: [], failures: [] };
		const s = session(collection, run, report);
		if (mode === 'deliver') { if (isObj(message)) await pull(s, [message]); return report; }
		if ('channel' in s.spec.source) return report;
		if ((await pausedIntegrations(db)).has(collection)) return { ...report, paused: true };
		if (mode !== 'push') {
			const seen = new Set<string>();
			for await (const page of pages(s, cursor)) for (const id of await pull(s, page)) seen.add(id);
			// ponytail: a reconcile split across runs never saw the whole list, so it prunes nothing; a source past
			// MAX_PAGES needs the seen ids carried across runs before it can prune
			if (mode === 'reconcile' && cursor === null && report.continued === undefined) await prune(s, seen);
		}
		if (mode !== 'pull' && s.spec.direction === 'two_way') await push(s);
		return report;
	}

	return {
		deliver, run,
		/** The platform runs `<c>.integration` (input `{ mode }`), for the runs area's `platform` map (rule 48). */
		handlers(runId: () => string = () => crypto.randomUUID()): { [name: string]: (input: Json, invocation?: { id: string }) => Promise<Json> } {
			return Object.fromEntries(Object.keys(m.integrations).map((c) => [`${c}.integration`,
				async (input: Json, invocation?: { id: string }) => {
					const report = await run(c, (isObj(input) && typeof input['mode'] === 'string' ? input['mode'] : 'reconcile') as Mode, invocation?.id ?? runId(),
						isObj(input) ? input['message'] : undefined, isObj(input) && typeof input['cursor'] === 'string' ? input['cursor'] : null);
					if (isObj(input) && input['mode'] === 'deliver' && report.failures.length > 0)
						throw new BoltError(report.failures.some((f) => f.error === 'conflict') ? 'conflict' : 'invalidInput', 'admission', report.failures.map((f) => f.error).join('; '));
					return report as unknown as Json;
				}]));
		},
		/**
		 * Wires every transport's inbound stream; returns the unsubscribe. Each inbound message queues one `deliver` run of
		 * every integration its channel sources (rule 48), keyed by the message, so a redelivery is the same run; the sink
		 * resolves once the runs are queued, and a failed insert rejects it (the transport redelivers). ponytail: attachment
		 * bytes (`bins`) are not carried into the run; a mapping reads what the message itself holds.
		 */
		subscribe(transports: readonly TransportPort[], runId: () => string): () => void {
			const sources = Object.entries(m.integrations as unknown as { [c: string]: IntegrationData }).flatMap(([c, spec]) => 'channel' in spec.source ? [[c, spec.source.channel] as const] : []);
			const queue = async (e: TransportEvent) => {
				if (e.kind !== 'inbound' || !isObj(e.message)) return;
				const targets = sources.filter(([, channel]) => channel === e.channel);
				if (targets.length === 0) return;
				const digest = hex(await sha256(canonical({ channel: e.channel, message: e.message })));
				const at = now();
				await db.write({ text: `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth)
					SELECT v.id, v.a, v.i, $1::timestamptz, v.k, 'inbound', 0 FROM jsonb_to_recordset($2::jsonb) AS v(id text, a text, i jsonb, k text)
					ON CONFLICT (key) DO NOTHING`, params: [at, targets.map(([c]) => ({ id: runId(), a: `${c}.integration`, i: { mode: 'deliver', message: e.message }, k: `inbound:${c}:${digest}` }))] });
				config.announce?.(at);
			};
			const offs = transports.map((t) => t.subscribe(queue));
			return () => { for (const off of offs) off(); };
		},
	};
}

/**
 * A declared body by its dotted path in the guest bundle (`integration.<c>.spec.fields.<f>.in`, `pipeline.<c>.spec.import.map`),
 * one fresh isolate per call; an argument `{ $ctx: true }` is the IntegrationCtx, whose reads run as `authority`.
 * ponytail: one isolate per record and field; a batched mapping entry in the guest ABI when feeds outgrow it.
 */
export function mappingBody(config: { engine: Pick<Engine, 'read'>; guest?: GuestPort }, authority: Authority, bindings: Bindings, prefix: string) {
	let n = 0;
	const call = async (path: string, args: Json): Promise<Json> => {
		if (config.guest === undefined) throw new BoltError('noGuest', 'guest', 'this host runs no guest code');
		const id = `${prefix}:body:${n++}`;
		const inv: Invocation = { id, kind: 'mapping', target: path, input: args,
			ctx: { actor: authority.actor, now: bindings.now, today: bindings.today, tz: bindings.tz, seed: id },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes } };
		const bridge: Bridge = { async cross(calls) {
			const reads = calls.flatMap((x) => x.op === 'read' ? [x.read] : []);
			let answers: readonly Json[];
			try {
				answers = await config.engine.read(reads, { as: 'caller', authority }, bindings);
			} catch (e) {
				return calls.map((): CrossAnswer => ({ ok: false, error: { kind: 'bolt', code: e instanceof BoltError ? e.code : 'internal', message: String((e as Error).message) } }));
			}
			let i = 0;
			return calls.map((x): CrossAnswer => x.op === 'read' ? { ok: true, value: answers[i++]! }
				: { ok: false, error: { kind: 'bolt', code: 'unsupported', message: `a mapping cannot ${x.op}` } });
		} };
		const g = await config.guest.invoke(inv, bridge);
		if (g.kind === 'ok') return g.output;
		throw g.kind === 'failed' ? g.error : new BoltError('guestRefused', 'guest', g.message);
	};
	/** One body over its arguments; `each` runs it over many items (each with `extra`) in ONE invocation, answers in order. */
	return Object.assign((path: string, args: readonly Json[]) => call(path, args as Json), {
		each: async (path: string, items: readonly Json[], extra: Json): Promise<readonly Json[]> => {
			if (items.length === 0) return [];
			const out = await call(path, { $each: items as Json, with: extra });
			if (!Array.isArray(out) || out.length !== items.length) throw new BoltError('badAnswer', 'guest', `${path} answered ${Array.isArray(out) ? out.length : 'no'} results for ${items.length} items`);
			return out;
		}
	});
}

/** The `$sync` of rows (§3.3.5): a failed push stays visible until a push succeeds. */
export async function syncState(db: Pick<Engine['db'], 'read'>, collection: string, ids: readonly string[]):
	Promise<Map<string, { status: 'ok' | 'failed'; error: string | null; run: string | null }>> {
	const [res] = await db.read([{ text: `SELECT record, status, error, run FROM bolt_sync WHERE collection = $1 AND record IN (SELECT jsonb_array_elements_text($2::jsonb))`,
		params: [collection, JSON.stringify(ids)] }]);
	return new Map(res!.rows.map((r) => [String(r['record']), { status: r['status'] as 'ok' | 'failed', error: r['error'] as string | null, run: r['run'] as string | null }]));
}
