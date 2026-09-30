// The host half of `/__bolt/{q,act,live,push,agent}` (§5.7, §5.9) as one fetch-style handler; any host mounts it (P18).
// Sessions are the host's (`session`), so this file names no cookie and no host. Files, session and ops are routed by
// their owners. The in-app agent's turns run after the act that posts to them answers; `settled()` waits for them.
import type { Json } from '../decl/values.ts';
import type { Authority, Bindings, Outcome, ReadIR, RowData } from '../engine/contracts.ts';
import type { Decision, DecideInput } from '../engine/approvals/approvals.ts';
import type { LocalFilterField } from '../engine/filter-describe/index.ts';
import { BoltError } from '../engine/contracts.ts';
import { chargesFor, RateWindows } from '../engine/access/rate.ts';
import { isStaff, transcriptRow } from '../engine/agent/schema.ts';
import { lowerRead, type Engine } from '../engine/index.ts';
import { fingerprint, schemaSlice } from '../engine/schema/plan.ts';
import type { Verb } from '../engine/write/act.ts';
import { subscribe } from './push.ts';
import { HEADERS, PATHS, redact, statusOf, uuidv7Within, type ActBody, type ActReply, type AgentRow, type Frame, type LiveBody, type LiveReply,
	type PushBody, type QBody, type WireRead } from './wire.ts';

export type BoltHttp = {
	/** The engine's `live` hub carries the streams; `act` has already published its commit (rule 66). */
	engine: Pick<Engine, 'manifest' | 'db' | 'act' | 'calls' | 'read' | 'live' | 'approvals' | 'agents'> & Partial<Pick<Engine, 'triage' | 'filters' | 'envoys'>>; // hook:triage, hook:decisions, hook:agent-ui (envoys)
	/** The caller's compiled authority, or `null` (401). */
	session(request: Request): Promise<Authority | null>;
	bindings(): Bindings;
	uuid(): string;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const STATUS: { readonly [code: string]: number } = { invalid: 400, invalidInput: 400, badCursor: 400, refused: 422, unknownCollection: 404, unknownCallable: 404, notFound: 404, forbidden: 403, tooLarge: 413, tooManySubscriptions: 429, unsupported: 501 };
const failure = (e: unknown) => e instanceof BoltError
	? json({ error: { code: e.code, message: e.message } }, STATUS[e.code] ?? 500)
	: json({ error: { code: 'internal', message: 'The request failed.' } }, 500);
const WRITES: ReadonlySet<string> = new Set<Verb>(['create', 'update', 'delete', 'upsert']);
const DECISIONS: ReadonlySet<string> = new Set(['APPROVED', 'REJECTED', 'REQUEST_FOR_CHANGE', 'SUPERSEDED']);
const obj = (v: Json) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as { readonly [k: string]: Json };
const refusedId: Outcome = { kind: 'refused', code: 'invalidInput', message: 'A run id is a uuidv7 minted within 24 hours.', field: 'id' };
/** A decision is a success the client settles like a write (rule 32); a refusal or `no longer pending` passes through. */
const decided = (d: Decision): Outcome => d.kind === 'decided' ? { kind: 'committed', output: { requestId: d.requestId, status: d.status }, records: [] } : d;
const PING_MS = 25_000;
const committed = (output: Json): Outcome => ({ kind: 'committed', output, records: [] });
const refusal = (code: 'forbidden' | 'notFound' | 'rateLimited' | 'invalidInput', message: string): Outcome => ({ kind: 'refused', code, message });
const gone = refusal('notFound', 'Not found or no access.');

/**
 * `GET /__bolt/openapi.json` (§5.7, L-BOLT-294): OpenAPI 3.1 of what this caller may invoke, from the manifest: `/q` with the
 * collections it reads and the queries it may run, `/act` with one body per callable it may call (generated verbs, actions,
 * `start` of its automations). ponytail: inputs are open objects; derive per-callable JSON Schema when a consumer needs it.
 */
export function openapi(m: Engine['manifest'], a: Authority, version: string): Json {
	const may = (c: string, part: 'read' | 'create' | 'update' | 'delete') => a.admin || (a.collections[c]?.[part].length ?? 0) > 0;
	const named = (c: string, part: 'queries' | 'actions') => Object.entries(m.collections[c]?.[part] ?? {})
		.filter(([n, s]) => (s as { internal?: true }).internal !== true && (a.admin || (a.collections[c]?.[part] ?? []).includes(n))).map(([n]) => `${c}.${n}`);
	const cs = Object.keys(m.collections);
	const reads = cs.filter((c) => may(c, 'read'));
	const callables = [
		...cs.flatMap((c) => (['create', 'update', 'delete'] as const).filter((v) => m.collections[c]![v] !== undefined && may(c, v)).map((v) => `${c}.${v}`)),
		...cs.flatMap((c) => named(c, 'actions')),
		...((a.admin ? Object.keys(m.automations) : a.automations).length > 0 ? ['start'] : []),
	];
	const body = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
	const answers = { 200: { description: 'answered' }, 202: { description: 'pendingApproval' }, 401: { description: 'unauthenticated' }, 422: { description: 'refused' } };
	return {
		openapi: '3.1.0', info: { title: 'Bolt workspace', version },
		components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } }, security: [{ apiKey: [] }],
		paths: {
			[PATHS.q]: { post: { operationId: 'q', requestBody: body({ type: 'object', required: ['reads'], properties: { reads: { type: 'array', items: { type: 'object', required: ['m', 'a'],
				properties: { m: { enum: ['read', 'get', 'aggregate', 'similar', 'history', 'query'] }, a: { type: 'array', prefixItems: [{ enum: [...reads, ...cs.flatMap((c) => named(c, 'queries'))] }] } } } } } }), responses: answers } },
			[PATHS.act]: { post: { operationId: 'act',
				parameters: [{ name: HEADERS.key, in: 'header', required: true, schema: { type: 'string' } }, { name: HEADERS.contract, in: 'header', schema: { type: 'string', const: version } }],
				requestBody: body({ oneOf: callables.map((c) => ({ type: 'object', required: ['callable', 'input', 'issuedAt'],
					properties: { callable: { const: c }, input: { type: 'object' }, issuedAt: { type: 'string', format: 'date-time' } } })) }), responses: answers } },
		},
	} as Json;
}

