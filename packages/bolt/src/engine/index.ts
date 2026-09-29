// The engine entry (§2, P2-INTEGRATE): one manifest and one `TenantDb` wired through every area — schema apply, the
// read engine, compiled authorities, the act pipeline, and the guest runner behind the transform's workspace reads.
// Hosts (bolt-server, the test kit) build one per activation; nothing here names a host (P18).
import type { Json } from '../decl/values.ts';
import type { AiPort, Authority, Bindings, Bridge, Captured, CrossAnswer, DeadlinesPort, EngineManifest, FilesPort, GuestPort, Invocation, MeteringPort, ReadEngine, ReadIR, RowData, TenantDb } from './contracts.ts'; // hook:triage (MeteringPort)
import { BoltError, callPort, LIMITS } from './contracts.ts';
import { compileAuthority, type Holder } from './access/authority.ts';
import { catalogOf } from './access/pred.ts';
import { guestRunner, type GuestOptions, type GuestProgram } from './guest/runner.ts';
import { readEngine, type SimilarityBodies } from './query/engine.ts';
import { readHistory } from './query/history.ts'; // hook:write — rule 17
import { fingerprinting, type Fingerprint } from './write/sql.ts'; // hook:write — rule 26
import * as ir from '../protocol/ir.ts';
import { applyPlan, plan, readApplied } from './schema/plan.ts';
import { act, type ActRequest, type ActResult, type WriteEngine } from './write/act.ts';
import { approvals, type Approvals } from './approvals/approvals.ts'; // hook:approvals
import { announceTriggered } from './runs/queue.ts'; // hook:automations
import { callables, type Callables } from './callables/index.ts';
import { integrations, type HttpPort } from './integrations/runner.ts';
import { bindConnections, type ConnectionsHost, type OAuth } from './connections.ts';
import { EMBED, assertWidth, embedRun } from './integrations/embed.ts'; // hook:integrations
import { INBOX_LIMIT, liveHub, noticeRow, type LiveHub } from './live/hub.ts';
import { pipelines } from './pipelines/pipeline.ts';
import { runs, type Runs, type RunsConfig } from './runs/index.ts';
import { queuesOutbound } from './channels/outbound.ts'; // hook:envoys
import { agents, TURN_RUN, type AgentConfig, type Agents } from './agent/index.ts';
import { conversationRow, CONVERSATIONS, isStaff, transcriptRow } from './agent/schema.ts';
import type { Channels, Transports } from './channels/index.ts';
import { messaging, type Envoys, type EnvoysConfig } from './envoys/index.ts';
import { triage, type Triage } from './agent/triage.ts'; // hook:triage
import { filterDescribe, type FilterDescribe } from './filter-describe/index.ts'; // hook:decisions
import { NOTICE_PUSH, noticePush } from '../protocol/push.ts'; // hook:gaps — web push on inbox notices

