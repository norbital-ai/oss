// The test kit (§3.3 `/test`, §3.7): a workspace on PGlite (or a given `TenantDb`), compiled from a directory through
// `bolt check` (`root`) or given as a manifest and guest, seeded by restore, with a settable clock, in-memory host fakes,
// and `t.as(actor)` / `t.visitor(app)` / `t.signIn(email)` in the browser form (X-24: `act`, `start` and `upload`
// resolve the Outcome and never reject; `query`, `read` and `get` reject on failure). The engine carries every area
// (callables, runs, integrations, pipelines, live) over the kit's clock and fakes; `t.runDue()` is one deadline wake.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../decl/values.ts';
import type { Holder } from '../engine/access/authority.ts';
import { catalogOf, durationMs } from '../engine/access/pred.ts';
import { chargesFor, RateWindows, type RateKind } from '../engine/access/rate.ts';
import { admitVisitor, forActor } from '../engine/callables/index.ts';
import { upload } from '../engine/callables/upload.ts';
import type { AiPort, AiRequest, AiResponse, Authority, Bindings, Blob, DeadlinesPort, EngineActor, EngineManifest, FilesPort, Outcome, Rows, TenantDb } from '../engine/contracts.ts';
import { openPglite } from '../engine/db/pglite.ts';
import { engine, type Engine, type EngineConfig } from '../engine/index.ts';
import type { GuestProgram } from '../engine/guest/runner.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { memberColumn, memberValue, parseAddress } from '../engine/identity/address.ts';
import * as ir from '../protocol/ir.ts';
import type { RateCharge } from '../engine/write/commit.ts';
import { seed as restore, type SeedPack } from '../engine/write/seed.ts';
import { readPack, type Pack } from '../engine/write/pack.ts';
import type { Verb } from '../engine/write/act.ts';
import { fakeTransport, type FakeTransport } from '../engine/channels/transports.ts';

/**
 * What `testWorkspace` boots: a workspace directory (`root`, compiled by `bolt check`) or a compiled manifest, its seed, clock, database and host fakes.
 */
export type TestOptions = {
	/** A workspace directory, compiled by `bolt check`; any error fails the kit with every diagnostic. */
	root?: string;
	manifest?: EngineManifest; guest?: GuestProgram; transforms?: Iterable<string>;
	/**
	 * With `root`: `'base'` (the default) builds the template's public pack (through `seed/seed.ts` when present),
	 * `'sample'` loads the sample pack `bolt build --bank` wrote, `'none'` seeds nothing. A pack (rows per collection)
	 * is restored as given, with or without `root`.
	 */
	seed?: 'base' | 'sample' | 'none' | SeedPack; now?: string; db?: TenantDb;
	approval?: EngineConfig['approval'];
	/** Integration connections, and run facilities / webhook secrets / platform runs. */
	http?: EngineConfig['http']; runs?: EngineConfig['runs'];
	/** `ctx.convert.document`'s converter: a fake answering fixed bytes, or `documentConverter` over real services. */
	convert?: EngineConfig['convert'];
	/** The agent's model port (a scripted fake in tests), MCP/host tools, and the envoys' notice wording. */
	ai?: EngineConfig['ai']; agent?: EngineConfig['agent']; envoys?: EngineConfig['envoys'];
	/** P33: the meter System 1 decisions report to (System 1 itself is `ai.sys_1`). */ // hook:decisions
	metering?: EngineConfig['metering'];
	/** Host fakes to bind: `ai.cassette` replays recorded provider responses in place of `ai` (never both). */
	fakes?: { ai?: CassetteOptions };
};
/**
 * A provider cassette (L-BOLT-1015): per model class, the responses a provider gave, in order, or the path of a recorded
 * file `{ "turns": AiResponse[] }`. Each is decoded against the `AiResponse` shape when loaded. A class the cassette does
 * not name is unmapped, so a call to it is `Unavailable` (rule 23), never an activation failure; a class played past its
 * last turn throws. `firstPartMs` holds each response back, then its text streams as one delta, as a provider's does.
 */