/** A text/event-stream response: `open` gets the writer and answers the close; pinged every 25 s. */
export function sse(open: (write: (text: string) => void) => () => void): Response {
	const encoder = new TextEncoder();
	let close = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } };
			const ping = setInterval(() => write(': ping\n\n'), PING_MS);
			const off = open(write);
			close = () => { clearInterval(ping); off(); };
		},
		cancel() { close(); },
	});
	return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

/**
 * Whether a request may run a guest body (rule 71), so a host admits only these under its compute envelope. Guest-free:
 * the live stream, the agent panel's and approval reads, the OpenAPI document, and `/q` or `/live` registrations whose
 * reads name no guest `query` or `similar`. Anything else, an unreadable body included, may.
 */
export async function needsGuest(request: Request): Promise<boolean> {
	const path = new URL(request.url).pathname;
	if (request.method === 'GET') return !(path === PATHS.live || path === PATHS.openapi || path === PATHS.approval || path === PATHS.agent || path.startsWith(`${PATHS.agent}/`));
	if (request.method !== 'POST' || (path !== PATHS.q && path !== PATHS.live)) return true;
	const body = await request.clone().json().catch(() => null) as { reads?: unknown; add?: unknown } | null;
	const reads = path === PATHS.q ? body?.reads : Array.isArray(body?.add) ? (body.add as { read?: unknown }[]).map((x) => x?.read) : [];
	return !Array.isArray(reads) || reads.some((r) => { const m = (r as WireRead | null)?.m; return m !== 'read' && m !== 'get' && m !== 'aggregate' && m !== 'history' && m !== 'transcript' && m !== 'inbox' && m !== 'conversations'; });
}