export type EngineConfig = {
	manifest: EngineManifest; db: TenantDb;
	/** The built `guest.mjs`; without it no body runs. */
	guest?: GuestProgram;
	/** Collections that attach a transform body (the manifest strips bodies). */
	transforms?: Iterable<string>;
	approval?: WriteEngine['approval']; admit?: WriteEngine['admit']; console?: GuestOptions['console'];
	/** hook:metering — every guest invocation's CPU ms, for the host's compute meter. */
	cpu?: GuestOptions['cpu'];
	/** Rule 52a: acts announce the runs their statement queued. */ // hook:automations
	deadlines?: DeadlinesPort; scope?: string;
	/** The workspace clock (ISO instant) live answers, runs and integration sessions bind; default the wall clock. */
	clock?: () => string;
	/** Integration connections (two_way pulls and pushes) and pipeline export files. */
	http?: HttpPort; files?: FilesPort;
	/** The host's side of the declared connections (§5.11.4): secrets, public origin, fetch. Builds `http` unless given, and `Engine.connections`. */
	connections?: ConnectionsHost;
	/** Run facilities, webhook secrets, the seed `start` list, extra platform runs. */
	runs?: Pick<RunsConfig, 'facility' | 'env' | 'start' | 'platform'>;
	/** The AI facility (P35): `sys_2` for the agent loop (§5.9; absent → every turn answers the fixed `failed` reply), `sys_1` for triage and filters, `embed` for `bolt.embed` (rule 16). */ // hook:ai
	ai?: AiPort;
	/** Channel transports (rule 61): email, WhatsApp, Telegram, push. Absent → outbound rows fail `unavailable`. */
	transports?: Transports;
	/** Rule 61: this environment's epoch; queued rows of another are skipped. */
	epoch?: string;
	agent?: Omit<AgentConfig, 'engine' | 'ai' | 'bindings'>; // hook:agent — geocoder, web, host skills and tools reach the agent
	envoys?: Pick<EnvoysConfig, 'registrationLink' | 'workspace'>;
	/** P33: the meter each `sys_1` decision (`ai.sys_1`) reports to. */ // hook:decisions
	metering?: MeteringPort;
	/** Rule 71a (hook:drains): the generation scope; aborting it interrupts every guest invocation and its in-flight crossing. */
	signal?: AbortSignal;
};
export type Engine = {
	manifest: EngineManifest; db: TenantDb;
	/** Engine tables, then the manifest's schema plan (destructive steps only when `accept`). */
	migrate(options?: { accept?: true | readonly string[] }): Promise<void>;
	/** Rule 37: the caller caches by `key`. */
	authority(holder: Holder, key?: string): Authority;
	/** Every act commit is announced (rule 52a) and published to `live`; `v` is its lane sequence (rule 66). */
	act(request: ActRequest): Promise<ActResult & { v: number }>;
	read: ReadEngine['run'];
	/** The body runner (`guest.mjs`) runs, integrations and pipelines share. */
	guest?: GuestPort;
	/** The host's stored blobs (`/__bolt/files`, `filesHandler`). */
	files?: FilesPort;
	/** The cell's live lane: every commit through `act` and `calls.action` is routed here. */
	live: LiveHub;
	/** Collection queries, actions and run starts (rules 31, 33, 33a); an action's commit is announced and published too. */
	calls: Omit<Callables, 'action'> & { action(r: Parameters<Callables['action']>[0]): Promise<Awaited<ReturnType<Callables['action']>> & { v: number }> };
	/** The run queue (rules 48–56); present when the host gives a deadlines port. */
	runs?: Runs;
	integrations: ReturnType<typeof integrations>;
	pipelines: ReturnType<typeof pipelines>;
	/** Rules 44–47: decisions, seal, restore, the participants' read branch. */ // hook:approvals
	approvals: Approvals;
	/** The agent loop (§5.9), channels (rule 61) and the envoys on them (P22). */
	agents: Agents; channels: Channels; envoys: Envoys;
	/** Rule 60a: when triaged messages start a turn. */ // hook:triage
	triage: Triage;
	/** Rule 16a: `filter.describe` on System 1; absent without an AI facility (the input is hidden). */ // hook:decisions
	filters?: FilterDescribe;
	/** OAuth2 consent for the shell's `/__bolt/connections/*` routes; present when the host bound `connections`. */
	connections?: OAuth;
};

/** A guest read call (`ctx.db.read('c', q)`, `ctx.get('c', id)`, …) as the query IR; a bad literal throws `invalid`. */
export function lowerRead(m: EngineManifest, member: string, args: readonly Json[]): ReadIR {
	const cat = catalogOf(m);
	const [c, a, b, d] = args as [string, unknown, unknown, unknown];
	const obj = (v: unknown) => (v ?? {}) as { readonly [k: string]: unknown };
	switch (member.replace(/^db\./, '')) {
		case 'read': return ir.read(cat, c, obj(a));
		case 'get': return ir.get(cat, c, String(a), obj(b));
		case 'aggregate': return ir.aggregate(cat, c, obj(a));
		case 'similar': return a !== null && typeof a === 'object' ? ir.semantic(cat, c, obj(a)) : ir.similar(cat, c, String(a), (b ?? null) as Json, obj(d)); // L-BOLT-123: `{ to }` is search.semantic
		case 'after': return { kind: 'after', collection: c, where: ir.where(cat, c, a) };
		case 'history': return { kind: 'history', collection: c, id: String(a), ...(b === undefined || b === null ? {} : { at: historyAt(b) }) }; // hook:reads — the browser's `at` may be null
		case 'query': return { kind: 'query', collection: c, query: String(a), input: (b ?? null) as Json };
	}
	throw new BoltError('invalid', 'decode', `'${member}' is not a read`);
}