export type Cassette = { readonly [modelClass: string]: readonly AiResponse[] | string };
/** `fakes.ai`: a provider cassette to replay in place of `ai`, with an optional System 1 and a first-part delay. */
export type CassetteOptions = { cassette: Cassette; sys_1?: AiPort['sys_1']; firstPartMs?: number };
/** A bound cassette: the AI port it plays, every request it answered, and the turns each model class has left. */
export type CassettePlayer = { port: AiPort; requests: AiRequest[]; remaining(): { [modelClass: string]: number } };
/**
 * Options of `As.act`: an idempotency `key`, a retry, the `onConflict` of an upsert, and the revisions the caller observed.
 */
export type ActOptions = { key?: string; retry?: boolean; onConflict?: 'update' | 'keep'; observed?: { readonly [id: string]: number } };
type Q = { readonly [k: string]: unknown };
type Row = { readonly [f: string]: Json };
/**
 * The kit acting as one caller (`t.as(holder)`, `t.visitor(app)`): `act`, `query`, `start`, `upload`, `read` and `get` over the real protocol checks.
 */
export type As = {
	authority: Authority;
	act(callable: string, input: Json, options?: ActOptions): Promise<Outcome>;
	query(callable: string, input?: Json): Promise<Json>;
	start(automation: string, input?: Json, options?: { id?: string }): Promise<Outcome>;
	upload(field: `${string}.${string}`, file: { name: string; mime: string; bytes: Uint8Array; id?: string }): Promise<Outcome>;
	read(collection: string, q: Q): Promise<{ rows: readonly Row[]; next: string | null }>;
	get(collection: string, id: string, q?: Q): Promise<Row | null>;
};
/** In-memory host ports: stored blobs, and every `due_at` announced to the deadlines port (rule 52a). */
export type Fakes = { files: FilesPort & { blobs: Map<string, Uint8Array> }; deadlines: DeadlinesPort & { announced: { scope: string; at: string }[] };
	/** One fake per transport, subscribed to the channels and integrations: `emit` an inbound event, read `sent`. */
	transports: { email: FakeTransport; whatsapp: FakeTransport; telegram: FakeTransport; push: FakeTransport };
	/** The cassette `fakes.ai` bound: every request it answered, and the turns each class has left. */
	ai?: Omit<CassettePlayer, 'port'> };
/**
 * A booted workspace for tests: the engine and its database, host fakes, a settable clock, the statement counter, and callers
 * (`admin`, `member(policies)`, `as`, `visitor`, `signIn`) plus `runDue`, `crash` and `settled` to drive runs and envoys.
 */
export type TestWorkspace = {
	engine: Engine; db: TenantDb; calls: Engine['calls']; fakes: Fakes; manifest: EngineManifest;
	/** Statements through `db` since the last `reset()`: the rule 20 counter. */
	count: { reads: number; writes: number; reset(): void };
	/** The workspace clock every call binds (`now`, `today`, `issuedAt`). */
	clock: { now(): string; set(instant: string): void; advance(duration: string): void };
	admin: Holder;
	/** A member backed by a real `sys_user` row (inserted before the kit's next statement), holding `policies`. */
	member(policies: readonly string[], over?: Partial<Extract<EngineActor, { kind: 'member' }>>): Holder & { id: string };
	as(who: Holder | Authority): As;
	/** A visitor on a page of public app `app` (rule 38d), counted per `ip`. */
	visitor(app: string, options?: { ip?: string }): As;
	/** The member whose `sys_user` row has this email or mobile number, as a session would resolve them (§5.11.2). */
	signIn(address: string): Promise<Authority>;
	/** One deadline wake at the kit's clock: every run due by now runs (rules 48–56). */
	runDue(): Promise<void>;
	/**
	 * Rule 55's crash test: one wake in which the host dies after run `runId`'s body made its effects and before its
	 * end is recorded, then the restart (the boot read requeues the lost lease). The next `runDue()` replays the run
	 * from its journal. Rejects when the run did not execute in that wake.
	 */
	crash(runId: string): Promise<void>;
	/** Every envoy turn an inbound event started has finished and shipped its replies. */
	settled(): Promise<void>;
};