export function boltHandler(h: BoltHttp): ((request: Request) => Promise<Response | null>) & { settled(): Promise<void> } {
	const db = h.engine.db, windows = new RateWindows();
	/** The schema this handler serves: a `Bolt-Contract` naming another is a page built for a retired release (L-BOLT-171). */
	const contract = fingerprint(schemaSlice(h.engine.manifest));
	const turns = new Set<Promise<unknown>>();
	/** A turn runs after the act that caused it answers (rule 48: never inside its request). */
	const turn = (run: () => Promise<unknown>) => {
		const p: Promise<unknown> = run().catch(() => {}).finally(() => turns.delete(p));
		turns.add(p);
	};
	/** The member the in-app agent serves: staff with an internal brief, external members with an external one. */
	const agentMember = (a: Authority): string | null =>
		a.actor.kind === 'member' && (a.actor.external ? h.engine.manifest.agent.external : h.engine.manifest.agent.internal) !== undefined ? a.actor.id : null;
	/** The conversation's owner, or `null` when there is none this caller may see. */
	const ownerOf = async (id: string): Promise<string | null> =>
		((await db.read([{ text: `SELECT owner FROM sys_conversation WHERE id = $1 AND channel IS NULL`, params: [id] }]))[0]!.rows[0]?.['owner'] ?? null) as string | null;
	/** A channel (envoy) conversation, read-only in the chat UI (rule 61); `null` for any other id. */
	const channelOf = async (id: string): Promise<string | null> =>
		((await db.read([{ text: `SELECT id FROM sys_conversation WHERE id = $1 AND channel IS NOT NULL`, params: [id] }]))[0]!.rows[0]?.['id'] ?? null) as string | null;
	const staff = isStaff;
	/**
	 * Own in-app conversations (admins: every one). A channel (envoy) conversation — read-only in the chat UI (owner
	 * 2026-09-26) — is visible to a member who is in it (a group they post in, or their own DM: a row sent as them) and to
	 * any internal member on a `public` envoy. Nobody else: a DM ran under its sender's authority, and its tool results
	 * carry what that authority could read.
	 */
	const mayRead = async (a: Authority, id: string) => {
		const o = await ownerOf(id);
		if (o !== null) return a.admin || (a.actor.kind === 'member' && o === a.actor.id);
		if (await channelOf(id) === null || a.actor.kind !== 'member') return false;
		const [row] = (await db.read([{ text: `SELECT c.envoy, EXISTS (SELECT 1 FROM sys_message m WHERE m.conversation = c.id
				AND $2 IN (m.author, m."as"->>'member', m."as"->'envoy'->>'member')) AS joined
			FROM sys_conversation c WHERE c.id = $1`, params: [id, a.actor.id] }]))[0]!.rows;
		if (row === undefined) return false;
		if (row['joined'] === true) return true;
		const envoy = typeof row['envoy'] === 'string' ? h.engine.manifest.envoys[row['envoy']] : undefined;
		return staff(a) && (envoy as { audience?: unknown } | undefined)?.audience === 'public';
	};
	/** A conversation the caller may read: their own in-app one, or a channel thread they may see. */
	const own = async (a: Authority, input: Json): Promise<string | null> => {
		const c = obj(input)['conversation'];
		if (typeof c !== 'string') throw new BoltError('invalid', 'decode', 'this call takes { conversation }');
		return await mayRead(a, c) ? c : null;
	};
	/** A message of an in-app conversation the caller may read. */
	const messageOf = async (a: Authority, input: Json): Promise<{ id: string; conversation: string } | null> => {
		const id = obj(input)['message'];
		if (typeof id !== 'string') throw new BoltError('invalid', 'decode', 'this call takes { message }');
		const c = (await db.read([{ text: `SELECT conversation FROM sys_message WHERE id = $1`, params: [id] }]))[0]!.rows[0]?.['conversation'];
		return typeof c === 'string' && await ownerOf(c) !== null && await mayRead(a, c) ? { id, conversation: c } : null;
	};
	/** An engine refusal (not the author, not the newest revision, an unmapped model) answers as a refusal, never a 500. */
	const attempt = async (f: () => Promise<unknown>): Promise<Outcome | null> => {
		try { await f(); return null; } catch (e) { return refusal('forbidden', e instanceof Error ? e.message : String(e)); }
	};

	const lower = (r: WireRead): ReadIR => {
		if (typeof r?.m !== 'string' || !Array.isArray(r.a)) throw new BoltError('invalid', 'decode', 'a read is { m, a }');
		return lowerRead(h.engine.manifest, r.m, r.a);
	};

	/** The callables that are not a collection's: run starts (rule 51) and approval decisions (rule 46). */
	const OWN: { readonly [callable: string]: (authority: Authority, input: Json, b: Bindings) => Promise<Outcome> } = {
		async start(authority, input, b) {
			const x = obj(input);
			if (typeof x['automation'] !== 'string' || typeof x['id'] !== 'string') throw new BoltError('invalid', 'decode', 'start takes { automation, input, id }');
			if (!uuidv7Within(x['id'], Date.parse(b.now))) return refusedId;
			return h.engine.calls.start({ automation: x['automation'], input: x['input'] ?? {}, id: x['id'], authority, bindings: b });
		},
		async 'approvals.process'(authority, input, b) {
			const x = obj(input);
			if (typeof x['requestId'] !== 'string' || !DECISIONS.has(String(x['status']))) throw new BoltError('invalid', 'decode', 'approvals.process takes { requestId, status, reason? }');
			return decided(await h.engine.approvals.process({ requestId: x['requestId'], status: x['status'] as DecideInput['status'], authority, now: b.now,
				...(typeof x['reason'] === 'string' ? { reason: x['reason'] } : {}) }));
		},
		async 'approvals.withdraw'(authority, input, b) {
			const x = obj(input);
			if (typeof x['requestId'] !== 'string') throw new BoltError('invalid', 'decode', 'approvals.withdraw takes { requestId }');
			return decided(await h.engine.approvals.withdraw({ requestId: x['requestId'], authority, now: b.now }));
		},
		// hook:decisions — rule 16a: a description → `{ where, orderBy? }` as the caller; absent without an AI facility
		async 'filter.describe'(authority, input, b) {
			const x = obj(input), filters = h.engine.filters;
			if (filters === undefined) return refusal('notFound', 'Describing a filter is not available here.');
			if (typeof x['collection'] !== 'string' || typeof x['text'] !== 'string') throw new BoltError('invalid', 'decode', 'filter.describe takes { collection, text }');
			const raw = x['fields'];
			if (raw !== undefined && (!Array.isArray(raw) || raw.some((v) => typeof v !== 'object' || v === null || Array.isArray(v) ||
				typeof v['name'] !== 'string' || typeof v['label'] !== 'string' || !['text', 'number', 'bool'].includes(String(v['kind'])) ||
				(v['optional'] !== undefined && typeof v['optional'] !== 'boolean'))))
				throw new BoltError('invalid', 'decode', 'filter.describe fields are invalid');
			const v = windows.charge(chargesFor(authority, ['agent'], { actor: authority.actor.kind === 'member' ? authority.actor.id : authority.key }), Date.parse(b.now)); // rule 16a: one against `agent`
			if (!v.ok) return refusal('rateLimited', `Too many requests; retry in ${v.retryAfter} s.`);
			const r = await filters.describe({ collection: x['collection'], text: x['text'], authority, bindings: b,
				...(raw === undefined ? {} : { localFields: raw as LocalFilterField[] }) });
			return r.ok ? committed({ where: r.where, ...(r.orderBy === undefined ? {} : { orderBy: r.orderBy }) })
				: refusal(r.code === 'notFound' ? 'notFound' : 'invalidInput', r.message);
		},
		// hook:decisions — rule 16b: the same catalogue the description is offered, as plain data for the builder; pure
		// exposure, so no AI facility and no rate window
		async 'filter.options'(authority, input, b) {
			const x = obj(input), filters = h.engine.filters;
			if (filters === undefined) return refusal('notFound', 'Filter options are not available here.');
			if (typeof x['collection'] !== 'string') throw new BoltError('invalid', 'decode', 'filter.options takes { collection }');
			const raw = x['fields'];
			if (raw !== undefined && (!Array.isArray(raw) || raw.some((v) => typeof v !== 'object' || v === null || Array.isArray(v) ||
				typeof v['name'] !== 'string' || typeof v['label'] !== 'string' || !['text', 'number', 'bool'].includes(String(v['kind'])) ||
				(v['optional'] !== undefined && typeof v['optional'] !== 'boolean'))))
				throw new BoltError('invalid', 'decode', 'filter.options fields are invalid');
			const r = await filters.options({ collection: x['collection'], authority, bindings: b,
				...(raw === undefined ? {} : { localFields: raw as LocalFilterField[] }) });
			return r.ok ? committed({ fields: r.fields }) : refusal(r.code === 'notFound' ? 'notFound' : 'invalidInput', r.message);
		},
		// ── the in-app agent (§5.9): the panel's three callables ──
		async 'sys_conversation.start'(authority, input) {
			const who = agentMember(authority), x = obj(input);
			if (who === null) return refusal('forbidden', 'The assistant is not available to you here.');
			return committed({ id: await h.engine.agents.start({ owner: who, ...(typeof x['title'] === 'string' ? { title: x['title'] } : {}),
				...(typeof x['model'] === 'string' ? { model: x['model'] } : {}) }) });
		},
		async 'sys_message.post'(authority, input, b) {
			const who = agentMember(authority), x = obj(input);
			if (who === null) return refusal('forbidden', 'The assistant is not available to you here.');
			const conversation = x['conversation'], text = x['text'], refs = x['attachments'] ?? [];
			if (typeof conversation !== 'string' || typeof text !== 'string' || !Array.isArray(refs) || (text.trim() === '' && refs.length === 0))
				throw new BoltError('invalid', 'decode', 'sys_message.post takes { conversation, text, attachments?, mode? }');
			if (await ownerOf(conversation) !== who) return refusal('notFound', 'Not found or no access.');
			const files = await h.engine.agents.attachments(who, refs); // hook:attachments — the member's own panel uploads, 8 files / 20 MiB
			if (typeof files === 'string') return refusal('invalidInput', files);
			const v = windows.charge(chargesFor(authority, ['agent'], { actor: who }), Date.parse(b.now)); // rule 72: `agent` per actor
			if (!v.ok) return refusal('rateLimited', `Too many requests; retry in ${v.retryAfter} s.`);
			const tz = typeof x['tz'] === 'string' ? { tz: x['tz'] } : {}; // hook:agent — the person's clock (rule 57)
			const name = authority.actor.kind === 'member' ? authority.actor.email ?? who : who; // the sender header the model reads (rule 57, P32)
			// a preview (rule 39) reaches the turn: the agent holds the previewed team's grants, not the previewer's own
			const team = authority.key.startsWith('preview:team:') ? authority.key.split(':')[2] : undefined;
			const as = { member: who, ...(team === undefined ? {} : { team }) };
			if (x['mode'] === 'compact') { const row = await h.engine.agents.post({ conversation, as, text, author: name, mode: 'compact', ...tz }); turn(() => h.engine.agents.drain(conversation)); return committed({ id: row.id }); } // hook:agent — `/compact`
			const mode = x['mode'] === 'plan' ? 'plan' : 'agent', triage = h.engine.triage; // hook:triage — rule 60a: plain Enter is triaged, `now: true` sends now
			if (x['now'] !== true && triage?.inApp() === true) return committed({ id: (await triage.post({ conversation, as, text, author: name, mode, files, ...tz })).id });
			await triage?.release(conversation);
			const row = await h.engine.agents.post({ conversation, as, text, author: name, mode, files, ...tz });
			turn(() => h.engine.agents.drain(conversation));
			return committed({ id: row.id });
		},
		async 'sys_conversation.respondNow'(authority, input) { // hook:triage — the pending rows alone, admitted at once
			const who = agentMember(authority), conversation = obj(input)['conversation'];
			if (typeof conversation !== 'string') throw new BoltError('invalid', 'decode', 'sys_conversation.respondNow takes { conversation }');
			if (who === null || await ownerOf(conversation) !== who) return refusal('notFound', 'Not found or no access.');
			await h.engine.triage?.release(conversation);
			turn(() => h.engine.agents.drain(conversation));
			return committed({ id: conversation });
		},
		// ── the conversation controls (§5.9's generated actions; parity 3.2–3.6, 3.13, 2.17) ──
		async 'sys_conversation.stop'(authority, input) {
			const c = await own(authority, input);
			if (c === null || await ownerOf(c) === null) return gone; // a channel thread is read-only here (rule 61)
			await h.engine.agents.stop(c);
			return committed({ id: c });
		},
		async 'sys_conversation.resume'(authority, input) {
			const c = await own(authority, input);
			if (c === null || await ownerOf(c) === null) return gone;
			turn(() => h.engine.agents.resume(c));
			return committed({ id: c });
		},
		async 'sys_conversation.setModel'(authority, input) {
			const c = await own(authority, input), model = obj(input)['model'];
			if (typeof model !== 'string') throw new BoltError('invalid', 'decode', 'sys_conversation.setModel takes { conversation, model }');
			if (c === null || await ownerOf(c) === null) return gone;
			return await attempt(() => h.engine.agents.setModel(c, model)) ?? committed({ id: c, model });
		},
		async 'sys_message.revise'(authority, input) {
			const m = await messageOf(authority, input), text = obj(input)['text'];
			if (typeof text !== 'string' || text.trim() === '') throw new BoltError('invalid', 'decode', 'sys_message.revise takes { message, text }');
			if (m === null) return gone;
			let id = '';
			const refused = await attempt(async () => { id = await h.engine.agents.revise(m.id, text, authority); });
			if (refused !== null) return refused;
			turn(() => h.engine.agents.drain(m.conversation));
			return committed({ id });
		},
		async 'sys_message.dequeue'(authority, input) {
			const m = await messageOf(authority, input);
			if (m === null) return gone;
			return await attempt(() => h.engine.agents.dequeue(m.id, authority)) ?? committed({ id: m.id });
		},
		async 'sys_message.reorder'(authority, input) {
			const c = await own(authority, input), ids = obj(input)['messages'];
			if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new BoltError('invalid', 'decode', 'sys_message.reorder takes { conversation, messages }');
			if (c === null || await ownerOf(c) === null) return gone;
			return await attempt(() => h.engine.agents.reorder(c, ids as string[], authority)) ?? committed({ id: c });
		},
		async 'sys_message.executePlan'(authority, input) {
			const c = await own(authority, input), who = agentMember(authority);
			if (c === null || who === null || await ownerOf(c) !== who) return gone;
			if ((await h.engine.agents.conversation(c)).plan === null) return refusal('invalidInput', 'There is no plan to execute.');
			turn(() => h.engine.agents.executePlan(c, { member: who }));
			return committed({ id: c });
		},
		async 'sys_message.discardPlan'(authority, input) {
			const c = await own(authority, input);
			if (c === null || await ownerOf(c) === null) return gone;
			await h.engine.agents.discardPlan(c);
			return committed({ id: c });
		},
		// hook:agent-ui — §5.9's remaining generated actions
		async 'sys_conversation.setAgent'(authority, input) {
			const c = await own(authority, input), agent = obj(input)['agent'];
			if (typeof agent !== 'string') throw new BoltError('invalid', 'decode', 'sys_conversation.setAgent takes { conversation, agent }');
			if (c === null || await ownerOf(c) === null) return gone;
			if (!staff(authority)) return refusal('forbidden', 'Only staff switch the agent of a conversation.'); // an envoy's brief is not an external member's to read
			return await attempt(() => h.engine.agents.setAgent(c, agent)) ?? committed({ id: c, agent });
		},
		async 'sys_message.file'(authority, input, b) {
			const x = obj(input), about = x['about'] ?? null, message = x['message'];
			if (typeof message !== 'string' || !(about === null || (typeof obj(about)['collection'] === 'string' && typeof obj(about)['id'] === 'string')))
				throw new BoltError('invalid', 'decode', 'sys_message.file takes { message, about: { collection, id } | null }');
			const [r] = (await db.read([{ text: `SELECT conversation FROM sys_message WHERE id = $1`, params: [message] }]))[0]!.rows;
			if (r === undefined || !staff(authority) || !(await mayRead(authority, String(r['conversation'])))) return gone;
			const target = about === null ? null : { collection: String(obj(about)['collection']), id: String(obj(about)['id']) };
			// filed only about a record the member can read
			if (target !== null) {
				const [row] = await (async () => h.engine.read([lowerRead(h.engine.manifest, 'get', [target.collection, target.id])], { as: 'caller', authority }, b))().catch(() => [null]);
				if (row === null || row === undefined) return gone;
			}
			await h.engine.agents.file(message, target);
			return committed({ id: message, about: target });
		},
		async 'sys_message.markRead'(authority, input) {
			const c = await own(authority, input);
			if (c === null || authority.actor.kind !== 'member') return gone;
			await h.engine.agents.markRead(c, authority.actor.id);
			return committed({ id: c });
		},
		/** L-BOLT-354: the member marks their own inbox notices read; `read_at` is the only field a member writes on a notice. */
		async 'sys_notification.markRead'(authority, input) {
			const ids = obj(input)['ids'];
			if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) throw new BoltError('invalid', 'decode', 'sys_notification.markRead takes { ids }');
			if (authority.actor.kind !== 'member') return gone;
			const read = await db.write({ text: `UPDATE sys_notification SET read_at = now() WHERE member = $1 AND read_at IS NULL AND id IN (SELECT jsonb_array_elements_text($2::jsonb))
				RETURNING id, to_jsonb(sys_notification) AS n`, params: [authority.actor.id, JSON.stringify(ids)] });
			h.engine.live.publish(read.rows.map((r) => ({ collection: 'sys_notification', id: String(r['id']), op: 'update', revision: 0, old: null, new: r['n'] as RowData, cause: 'direct' })));
			return committed({ ids });
		},
		/** The caller's own registration claim (rule 38c's exception); the real member, never a previewed one (rule 39). */
		async 'sys_user.linkHandle'(authority, input, b) {
			const x = obj(input), envoys = h.engine.envoys;
			if (typeof x['claim'] !== 'string') throw new BoltError('invalid', 'decode', 'sys_user.linkHandle takes { claim, replay? }');
			if (authority.actor.kind !== 'member' || authority.key.startsWith('preview:')) return refusal('forbidden', 'Only the signed-in member links their own handle.');
			if (envoys === undefined) return gone;
			const r = await envoys.redeem(x['claim'], authority, { replay: x['replay'] === true });
			return r.state === 'registered' || r.state === 'already_registered' ? committed(r as unknown as Json) : refusal('invalidInput', `The claim is ${r.state}.`);
		},
		async 'sys_message.confirm'(authority, input) {
			const x = obj(input), message = x['message'];
			if (typeof message !== 'string' || typeof x['approve'] !== 'boolean') throw new BoltError('invalid', 'decode', 'sys_message.confirm takes { message, approve }');
			const [r] = (await db.read([{ text: `SELECT m.conversation, m."as" FROM sys_message m WHERE m.id = $1 AND m.state = 'confirm'`, params: [message] }]))[0]!.rows;
			if (r === undefined || !(await mayRead(authority, String(r['conversation'])))) return refusal('notFound', 'Nothing awaits confirmation here.');
			const as = r['as'] as { member?: string } | null;
			if (!authority.admin && !(authority.actor.kind === 'member' && as?.member === authority.actor.id)) return refusal('forbidden', 'Only the person this turn serves can confirm it.');
			const approve = x['approve'];
			turn(() => h.engine.agents.confirm(message, approve, authority));
			return committed({ id: message });
		},
	};

	async function transcript(request: Request, authority: Authority): Promise<Response> {
		const id = new URL(request.url).searchParams.get('conversation') ?? '';
		if (!(await mayRead(authority, id))) return json({ error: { code: 'notFound', message: 'Not found or no access.' } }, 404);
		const [conv] = (await db.read([{ text: `SELECT status, channel FROM sys_conversation WHERE id = $1`, params: [id] }]))[0]!.rows;
		// hook:agent-ui — a channel thread shows its whole history (ambient rows included); the in-app panel only what the agent received
		const thread = (conv?.['channel'] ?? null) !== null;
		// `before` + `limit`: the panel's older page (the messages just before its live window); `more`: a page may lie before it
		const p = new URL(request.url).searchParams, before = Number(p.get('before')), limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
		const raw = await h.engine.agents.transcript(id, p.has('before') && Number.isFinite(before) ? { before, limit } : undefined);
		return json({ value: { status: conv?.['status'] ?? 'idle', rows: raw.flatMap((r) => transcriptRow(r, staff(authority), thread) ?? []),
			...(p.has('before') ? { more: raw.length === limit, first: raw[0] === undefined ? before : Number(raw[0].seq) } : {}) } });
	}
	/** The panel's model selector: the models the member may pick and the one a new conversation runs (the conversations themselves are a live read). */
	async function models(authority: Authority): Promise<Response> {
		if (agentMember(authority) === null) return json({ error: { code: 'forbidden', message: 'The assistant is not available to you here.' } }, 403);
		return json({ value: await h.engine.agents.models() });
	}
	async function approval(request: Request, authority: Authority): Promise<Response> {
		const p = new URL(request.url).searchParams;
		const id = p.get('id') ?? '';
		const readable = async (collection: string, record: string) => {
			try {
				const [row] = await h.engine.read([lower({ m: 'get', a: [collection, record] })], { as: 'caller', authority }, h.bindings());
				return row !== null && row !== undefined;
			} catch { return false; }
		};
		if (!p.has('id')) {
			const records = p.getAll('record'), ids = p.getAll('request');
			return json({ value: await h.engine.approvals.list({ ...(p.has('collection') ? { collection: p.get('collection')! } : {}),
				...(records.length === 0 ? {} : { records }), ...(ids.length === 0 ? {} : { ids }), all: p.get('all') === '1' }, authority, readable) });
		}
		const view = await h.engine.approvals.view(id, authority, readable);
		return view === null ? json({ error: { code: 'notFound', message: 'Not found or no access.' } }, 404) : json({ value: view });
	}
	async function push(authority: Authority, body: PushBody): Promise<Response> {
		if (authority.actor.kind !== 'member' || authority.actor.external) return json({ error: { code: 'forbidden', message: 'Only staff members receive notices.' } }, 403);
		if (typeof body.endpoint !== 'string' || !/^https:\/\//.test(body.endpoint) || body.endpoint.length > 2048
			|| (body.remove !== true && (typeof body.keys?.p256dh !== 'string' || typeof body.keys.auth !== 'string')))
			throw new BoltError('invalid', 'decode', 'the body is a PushSubscription ({ endpoint, keys: { p256dh, auth } }) or { endpoint, remove: true }');
		await subscribe(db, authority.actor.id, { endpoint: body.endpoint, ...(body.keys === undefined ? {} : { keys: body.keys }), ...(body.remove === true ? { remove: true } : {}) });
		return new Response(null, { status: 204 });
	}

	async function q(authority: Authority, body: QBody): Promise<Response> {
		if (!Array.isArray(body.reads)) throw new BoltError('invalid', 'decode', 'the body is { reads }');
		const answers = await h.engine.read(body.reads.map(lower), { as: 'caller', authority }, h.bindings());
		return json({ answers });
	}

	async function act(request: Request, authority: Authority, body: ActBody): Promise<Response> {
		const key = request.headers.get(HEADERS.key);
		if (key === null || key === '') throw new BoltError('invalid', 'decode', `${HEADERS.key} is required (rule 31)`);
		if (typeof body.callable !== 'string' || typeof body.issuedAt !== 'string') throw new BoltError('invalid', 'decode', 'the body is { callable, input, issuedAt }');
		const stated = request.headers.get(HEADERS.contract);
		if (stated !== null && stated !== contract)
			return json({ outcome: { kind: 'refused', code: 'releaseChanged', message: 'The workspace was updated; reload the page.' }, v: h.engine.live.v } satisfies ActReply, 409);
		const b = h.bindings();
		const own = Object.hasOwn(OWN, body.callable) ? OWN[body.callable] : undefined;
		if (own !== undefined) {
			const outcome = await own(authority, body.input, b);
			return json({ outcome: redact(outcome, authority.actor), v: h.engine.live.v } satisfies ActReply, statusOf(outcome));
		}
		const dot = body.callable.lastIndexOf('.');
		const verb = body.callable.slice(dot + 1);
		if (dot < 0) throw new BoltError('unknownCallable', 'decode', `there is no callable '${body.callable}'`);
		const common = { collection: body.callable.slice(0, dot), input: body.input, key, issuedAt: body.issuedAt,
			retry: request.headers.get(HEADERS.retry) === '1', authority, bindings: b, invocationId: h.uuid() };
		const { outcome, v } = WRITES.has(verb)
			? await h.engine.act({ ...common, verb: verb as Verb,
				...(body.observed === undefined ? {} : { observed: body.observed }), ...(body.onConflict === undefined ? {} : { onConflict: body.onConflict }) })
			: await h.engine.calls.action({ ...common, action: verb, from: 'client' });
		const reply: ActReply = { outcome: redact(outcome, authority.actor), v };
		return json(reply, statusOf(outcome));
	}

	function stream(authority: Authority): Response {
		const encoder = new TextEncoder();
		let conn = '', ping: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } };
				conn = h.engine.live.connect(authority, (frame: Frame) => write(`data: ${JSON.stringify(frame)}\n\n`), () => { clearInterval(ping); try { controller.close(); } catch { /* closed */ } });
				ping = setInterval(() => write(': ping\n\n'), PING_MS);
			},
			cancel() {
				clearInterval(ping);
				h.engine.live.disconnect(conn);
			},
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
	}

	/** The agent panel's live transcript: only a conversation the caller may read (§5.9). `{ tail: n }` keeps the view to the
	 * latest `n` messages as of now and every later one (`from`, fixed at registration so a re-read never shifts it). */
	async function transcriptRead(authority: Authority, read: WireRead): Promise<ReadIR> {
		const id = String(read.a[0] ?? '');
		if (!(await mayRead(authority, id))) throw new BoltError('notFound', 'admission', 'Not found or no access.');
		const tail = (read.a[1] as { tail?: unknown } | null | undefined)?.tail;
		const [start] = typeof tail === 'number' && tail > 0 ? (await db.read([{ text: `SELECT seq FROM sys_message WHERE conversation = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1`,
			params: [id, Math.floor(tail) - 1] }]))[0]!.rows : [];
		return { kind: 'transcript', collection: 'sys_message', conversation: id, thread: await channelOf(id) !== null, ...(start === undefined ? {} : { from: Number(start['seq']) }) };
	}
	/** The agent panel's conversation list: only the member's own in-app conversations. */
	function conversationsRead(authority: Authority): ReadIR {
		const who = agentMember(authority);
		if (who === null) throw new BoltError('forbidden', 'admission', 'The assistant is not available to you here.');
		return { kind: 'conversations', collection: 'sys_conversation', member: who };
	}
	/** The shell inbox (L-BOLT-354): only a staff member's own notices. */
	function inboxRead(authority: Authority): ReadIR {
		if (authority.actor.kind !== 'member' || authority.actor.external) throw new BoltError('forbidden', 'admission', 'No inbox for this member.');
		return { kind: 'inbox', collection: 'sys_notification', member: authority.actor.id };
	}
	async function register(authority: Authority, body: LiveBody): Promise<Response> {
		// a connection answers only the session that opened it
		const owner = h.engine.live.authorityOf(body.conn);
		if (owner !== undefined && JSON.stringify(owner.actor) !== JSON.stringify(authority.actor))
			throw new BoltError('forbidden', 'admission', 'the live connection belongs to another session');
		for (const view of body.drop ?? []) h.engine.live.drop(body.conn, view);
		const errors: { view: string; code: string; message: string }[] = [];
		await Promise.all((body.add ?? []).map(async (x) => {
			try {
				await h.engine.live.register(body.conn, x.view, { read: x.read?.m === 'transcript' ? await transcriptRead(authority, x.read) : x.read?.m === 'inbox' ? inboxRead(authority)
					: x.read?.m === 'conversations' ? conversationsRead(authority) : lower(x.read),
					...(x.every === undefined ? {} : { every: x.every }), ...(x.on === undefined ? {} : { on: x.on }) });
			} catch (e) {
				errors.push({ view: x.view, code: e instanceof BoltError ? e.code : 'internal', message: e instanceof Error ? e.message : String(e) });
			}
		}));
		return json({ errors } satisfies LiveReply);
	}

	const handle = async (request: Request): Promise<Response | null> => {
		const path = new URL(request.url).pathname;
		const route = request.method === 'POST' && path === PATHS.q ? 'q' : request.method === 'POST' && path === PATHS.act ? 'act'
			: request.method === 'GET' && path === PATHS.openapi ? 'openapi'
			: request.method === 'POST' && path === PATHS.push ? 'push'
			: request.method === 'GET' && path === PATHS.approval ? 'approval'
			: request.method === 'GET' && path === PATHS.agent ? 'transcript' : request.method === 'GET' && path === `${PATHS.agent}/models` ? 'models'
			: path === PATHS.live && (request.method === 'GET' || request.method === 'POST') ? request.method : null;
		if (route === null) return null;
		try {
			const authority = await h.session(request);
			if (authority === null) return json({ error: { code: 'unauthenticated', message: 'Sign in first.' } }, 401);
			if (route === 'GET') return stream(authority);
			if (route === 'openapi') return json(openapi(h.engine.manifest, authority, contract));
			if (route === 'transcript') return await transcript(request, authority);
			if (route === 'approval') return await approval(request, authority);
			if (route === 'models') return await models(authority);
			let body: Json;
			try {
				body = await request.json() as Json;
			} catch {
				throw new BoltError('invalid', 'decode', 'the body is not JSON');
			}
			if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BoltError('invalid', 'decode', 'the body is an object');
			if (route === 'q') return await q(authority, body as QBody);
			if (route === 'act') return await act(request, authority, body as ActBody);
			if (route === 'push') return await push(authority, body as PushBody);
			return await register(authority, body as LiveBody);
		} catch (e) {
			return failure(e);
		}
	};
	return Object.assign(handle, { async settled() { while (turns.size > 0) await Promise.all([...turns]); } });
}