/** `history`'s `at`: an instant, a revision number, or `{ instant } | { revision } | { before }` (rule 17). */
function historyAt(at: unknown): Extract<ReadIR, { kind: 'history' }>['at'] & object {
	if (typeof at === 'string') return { instant: at };
	if (typeof at === 'number') return { revision: at };
	const o = (at ?? {}) as { instant?: unknown; revision?: unknown; before?: unknown };
	if (typeof o.instant === 'string') return { instant: o.instant };
	if (typeof o.revision === 'number') return { revision: o.revision };
	if (typeof o.before === 'string') return { before: o.before };
	throw new BoltError('invalid', 'decode', 'history takes { at: instant | revision | { before } }');
}

/** A declared similarity's bodies run in the guest (§3.3.4): `probe` for the vector, `rerank` over the candidate page. */
function similarityBodies(guest: GuestPort, m: EngineManifest, c: string, name: string, clock: () => string): SimilarityBodies | undefined {
	if (m.collections[c]?.similarity?.[name] === undefined) return undefined;
	const none: Bridge = { cross: async (calls) => calls.map(() => failed(new BoltError('unsupported', 'guest', 'a similarity body makes no ctx call'))) };
	const run = async (kind: 'similarity' | 'rerank', input: Json): Promise<Json> => {
		const id = crypto.randomUUID(), now = clock();
		const g = await guest.invoke({ id, kind, target: `${c}.${name}`, input, budget: { cpuMs: LIMITS.guestCpuMs, crossings: 0, readBytes: 0 },
			ctx: { actor: { kind: 'system', run: id, by: { platform: 'similarity' } }, now, today: now.slice(0, 10), tz: m.workspace.tz, seed: id } }, none);
		if (g.kind === 'ok') return g.output;
		if (kind === 'rerank' && g.kind === 'failed' && g.error.code === 'missingBody') return null;
		throw g.kind === 'failed' ? g.error : new BoltError('refused', 'guest', g.message);
	};
	return {
		probe: async (input) => await run('similarity', input) as Awaited<ReturnType<SimilarityBodies['probe']>>,
		// a similarity without `rerank` keeps the index order (every score undefined)
		rerank: async (input, rows) => { const s = await run('rerank', [input, rows as Json]); return rows.map((_, i) => Array.isArray(s) && typeof s[i] === 'number' ? s[i] : undefined); },
	};
}

const failed = (e: unknown): CrossAnswer => ({ ok: false, error: { kind: 'bolt', code: e instanceof BoltError ? e.code : 'internal',
	message: e instanceof Error ? e.message : String(e) } });