function fakes(): Fakes {
	const blobs = new Map<string, Uint8Array>();
	const announced: { scope: string; at: string }[] = [];
	return {
		files: { blobs,
			async put(bytes, meta): Promise<Blob> { const key = randomUUID(); blobs.set(key, bytes); return { key, bytes: bytes.byteLength, sha256: '', mime: meta.mime }; },
			async get(key) { const b = blobs.get(key); if (b === undefined) throw new Error(`no blob ${key}`); return b; },
			async url(key) { return `memory://${key}`; },
			async remove(key) { blobs.delete(key); } },
		deadlines: { announced, announce(scope, at) { announced.push({ scope, at }); }, settle() {}, teardown() {} },
		transports: { email: fakeTransport('mail'), whatsapp: fakeTransport('wa'), telegram: fakeTransport('tg'), push: fakeTransport('push') },
	};
}

/** The named pack of a workspace directory: `base` built now into the kit's cache, `sample` as `bolt build` left it. */
async function namedPack(root: string, m: EngineManifest, name: 'base' | 'sample'): Promise<Pack> {
	if (name === 'sample') {
		const dir = join(root, '.norbital', 'seed', 'sample');
		if (!existsSync(join(dir, 'pack.json'))) throw new Error(`testWorkspace: no sample pack at ${dir}; run \`bolt build --bank <bank>\` first`);
		return readPack(dir);
	}
	const { buildPacks } = await import('../compiler/artifact/seed.ts');
	const { seedPack } = await import('../compiler/check/index.ts');
	const errors: import('../compiler/check/index.ts').CheckDiagnostic[] = [], cache = join(root, '.norbital', 'cache');
	await buildPacks(root, m, seedPack(root, errors), join(cache, 'test-seed'), { cache }, errors);
	if (errors.length > 0) throw new Error(`testWorkspace: the base pack failed:\n${errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`);
	return readPack(join(cache, 'test-seed', 'base'));
}

/** One compile per workspace root per test process: sources do not change under a run, and a template's check is seconds. */
const compiled = new Map<string, Promise<Awaited<ReturnType<typeof import('../compiler/check/index.ts').check>>>>();
const checked = (root: string) => {
	let c = compiled.get(root);
	if (c === undefined) compiled.set(root, c = import('../compiler/check/index.ts').then(({ check }) => check(root))); // lazy: a manifest-only kit never loads the compiler
	return c;
};

/**
 * Boots a workspace on a fresh in-memory database: compiles `root` with `bolt check` (or takes a manifest), seeds it and binds
 * in-memory host fakes. Every call runs through the same engine and protocol checks as a host.
 * @example
 * const t = await testWorkspace({ root: '.', seed: 'base' });
 * const ann = t.member(['hr_manager']);
 * const r = await t.as(ann).act('leave_requests.create', { employee, period: { from: '2026-03-02', to: '2026-03-03' } });
 * expect(r.kind).toBe('committed');
 */
export async function testWorkspace(o: TestOptions): Promise<TestWorkspace> {
	let { manifest, guest, transforms } = o;
	const seed = o.seed ?? (o.root === undefined ? 'none' : 'base');
	if (o.root !== undefined) {
		const c = await checked(o.root);
		if (c.errors.length > 0 || c.manifest === undefined) throw new Error(`bolt check failed:\n${c.errors.map((d) => `  ${d.code} ${d.message}`).join('\n')}`);
		({ manifest, guest, transforms } = { manifest: c.manifest, guest: c.guest, transforms: c.transforms });
	}
	if (typeof seed === 'string' && seed !== 'none' && o.root === undefined) throw new Error(`testWorkspace: seed '${seed}' needs a root`);
	if (manifest === undefined) throw new Error('testWorkspace takes a root or a manifest');
	const m = manifest;
	const inner = o.db ?? (await openPglite()).db;
	const count = { reads: 0, writes: 0, reset() { count.reads = 0; count.writes = 0; } };
	/** `t.crash`: the run whose end-of-run statement the dying host never sends. */
	let crashing: string | null = null;
	const CRASH = 'crash: the host died before the run recorded its end';
	/** `t.member()`'s `sys_user` inserts: every statement through `db` waits for them, uncounted. */
	let members: Promise<unknown> = Promise.resolve();
	const db: TenantDb = {
		read: async (s, signal) => (await members, count.reads++, inner.read(s, signal)),
		write: async (s, lock, signal): Promise<Rows> => {
			await members;
			if (crashing !== null && /UPDATE sys_run s SET state = \$/.test(s.text) && JSON.stringify(s.params).includes(crashing)) {
				crashing = null;
				throw new Error(CRASH);
			}
			return (count.writes++, inner.write(s, lock, signal));
		},
		transaction: async (body, lock) => (await members, inner.transaction(body, lock)),
	};
	if (o.ai !== undefined && o.fakes?.ai !== undefined) throw new Error('testWorkspace: give `ai` or `fakes.ai`, not both');
	const cassette = o.fakes?.ai === undefined ? undefined : cassettePlayer(o.fakes.ai);
	const f: Fakes = { ...fakes(), ...(cassette === undefined ? {} : { ai: { requests: cassette.requests, remaining: cassette.remaining } }) };
	const ai = o.ai ?? cassette?.port;
	let now = o.now ?? '2026-09-25T10:00:00.000Z';
	const e = engine({ manifest: m, db, ...(guest === undefined ? {} : { guest }), ...(transforms === undefined ? {} : { transforms }),
		...(o.approval === undefined ? {} : { approval: o.approval }), console: () => {}, deadlines: f.deadlines, scope: 'test', clock: () => now,
		files: f.files, ...(o.http === undefined ? {} : { http: o.http }), ...(o.convert === undefined ? {} : { convert: o.convert }), ...(o.runs === undefined ? {} : { runs: o.runs }), transports: f.transports,
		...(ai === undefined ? {} : { ai }), ...(o.agent === undefined ? {} : { agent: o.agent }), ...(o.envoys === undefined ? {} : { envoys: o.envoys }),
		...(o.metering === undefined ? {} : { metering: o.metering }) }); // hook:decisions
	await e.migrate({ accept: true });
	await e.channels.activate();
	e.channels.subscribe();
	e.integrations.subscribe(Object.values(f.transports), randomUUID);
	// hook:runtime — a pack's `{ asset }` files land in the fake store with their `sys_file` rows, as `bolt start` loads them
	if (seed === 'base' || seed === 'sample') await (await import('../compiler/artifact/read.ts')).loadPackWithAssets(db, m, await namedPack(o.root!, m, seed), f.files, now);
	else if (typeof seed === 'object' && Object.keys(seed).length > 0) await restore(m, db, seed, now);
	await e.runs!.boot();
	count.reset();
	const calls = e.calls;
	const bindings = (): Bindings => ({ now, today: now.slice(0, 10), tz: m.workspace.tz, params: {} });
	const cat = catalogOf(m);
	const authorities = new Authorities(m, 'test');
	const windows = new RateWindows();
	let admin: Holder | undefined;
	const member = (policies: readonly string[], over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}): Holder & { id: string } => {
		const actor = { kind: 'member' as const, id: randomUUID(), email: null, phone: null, external: false, teams: [], teamPath: [], admin: false, party: null, ...over };
		// a seeded member of the same id or email keeps its row
		const row = { text: `INSERT INTO sys_user (id, email, phone, name, kind, admin, party) VALUES ($1, $2, $7, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING`,
			params: [actor.id, actor.email, actor.email ?? actor.phone ?? actor.id, actor.external ? 'external' : 'staff', actor.admin, actor.party === null ? null : JSON.stringify(actor.party), actor.phone] };
		members = members.then(() => inner.write(row));
		return { actor, id: actor.id, policies, admin: actor.admin };
	};

	/** Rule 38: charge every applicable bucket in memory first; a refusal counts. Acts persist their charges. */
	const charge = (authority: Authority, kind: RateKind, ip: string | undefined): { refused: Outcome } | { rate: RateCharge[] } => {
		const cs = chargesFor(authority, [kind], { ...(authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}), ...(ip === undefined ? {} : { ip }) });
		const nowMs = Date.parse(now), verdict = windows.charge(cs, nowMs);
		if (!verdict.ok) return { refused: { kind: 'refused', code: 'rateLimited', message: `Too many requests; retry in ${verdict.retryAfter} s.` } };
		return { rate: cs.map((c) => ({ rule: c.rule, bucket: c.bucket, limit: c.limit, windowStart: new Date(nowMs - (nowMs % c.windowMs)).toISOString() })) };
	};
	const asAuthority = (authority: Authority, ip?: string): As => {
		const reader = { as: 'caller', authority } as const;
		const visitor = authority.actor.kind === 'visitor';
		const gate = (s: Parameters<typeof admitVisitor>[1]) => { const no = admitVisitor(authority, s); if (no !== null) throw Object.assign(new Error(no.message), { code: no.code }); };
		const reads = (): void => { if (visitor) { const c = charge(authority, 'read', ip); if ('refused' in c) throw Object.assign(new Error('rateLimited'), { code: 'rateLimited' }); } };
		return {
			authority,
			async act(callable, input, options = {}) {
				const dot = callable.lastIndexOf('.'), collection = callable.slice(0, dot), verb = callable.slice(dot + 1);
				let rate: RateCharge[] = [];
				if (visitor) {
					const c = charge(authority, 'register', ip);
					if ('refused' in c) return c.refused;
					rate = c.rate;
					const no = admitVisitor(authority, { act: collection, verb });
					if (no !== null) return no;
				}
				const { key = randomUUID(), ...rest } = options;
				const common = { input, key, issuedAt: now, authority, bindings: bindings(), invocationId: randomUUID(), rate, ...rest };
				const r = ['create', 'update', 'delete', 'upsert'].includes(verb)
					? await e.act({ collection, verb: verb as Verb, ...common })
					: await calls.action({ collection, action: verb, ...common, from: 'client' });
				// an unknown outcome is a crash the caller cannot see; a test sees it
				if (r.outcome.kind === 'unknown' && 'error' in r && r.error !== undefined) throw r.error;
				return forActor(r.outcome, authority.actor);
			},
			async query(callable, input = {}) {
				reads();
				const dot = callable.lastIndexOf('.');
				return calls.query({ collection: callable.slice(0, dot), query: callable.slice(dot + 1), input, authority, bindings: bindings(), invocationId: randomUUID(), from: 'client' });
			},
			async start(automation, input = {}, options = {}) {
				return forActor(await calls.start({ automation, input, id: options.id ?? randomUUID(), authority, bindings: bindings() }), authority.actor);
			},
			async upload(field, file) {
				const c = charge(authority, 'upload', ip);
				if ('refused' in c) return c.refused;
				const [collection, name] = field.split('.') as [string, string];
				return upload({ manifest: m, db, files: f.files }, { id: file.id ?? randomUUID(), collection, field: name, name: file.name, mime: file.mime,
					bytes: file.bytes, authority, now, rate: c.rate });
			},
			read: async (collection, q) => { gate({ read: collection }); reads(); return (await e.read([ir.read(cat, collection, q)], reader, bindings()))[0] as never; },
			get: async (collection, id, q) => { gate({ read: collection }); reads(); return (await e.read([ir.get(cat, collection, id, q)], reader, bindings()))[0] as never; },
		};
	};

	const t: TestWorkspace = {
		engine: e, db, calls, fakes: f, manifest: m, count, member,
		// backed by a `sys_user` row on first use, so a kit that never names its admin leaves `founder.bootstrap` open
		get admin() { return (admin ??= member([], { admin: true })); },
		clock: { now: () => now, set(instant) { now = new Date(instant).toISOString(); }, advance(d) { now = new Date(Date.parse(now) + durationMs(d)).toISOString(); } },
		as: (who) => asAuthority('collections' in who ? who : e.authority(who)),
		visitor: (app, options = {}) => asAuthority(authorities.visitor(app, randomUUID()), options.ip ?? '203.0.113.7'),
		async signIn(address) {
			const a0 = parseAddress(address);
			const [res] = a0 === null ? [{ rows: [] }] : await db.read([{ text: `SELECT id FROM sys_user WHERE ${memberColumn(a0, '$1')}`, params: [memberValue(a0)] }]);
			const id = res!.rows[0]?.['id'];
			const a = typeof id === 'string' ? await authorities.member(db, id) : null;
			if (a === null) throw new Error(`no active member with the address ${address}`);
			return a;
		},
		runDue: () => e.runs!.tick(),
		async crash(runId) {
			crashing = runId;
			try {
				await e.runs!.tick();
			} catch (err) {
				if (!(err instanceof Error && err.message === CRASH)) throw err;
			}
			const died = crashing === null;
			crashing = null;
			if (!died) throw new Error(`run ${runId} did not run in this wake`);
			await e.runs!.boot();
		},
		settled: () => e.envoys.settled(),
	};
	return t;
}