export function engine(config: EngineConfig): Engine {
	const { manifest: m, db } = config;
	const delegate = { history: (r: ReadIR, reader: Parameters<ReadEngine['run']>[1], b: Bindings) => readHistory(db, m, r as Extract<ReadIR, { kind: 'history' }>, reader, b) }; // hook:write
	const guest = config.guest && guestRunner(config.guest, { lowerRead: (member, args) => lowerRead(m, member, args),
		...(config.console === undefined ? {} : { console: config.console }), ...(config.cpu === undefined ? {} : { cpu: config.cpu }),
		...(config.signal === undefined ? {} : { signal: config.signal }) }); // hook:metering, hook:drains
	const similarity = guest && ((c: string, name: string) => similarityBodies(guest, m, c, name, clock));
	/** `/q` and live reads: a collection query is its callable as the caller (rule 31); the workspace calls none. */
	const query = (r: ReadIR, reader: Parameters<ReadEngine['run']>[1], b: Bindings) => {
		if (reader.as !== 'caller') throw new BoltError('unsupported', 'decode', 'a collection query is read as a caller');
		const x = r as Extract<ReadIR, { kind: 'query' }>;
		return e.calls.query({ collection: x.collection, query: x.query, input: x.input, authority: reader.authority, bindings: b, invocationId: crypto.randomUUID(), from: 'client' });
	};
	/** The agent panel's live transcript (§5.9); `/live` checked the caller may read the conversation. */
	const transcript = async (r: ReadIR, reader: Parameters<ReadEngine['run']>[1]) => {
		const x = r as Extract<ReadIR, { kind: 'transcript' }>, staff = reader.as === 'workspace' || isStaff(reader.authority);
		const rows = (await e.agents.transcript(x.conversation, x.from === undefined ? undefined : { from: x.from })).flatMap((row) => transcriptRow(row, staff, x.thread) ?? []);
		return { rows, ...(x.from === undefined ? {} : { from: x.from }), ...(x.thread ? { thread: true } : {}) }; // `thread`: read-only in the panel (rule 61)
	};
	/** The shell inbox (L-BOLT-354): rows as `noticeRow` builds them from a capture, so a live patch matches a re-read. */
	const inbox = async (r: ReadIR) => {
		const [rows] = await db.read([{ text: `SELECT to_jsonb(n) AS r FROM (SELECT id, title, body, link, at, read_at FROM sys_notification WHERE member = $1
			ORDER BY at DESC, id COLLATE "C" DESC LIMIT ${INBOX_LIMIT}) n ORDER BY n.at DESC, n.id COLLATE "C" DESC`, params: [(r as Extract<ReadIR, { kind: 'inbox' }>).member] }]);
		return { rows: rows!.rows.map((x) => noticeRow(x['r'] as RowData)) };
	};
	/**
	 * The agent panel's conversation list: the member's own in-app conversations AND the envoy channel threads they may
	 * read (rule 61), so the panel's picker groups them by where they happen. A member sees a thread they posted in even
	 * when the envoy is not public (the `EXISTS` clause); the `owner` arm covers the in-app ones.
	 */
	const conversations = async (r: ReadIR) => {
		const member = (r as Extract<ReadIR, { kind: 'conversations' }>).member;
		// an envoy declared `public` serves anyone, so its threads are browsable; a private one only by a member who posted in it
		const publicEnvoys = Object.entries(m.envoys ?? {}).filter(([, e]) => (e as { audience?: unknown }).audience === 'public').map(([n]) => n);
		const [rows] = await db.read([{ text: `SELECT to_jsonb(c) AS r FROM sys_conversation c WHERE c.parent IS NULL
				AND (c.owner = $1 OR (c.channel IS NOT NULL AND (c.envoy IN (SELECT jsonb_array_elements_text($2::jsonb))
					OR EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id AND $1 IN (p.author, p."as"->>'member', p."as"->'envoy'->>'member')))))
			ORDER BY updated_at DESC, id COLLATE "C" DESC LIMIT ${CONVERSATIONS}`, params: [member, JSON.stringify(publicEnvoys)] }]);
		return { rows: rows!.rows.map((x) => conversationRow(x['r'] as RowData)) };
	};
	/** `search.semantic`'s probe (L-BOLT-123): a caller's text on the collection's model class; never from a transform. */
	const embed = config.ai?.embed === undefined ? undefined : async (c: string, text: string): Promise<readonly number[]> => {
		const sem = m.models[c]!.search!.semantic!;
		// the probe is read against the run's stored vectors, so it asks the model for the column's own width
		const v = await callPort('embeddings', config.ai, LIMITS.callMs.ai, (p, signal) => p.embed!([text], sem.model, signal, sem.dim),
			(r): r is readonly (readonly number[])[] => Array.isArray(r) && r.length === 1);
		if ('kind' in v) throw new BoltError(v.kind, 'facility', 'message' in v ? v.message : v.reason);
		assertWidth(v, sem);
		return v[0]!;
	};
	const reads = readEngine({ db, manifest: m, delegate: { ...delegate, query, transcript, inbox, conversations }, ...(similarity === undefined ? {} : { similarity }), ...(embed === undefined ? {} : { embed }) });
	/** The transform's bridge: its reads, as the workspace (rule 15), one round trip per crossing (rule 12). */
	const bridge = (inv: Invocation): Bridge & { tables(): readonly string[]; fingerprints(): readonly Fingerprint[] } => {
		const tables = new Set<string>();
		const fp = fingerprinting(db); // hook:write — rule 26: every transform read is fingerprinted
		const own = readEngine({ db: fp.db, manifest: m, delegate, ...(similarity === undefined ? {} : { similarity }) });
		const b: Bindings = { now: inv.ctx.now, today: inv.ctx.today, tz: inv.ctx.tz, params: {} };
		return {
			tables: () => [...tables],
			fingerprints: fp.fingerprints,
			async cross(calls) {
				const batch = calls.flatMap((c) => c.op === 'read' ? [c.read] : []);
				for (const r of batch) tables.add(r.collection);
				let answers: readonly CrossAnswer[];
				try {
					answers = (await own.run(batch, { as: 'workspace' }, b)).map((value): CrossAnswer => ({ ok: true, value }));
				} catch (e) {
					answers = batch.map(() => failed(e));
				}
				let i = 0;
				return calls.map((c) => c.op === 'read' ? answers[i++]! : failed(new BoltError('unsupported', 'guest', `a transform cannot ${c.op}`)));
			},
		};
	};
	const flows = approvals(m, db, { publish: (c) => { live.publish(c); }, clock: () => clock() }); // hook:approvals — seal and restore reach the lane
	const announce = config.deadlines && announceTriggered(m, config.deadlines, config.scope ?? ''); // hook:automations
	const writes: WriteEngine = { manifest: m, db, transforms: new Set(config.transforms ?? []), ...(guest === undefined ? {} : { guest }), bridge,
		approval: config.approval ?? flows.hook, ...(config.admit === undefined ? {} : { admit: config.admit }) };
	const clock = config.clock ?? (() => new Date().toISOString());
	const bound = config.connections === undefined ? undefined : bindConnections(m, config.connections);
	const http = config.http ?? bound?.http;
	const bindings = (): Bindings => { const now = clock(); return { now, today: now.slice(0, 10), tz: m.workspace.tz, params: {} }; };
	const read: ReadEngine['run'] = (batch, reader, b) => reads.run(batch, reader, b);
	const live = liveHub({ manifest: m, bindings, read: (batch, authority, b) => read(batch, { as: 'caller', authority }, b) });
	/** Rules 52a, 66: one place every commit passes — announce the runs it queued, then route it to live views. */
	const committed = (captured: readonly Captured[], b: Bindings, triggers = true): number => {
		if (announce !== undefined && captured.length > 0 && triggers) announce(captured, b); // hook:identity — an erase fires no trigger (rule 50)
		if (triggers && queuesOutbound(m, captured)) wakeAt(b.now); // hook:envoys — outbound queued (rule 61)
		// hook:integrations — rule 16: a row whose embedding went stale queued `bolt.embed` in its statement
		if (captured.some((x) => x.new !== null && x.new['bolt_embedding'] === null)) wakeAt(b.now);
		return live.publish(captured);
	};
	/** Rule 52a: the host's deadline, and the open tick's nudge so a run queued during a long wake is claimed at once. */
	function wakeAt(at: string): void {
		config.deadlines?.announce(config.scope ?? '', at);
		e.runs?.nudge(at);
	}
	const e: Engine = {
		manifest: m, db, live, read, ...(guest === undefined ? {} : { guest }), ...(config.files === undefined ? {} : { files: config.files }),
		async migrate(options = {}) {
			await applyPlan(db, plan(await readApplied(db), m), options);
		},
		authority: (holder, key = JSON.stringify([holder.actor, holder.policies, holder.admin])) => compileAuthority(m, holder, key),
		act: async (request) => {
			const r = await act(writes, request);
			if (r.outcome.kind === 'pendingApproval') wakeAt(request.bindings.now); // hook:gaps — its notices may queue `bolt.push`
			return { ...r, v: committed(r.captured, request.bindings, request.verb !== 'erase') };
		}, // hook:identity
		approvals: { ...flows, // hook:gaps — a decision's notices may queue `bolt.push`
			process: async (i) => { const d = await flows.process(i); wakeAt(i.now); return d; },
			withdraw: async (i) => { const d = await flows.withdraw(i); wakeAt(i.now); return d; } }, // hook:approvals
		...(bound === undefined ? {} : { connections: bound.oauth }),
		calls: undefined as never, integrations: undefined as never, pipelines: undefined as never,
		agents: undefined as never, channels: undefined as never, envoys: undefined as never, triage: undefined as never,
	};
	const calls = callables({ engine: e, ...(guest === undefined ? {} : { guest }), // hook:metering, hook:drains — one runner, one pool
		...(config.deadlines === undefined ? {} : { deadlines: config.deadlines }), scope: config.scope ?? '' });
	e.calls = { ...calls, action: async (r) => { const x = await calls.action(r); return { ...x, v: committed(x.captured, r.bindings) }; } };
	e.integrations = integrations({ engine: e, ...(guest === undefined ? {} : { guest }), ...(http === undefined ? {} : { http }), now: clock,
		announce: (at) => wakeAt(at) }); // hook:integrations — inbound deliveries queue runs
	e.pipelines = pipelines({ engine: e, bindings, ...(guest === undefined ? {} : { guest }), ...(config.files === undefined ? {} : { files: config.files }) });
	// rule 63b: MCP URLs and credentials are the tenant's env (the runs' env and secrets), else the declared defaults
	const tenantEnv = config.runs?.env ?? ((n: string) => (m.workspace.env as { readonly [k: string]: { default?: string } } | undefined)?.[n]?.default);
	e.agents = agents({ engine: e, ...(config.ai === undefined ? {} : { ai: config.ai }), bindings, announce: (at) => wakeAt(at),
		mcp: { env: tenantEnv }, ...config.agent }); // hook:agent — turn takeover (rule 48)
	const decided = { ...(config.ai === undefined ? {} : { ai: config.ai }), ...(config.metering === undefined ? {} : { metering: config.metering }) }; // hook:decisions
	// always present: `filter.options` is pure exposure, and `filter.describe` refuses without a bound `ai`
	e.filters = filterDescribe({ manifest: m, db, read: e.read, clock, ...decided }); // hook:decisions
	e.triage = triage({ engine: e, clock, scope: config.scope ?? '', ...decided, // hook:triage — attachments as metadata only (P37 (3))
		...(config.deadlines === undefined ? {} : { deadlines: config.deadlines }),
		drain: (c, envoy) => envoy ? e.envoys.drain(c) : e.agents.drain(c) });
	({ channels: e.channels, envoys: e.envoys } = messaging({ engine: e, agents: e.agents, clock, ...config.envoys, scope: config.scope ?? '', triage: e.triage,
		...(config.transports === undefined ? {} : { transports: config.transports }), ...(config.files === undefined ? {} : { files: config.files }),
		...(guest === undefined ? {} : { guest }), ...(config.deadlines === undefined ? {} : { deadlines: config.deadlines }), ...(config.epoch === undefined ? {} : { epoch: config.epoch }) }));
	if (config.deadlines !== undefined) e.runs = runs({ engine: e, deadlines: config.deadlines, scope: config.scope ?? '', ...(guest === undefined ? {} : { guest }),
		clock: () => Date.parse(clock()), ...(http === undefined ? {} : { http }), /* hook:decisions */ decide: { db, files: config.files, ai: config.ai, metering: config.metering, clock }, ...(config.agent?.hostTools === undefined ? {} : { hostTools: config.agent.hostTools }), ...config.runs, platform: { ...e.integrations.handlers(), ...e.pipelines.handlers(), ...flows.handlers(), ...e.channels.handlers(), [EMBED]: embedRun(m, db, config.ai?.embed === undefined ? undefined : config.ai as Required<AiPort> /* hook:ai */, { now: clock, announce: (at) => wakeAt(at) }, config.files /* hook:runtime */),
		[NOTICE_PUSH]: noticePush(db, config.transports?.push), ...e.triage.handlers(),
		[TURN_RUN]: (input) => e.agents.turnRun(input, (c, envoy) => envoy ? e.envoys.drain(c) : e.agents.drain(c)), ...config.runs?.platform } }); // hook:approvals, hook:integrations, hook:triage, hook:agent
	return e;
}