const FINISH = new Set(['stop', 'tool', 'cut']);
/** One recorded response, checked against `AiResponse` (a cassette is test input: a malformed one fails loudly). */
function decodeResponse(v: unknown, where: string): AiResponse {
	const r = v as { content?: unknown; toolCalls?: unknown; finish?: unknown; usage?: { input?: unknown; output?: unknown } } | null;
	const ok = typeof r === 'object' && r !== null && 'content' in r && Array.isArray(r.toolCalls)
		&& r.toolCalls.every((c: { id?: unknown; name?: unknown } | null) => typeof c?.id === 'string' && typeof c.name === 'string' && 'input' in c)
		&& typeof r.finish === 'string' && FINISH.has(r.finish) && typeof r.usage?.input === 'number' && typeof r.usage.output === 'number';
	if (!ok) throw new Error(`cassette: ${where} is not an AiResponse ({ content, toolCalls: [{ id, name, input }], finish: stop|tool|cut, usage: { input, output } })`);
	return r as AiResponse;
}

function cassettePlayer(o: CassetteOptions): CassettePlayer {
	const turns = new Map(Object.entries(o.cassette).map(([cls, rec]): [string, AiResponse[]] => {
		const list = typeof rec === 'string' ? (JSON.parse(readFileSync(rec, 'utf8')) as { turns?: unknown }).turns : rec;
		if (!Array.isArray(list)) throw new Error(`cassette: '${cls}' ${typeof rec === 'string' ? `(${rec}) has no turns array` : 'is not a list of responses'}`);
		return [cls, list.map((r, i) => decodeResponse(r, `'${cls}' turn ${i}`))];
	}));
	const requests: AiRequest[] = [];
	return {
		requests,
		remaining: () => Object.fromEntries([...turns].map(([cls, l]) => [cls, l.length])),
		port: {
			sys_1: o.sys_1 ?? respondSystem1,
			sys_2: {
				models: [...turns.keys()],
				async infer(request, signal, onDelta) {
					requests.push(request);
					const next = turns.get(request.model)?.shift();
					if (next === undefined) throw new Error(`cassette: '${request.model}' has no turn left (${requests.length} requests played)`);
					if (o.firstPartMs !== undefined) await new Promise((r) => setTimeout(r, o.firstPartMs));
					signal.throwIfAborted();
					if (typeof next.content === 'string' && next.content !== '') onDelta?.(next.content);
					return next;
				},
			},
		},
	};
}