// hook:hosting — the host surface of `@norbital-ai/bolt/engine` until `activate` lands (§3.3.10, Appendix D.2):
// the ports and budgets, the PGlite adapter, seed mode, the identity host operations, and the two fetch handlers.
export * from './contracts.ts';
export { openPglite, pgliteDb } from './db/pglite.ts';
export { postgresDb, type PgClient, type PgPool } from './db/postgres.ts';
export { inferFacility } from './agent/ai.ts';
export { openAiChat, type OpenAiChatConfig } from './agent/openai-chat.ts';
export type { AttachmentPort, HostTool, HostToolContext, SandboxPort, WorkspacePort } from './agent/index.ts'; // hook:wiring — hosts bind the agent's options
export { page } from './agent/context.ts'; // hook:wiring — a host's file-reading tool pages like `workspace_read` (rule 62)
export { fileAttachments } from '../shell/data.ts'; // hook:wiring — `read_attachment` over the files port
export { TRIAGE_DEBOUNCE, TRIAGE_DEBOUNCE_MAX, TRIAGE_MAX_WAITS } from './agent/triage.ts'; // hook:triage
export { decisionsSystem1, encodeFiles, refusalOf, structuredSystem1, type DecisionAnswer, type DecisionsApiConfig, type DecisionFile, type DecisionQuestion, type DecisionRequest, type DecisionResult, type DecisionState, type System1Port, type System1Request } from './decisions/index.ts'; // hook:decisions
export type { Json } from '../decl/values.ts';
export type { GeoHit } from '../decl/runtime/facilities.ts';
export { decodeSeed, seed, type SeedPack } from './write/seed.ts';
export { loadPack, readPack, type Pack, type PackJson } from './write/pack.ts';
export { Authorities } from './identity/actor.ts';
export { RateWindows, chargesFor, clientAddress } from './access/rate.ts';
export { founderBootstrap, loadKeys, mint, type IdentityHost, type Session } from './identity/session.ts';
export { membershipRun } from './identity/members.ts'; // §5.11.3 — a host binding `membership` passes it as `runs.platform['bolt.membership']`
export { MEMBERSHIP } from './identity/session.ts';
export { connections, oauth, tokenName, type ConnectionsHost, type OAuth } from './connections.ts'; // hook:hosting — every host's connections (§5.11.4)
export { isPublicWebAddress, makeRequestPage, publicAddresses, publicFetch, WEB_PAGE_BYTE_LIMIT, type Address, type PageWrite } from './net.ts'; // hook:hosting — the outbound guard (L-BOLT-366)
export { sealedSecrets, type Secrets } from './secrets.ts'; // hook:hosting — every host's secrets store (§5.11.4)
export type { GuestProgram } from './guest/runner.ts';
export { guestIsolates, warmLimits } from './guest/runner.ts'; // the host sizes prepared isolates and reads their counts
export { boltHandler, needsGuest } from '../protocol/http.ts';
export { filesHandler } from '../protocol/files.ts';
export { cloudflareTurnstile, devTurnstile, shellHost, type ShellHost, type Turnstile } from '../shell/host.ts';
export { COOKIES } from '../shell/nav.ts';
export { applyPlan, plan, readApplied } from './schema/plan.ts'; // hook:hosting — Appendix D values (rule 69 activation)
// hook:server-cli — what bolt start (bolt-server) reaches through the package instead of source paths
export { catalogOf } from './access/pred.ts';
export { upload } from './callables/upload.ts';
export { resendEvent, telegramUpdate, telegramVerified, whatsappMessage } from './channels/transports.ts';
export { connection, decodeConnection, type ChannelConnection, type ConnectionState, type Pairing } from './channels/connection.ts'; // hook:channels — one contract for every provider
export type { HttpPort } from './integrations/runner.ts';
export * as ir from '../protocol/ir.ts';
export { statusOf } from '../protocol/wire.ts';
export { studioOp, type StudioMergeRequest, type StudioOp, type StudioPort, type StudioState } from '../shell/studio.ts'; // hook:shell (the host's Studio port)