/** hook:decisions — a System 1 for fakes that do not exercise decisions: triage answers `respond`, anything else its first option. */
export const respondSystem1: import('../engine/decisions/index.ts').System1Port = {
	async ask(r) {
		const answer = (q: import('../engine/decisions/index.ts').DecisionQuestion): import('../engine/decisions/index.ts').DecisionAnswer => q.type === 'noul' ? { type: 'noul', noul: 0 }
			: q.type === 'choice' ? { type: 'choice', choice: 'respond' in q.criteria ? 'respond' : Object.keys(q.criteria)[0]!, confidence: 1, probabilities: {} }
				: { type: 'score', score: 0, level: 0, confidence: 1, probabilities: {}, legend: {} };
		return { costUsd: 0, provider: 'test', answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, answer(q)])) };
	},
};

/** `bolt check` on a directory, for a global setup that compiles once in node and hands DOM suites the result. */
export const check = async (dir: string): Promise<import('../compiler/check/index.ts').CheckResult> => (await import('../compiler/check/index.ts')).check(dir);
/** The `bolt dev` host, for an end-to-end suite that drives a real browser against it. */
export const dev = async (root: string, o: import('../cli/dev.ts').DevOptions): Promise<import('../cli/dev.ts').DevHost> => (await import('../cli/dev.ts')).dev(root, o);
