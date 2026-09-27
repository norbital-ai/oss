// `sys_1` (P33, P35, P37): the AI facility's cheap structured-decision half. The `ai` port carries `sys_1.ask`, `sys_2`
// (the LLM) and optionally `embed`. A `sys_1` call is the provider's decision model (P37): a structured, text-only
// `state` (P37 (3): no `FileRef`, refused `invalid` before any call) and a record of typed questions (`noul`, `choice`,
// `score`) answered in parallel, blind to each other. No fallback and no confidence threshold: a use takes the answer
// as given and a failure is an ordinary typed `FacilityError`. Limits are the provider's: Bolt caps no question,
// option, level or state size; a provider's refusal passes through as `invalid`, `tooLarge` or `unsupported`.
// Uses: triage (rule 60a), AI filtering (rule 16a), `ctx.ai.sys_1.decide` (P36). Every call is one `decision.made`
// event and one metering report (§5.12). `ctx.ai.embed` (P39) lives here too: its `FileRef` inputs are checked and read
// by the engine and handed to the host as `$file`, which the host only encodes (`encodeFiles`).
import { randomUUID } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import type { DecisionQuestion, DecisionState, FacilityError } from '../../decl/runtime/facilities.ts';
import { callPort, LIMITS, type AiPort, type AiRequest, type Authority, type Bindings, type CrossAnswer, type EmbedInput, type EngineManifest, type FilesPort, type MeteringPort, type ReadEngine, type TenantDb } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import * as ir from '../../protocol/ir.ts';

export type { DecisionQuestion, DecisionState };
/** The port's answer to one question; a score's `level` is the index of its most probable level. */
export type DecisionAnswer =
	| { type: 'noul'; noul: number }
	| { type: 'choice'; choice: string; confidence: number; probabilities: { readonly [option: string]: number } }
	| { type: 'score'; score: number; level: number; confidence: number; probabilities: { readonly [level: string]: number }; legend: { readonly [level: string]: string } };
export type DecisionRequest = { state: DecisionState; questions: { readonly [id: string]: DecisionQuestion } };
export type DecisionResult = { answers: { readonly [id: string]: DecisionAnswer }; costUsd: number; provider: string; tokens?: { input: number; output: number } };
/** A file as the host receives it (`sys_2`, `embed`): checked, digested and read by the engine; the host encodes it. */
export type DecisionFile = Exclude<EmbedInput, string>;
/** `sys_1` takes text only (P37 (3)): the request is the decision request as given. */
export type System1Request = DecisionRequest;
/** `sys_1`: every question answered, a choice one of its criteria keys, a score's level one of its levels. */
export interface System1Port {
	/** A provider refusal is thrown as a `FacilityError` value (`invalid`, `tooLarge`, `unsupported`, `rateLimited`). */
	ask(request: System1Request, signal: AbortSignal): Promise<DecisionResult>;
	/** The provider's most options per `choice` question, when it has one (Bolt's own callers stay under it). */
	readonly maxChoices?: number;
}
export type DecisionUse = 'triage' | 'filter' | 'author';
/** Engine constant (rule 72's budget row): one `sys_1` call's wall. */
export const DECISION_CALL_MS = 3_000;

const isObj = (v: unknown): v is { readonly [k: string]: unknown } => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const FILE_KEYS = new Set(['id', 'name', 'mime', 'size', 'bytes', 'sha256']);
/** A `FileRef` leaf as it crosses the guest boundary: `{ id, name, mime }` (an upload's `size`/`bytes`/`sha256` may ride along). */
const isFileRef = (v: unknown): v is { id: string; name: string; mime: string } =>
	isObj(v) && typeof v['id'] === 'string' && typeof v['name'] === 'string' && typeof v['mime'] === 'string' && Object.keys(v).every((k) => FILE_KEYS.has(k));
const isDecisionFile = (v: unknown): v is DecisionFile => isObj(v) && isObj(v['$file']) && v['$file']['bytes'] instanceof Uint8Array;
const walk = (v: unknown, leaf: (x: unknown) => unknown): unknown => {
	const r = leaf(v);
	if (r !== undefined) return r;
	if (Array.isArray(v)) return v.map((x) => walk(x, leaf));
	return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, leaf)])) : v;
};
/** Every `FileRef` id a value names. */
export const fileIds = (value: unknown): string[] => {
	const out = new Set<string>();
	walk(value, (x) => isFileRef(x) ? (out.add(x.id), x) : undefined);
	return [...out];
};
/** Hosts: the input with each `$file` replaced by `encode(file, n)`, the provider's format for it (n counts from 0). */
export const encodeFiles = (input: unknown, encode: (file: DecisionFile['$file'], n: number) => Json): Json => {
	let n = 0;
	return walk(input, (x) => isDecisionFile(x) ? encode(x.$file, n++) : undefined) as Json;
};

type FileRow = { key: string; sha256: string; name: string; mime: string; field: string };
/** The `sys_file` rows a value names, by id (a missing one is absent). */
export async function storedFiles(db: TenantDb, value: unknown): Promise<Map<string, FileRow>> {
	const ids = fileIds(value);
	if (ids.length === 0) return new Map();
	const [r] = await db.read([{ text: `SELECT id, key, sha256, name, mime, coalesce(field, '') AS field FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, params: [JSON.stringify(ids)] }]);
	return new Map(r!.rows.map((x) => [String(x['id']), { key: String(x['key']), sha256: String(x['sha256']), name: String(x['name']), mime: String(x['mime']), field: String(x['field']) }]));
}
/**
 * Whether `authority` may read a stored file, as `GET /__bolt/files/<id>` checks: an administrator, or a row holding it in
 * its collection's file field that the caller reads with that field unmasked. ponytail: ≤ 20 holders are tried.
 * A message attachment (`sys_message.files`) is its uploader's, and then the conversation's: its owner, a member who
 * posted in it (in the app or as a linked channel sender), and staff for a channel conversation.
 */
export async function readableFile(o: { manifest: EngineManifest; db: TenantDb; read: ReadEngine['run']; authority: Authority; bindings: Bindings }, id: string, owner: string): Promise<boolean> {
	if (owner === 'sys_message.files') {
		const a = o.authority.actor;
		if (a.kind !== 'member') return false;
		const [r] = await o.db.read([{ text: `SELECT 1 FROM sys_file WHERE id = $1 AND field = 'sys_message.files' AND created_by = $2
			UNION ALL SELECT 1 FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation WHERE (m.files @> $3::jsonb OR m.files @> $4::jsonb)
				AND (c.owner = $2 OR ($7 AND c.channel IS NULL) OR ($5 AND c.channel IS NOT NULL AND c.envoy IN (SELECT jsonb_array_elements_text($6::jsonb))) OR EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id
					AND ($2 IN (p."as"->>'member', p."as"->'envoy'->>'member'))))
			LIMIT 1`, params: [id, a.id, JSON.stringify([{ id }]), JSON.stringify([{ file: { id } }]), !a.external,
				// a channel thread's files: participants (below) and staff on a `public` envoy only (own, participant, public)
				JSON.stringify(Object.entries(o.manifest.envoys).filter(([, e]) => (e as { audience?: unknown }).audience === 'public').map(([name]) => name)),
				// admins read in-app files; an envoy thread's only through the rule above (owner 2026-09-26)
				o.authority.admin] }]);
		return r!.rows.length > 0;
	}
	if (o.authority.admin) return true;
	const [collection, field] = owner.split('.') as [string, string | undefined];
	// a pipeline's import upload and export file (`<c>.$import`, `<c>.$export`): the member who ran it
	if (field === '$import' || field === '$export') {
		if (o.authority.actor.kind !== 'member') return false;
		const [r] = await o.db.read([{ text: `SELECT 1 FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3`, params: [id, owner, o.authority.actor.id] }]);
		return r!.rows.length > 0;
	}
	if (field === undefined || (o.manifest.models[collection]?.fields[field] as { kind?: string } | undefined)?.kind !== 'file' || o.authority.collections[collection] === undefined) return false;
	const [holders] = await o.db.read([{ text: `SELECT id::text AS id FROM "${collection}" WHERE "${field}" @> $1::jsonb OR "${field}" @> $2::jsonb LIMIT 20`,
		params: [JSON.stringify({ id }), JSON.stringify([{ id }])] }]);
	const cat = catalogOf(o.manifest);
	for (const h of holders!.rows) {
		const [got] = await o.read([ir.get(cat, collection, String(h['id']), { select: { [field]: true } })], { as: 'caller', authority: o.authority }, o.bindings);
		if (JSON.stringify((got as { readonly [k: string]: Json } | null)?.[field] ?? null).includes(id)) return true;
	}
	return false;
}

const TYPED = new Set(['invalid', 'tooLarge', 'unsupported', 'rateLimited', 'upstream', 'timeout']);
const isTyped = (e: unknown): e is FacilityError => isObj(e) && TYPED.has(String(e['kind'])) && typeof e['message'] === 'string';
/** A provider's HTTP refusal as the typed error it maps to (P37); `undefined` is an ordinary failure. Hosts share it. */
export function refusalOf(status: number, body: string): FacilityError | undefined {
	if (status < 400 || status >= 500) return undefined;
	const message = body.slice(0, 500) || `the provider refused the request (${status})`;
	if (status === 413 || /context.{0,20}(length|window|limit)|too (long|large)|maximum.{0,20}(tokens|context)/i.test(body)) return { kind: 'tooLarge', message, status };
	if (status === 429) return { kind: 'rateLimited', message, status };
	if (status === 415 || /unsupported|not supported|does not support/i.test(body)) return { kind: 'unsupported', message, status };
	return { kind: 'invalid', message, status };
}

const unit = (x: unknown) => typeof x === 'number' && x >= 0 && x <= 1;
function answered(q: DecisionQuestion, a: DecisionAnswer | undefined): boolean {
	if (a === undefined || a.type !== q.type) return false;
	if (a.type === 'noul') return unit(a.noul);
	if (a.type === 'choice') return Object.hasOwn(q.criteria, a.choice) && typeof a.confidence === 'number' && isObj(a.probabilities);
	return Number.isInteger(a.level) && a.level >= 0 && a.level < (q.criteria as readonly string[]).length && typeof a.score === 'number'
		&& typeof a.confidence === 'number' && isObj(a.probabilities) && isObj(a.legend);
}

/** One `sys_1` call: every question answered within its criteria, or a typed failure. Never throws. */
export async function ask(ai: AiPort | undefined, request: DecisionRequest): Promise<DecisionResult | FacilityError> {
	// P37 (3): the state is text only; a file reaching the engine is refused before any call
	if (fileIds(request.state).length > 0) return { kind: 'invalid', message: 'a sys_1 state is text only: describe a file (name, mime, size, caption), never pass it' };
	const valid = (r: unknown): r is DecisionResult | FacilityError => isTyped(r) || (isObj(r) && isObj(r['answers']) && typeof r['costUsd'] === 'number');
	const d = await callPort('sys_1', ai?.sys_1, DECISION_CALL_MS,
		(p, signal) => p.ask(request, signal).catch((e: unknown) => isTyped(e) ? { kind: e.kind, message: (e as { message: string }).message } as FacilityError : Promise.reject(e)), valid);
	return failed(d) || Object.entries(request.questions).every(([id, q]) => answered(q, d.answers[id])) ? d
		: { kind: 'invalid', message: 'sys_1 answered outside the offered criteria' };
}
export const failed = (r: DecisionResult | FacilityError): r is FacilityError => 'kind' in r;
export const choiceOf = (r: DecisionResult, id: string): string | undefined => { const a = r.answers[id]; return a?.type === 'choice' ? a.choice : undefined; };
export const noulOf = (r: DecisionResult, id: string): number => { const a = r.answers[id]; return a?.type === 'noul' ? a.noul : 0; };

/** The `decision.made` attributes (§5.12) of one call, answered or failed. */
export const decisionEvent = (use: DecisionUse, request: DecisionRequest, r: DecisionResult | FacilityError): Json => ({
	use, system: 1, questions: Object.keys(request.questions),
	...(failed(r) ? { error: r.kind } : { answers: r.answers, costUsd: r.costUsd, provider: r.provider, ...(r.tokens === undefined ? {} : { tokens: r.tokens }) }),
}) as Json;
/** Reports an answered call's cost on the AI meter, keyed by the call id. */
export const meter = (metering: MeteringPort | undefined, r: DecisionResult | FacilityError, call: string) =>
	failed(r) ? Promise.resolve() : (metering?.record('ai', r.costUsd, `decision:${call}`) ?? Promise.resolve()).catch(() => {});

const QTYPES = new Set(['noul', 'choice', 'score']);
const wellFormed = (q: unknown): q is DecisionQuestion => isObj(q) && QTYPES.has(String(q['type'])) && typeof q['instructions'] === 'string' && (
	q['type'] === 'score' ? Array.isArray(q['criteria']) && q['criteria'].length > 0 && q['criteria'].every((l) => typeof l === 'string')
		: isObj(q['criteria']) && Object.values(q['criteria']).every((d) => typeof d === 'string')
			&& (q['type'] === 'noul' ? Object.keys(q['criteria']).sort().join() === 'false,true' : Object.keys(q['criteria']).length > 0));

export type AuthorDecideConfig = { db: TenantDb; files?: FilesPort | undefined; ai?: AiPort | undefined; metering?: MeteringPort | undefined; clock: () => string };
/**
 * `ctx.ai.sys_1.decide` (P36): the state and the literals go to one `sys_1` call unchanged; a score's `level` comes back
 * as the level itself. One `decision.made` (`use: 'author'`) with the automation and run, and one metering report.
 */
export async function authorDecide(cfg: AuthorDecideConfig, input: Json, run: { id: string; automation: string }): Promise<CrossAnswer> {
	const x = input as { state?: unknown; questions?: unknown } | null;
	if (!isObj(x) || !isObj(x.state) || !isObj(x.questions) || Object.keys(x.questions).length === 0 || !Object.values(x.questions).every(wellFormed))
		return { ok: false, error: { kind: 'invalid', message: 'decide takes { state: {…}, questions: { <id>: { type, instructions, criteria } } }' } };
	const request = x as DecisionRequest;
	const d = cfg.ai === undefined ? { kind: 'unavailable', facility: 'ai', reason: 'the host provides no ai' } as const : await ask(cfg.ai, request);
	const call = randomUUID();
	await cfg.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES ($1::timestamptz, $2, 'decision.made', $3, $4::jsonb)`,
		params: [cfg.clock(), failed(d) ? 'warn' : 'info', run.id, JSON.stringify({ ...decisionEvent('author', request, d) as object, automation: run.automation, run: run.id })] });
	await meter(cfg.metering, d, call);
	if (failed(d)) return { ok: false, error: d };
	const answers = Object.fromEntries(Object.entries(d.answers).map(([id, a]) =>
		[id, a.type === 'score' ? { ...a, level: (request.questions[id]!.criteria as readonly string[])[a.level]! } : a]));
	return { ok: true, value: { answers, costUsd: d.costUsd } as Json };
}

/**
 * `ctx.ai.embed` (P39): `(inputs, { model? })`, one vector per input. A `FileRef` input the run may read (`readable`, as
 * `GET /__bolt/files/<id>` checks) is read here and handed to the host as `$file`; an unreadable one refuses the call
 * before it is made. The host only encodes (`encodeFiles`).
 */
export async function authorEmbed(cfg: AuthorDecideConfig, args: readonly Json[], readable: (id: string, field: string) => Promise<boolean>): Promise<CrossAnswer> {
	const inputs = args[0], model = (args[1] as { model?: Json } | null | undefined)?.model, dimensions = (args[1] as { dimensions?: Json } | null | undefined)?.dimensions;
	if (!Array.isArray(inputs) || !inputs.every((x) => typeof x === 'string' || isFileRef(x)))
		return { ok: false, error: { kind: 'invalid', message: 'embed takes a list of strings and FileRefs' } };
	if (cfg.ai?.embed === undefined) return { ok: false, error: { kind: 'unavailable', facility: 'ai.embed', reason: 'the host provides no embeddings' } };
	const rows = await storedFiles(cfg.db, inputs);
	const resolved: EmbedInput[] = [];
	for (const x of inputs) {
		if (typeof x === 'string') { resolved.push(x); continue; }
		const id = (x as { id: string }).id, f = rows.get(id);
		if (f === undefined || !await readable(id, f.field)) return { ok: false, error: { kind: 'invalid', message: `this run cannot read file ${id}` } };
		if (cfg.files === undefined) return { ok: false, error: { kind: 'unavailable', facility: 'files', reason: 'the host provides no file reads' } };
		try {
			resolved.push({ $file: { name: f.name, mime: f.mime, sha256: f.sha256, bytes: await cfg.files.get(f.key, LIMITS.storedFileBytes, AbortSignal.timeout(LIMITS.callMs.other)) } });
		} catch (e) {
			return { ok: false, error: { kind: 'upstream', message: e instanceof Error ? e.message : 'a file could not be read' } };
		}
	}
	const v = await callPort('ai.embed', cfg.ai, LIMITS.callMs.ai, (p, signal) => p.embed!(resolved, typeof model === 'string' ? model : 'default', signal, typeof dimensions === 'number' ? dimensions : undefined),
		(r): r is readonly (readonly number[])[] => Array.isArray(r) && r.length === resolved.length);
	return 'kind' in v ? { ok: false, error: v } : { ok: true, value: v as unknown as Json };
}

const normalized = (keys: readonly string[], raw: unknown): { [k: string]: number } => {
	const p = keys.map((k) => { const v = isObj(raw) ? Number(raw[k]) : 0; return Number.isFinite(v) && v > 0 ? v : 0; });
	const sum = p.reduce((a, b) => a + b, 0);
	return Object.fromEntries(keys.map((k, i) => [k, sum === 0 ? 1 / keys.length : p[i]! / sum]));
};
const argmax = (p: { readonly [k: string]: number }): [string, number] => Object.entries(p).reduce((a, b) => b[1] > a[1] ? b : a);
/** A provider's stated distribution as the port's answer: the most probable option or level, its probability the confidence. */
export function decodeAnswer(q: DecisionQuestion, raw: unknown): DecisionAnswer {
	const a = isObj(raw) ? raw : {};
	if (q.type === 'noul') { const n = Number(a['noul']); return { type: 'noul', noul: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0 }; }
	if (q.type === 'choice') {
		const probabilities = normalized(Object.keys(q.criteria), a['probabilities']);
		const [choice, confidence] = argmax(probabilities);
		return { type: 'choice', choice, confidence, probabilities };
	}
	const probabilities = normalized(q.criteria.map((_, i) => String(i)), a['probabilities']);
	const [level, confidence] = argmax(probabilities);
	return { type: 'score', score: Object.entries(probabilities).reduce((s, [i, p]) => s + Number(i) * p, 0), level: Number(level), confidence, probabilities,
		legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])) };
}

/**
 * A `sys_1` built on any model with structured output (a self-host's choice, text input suffices; another host binds its
 * own): one `infer` on `model` whose JSON schema asks a noul's probability of true and a choice's or score's
 * distribution. `costUsd` is the call's reported cost.
 */
export function structuredSystem1(infer: AiPort['sys_2']['infer'], model: string): System1Port {
	return {
		async ask(r, signal) {
			const state = r.state;
			const qs = Object.entries(r.questions);
			const dist = (keys: readonly string[]) => ({ type: 'object', additionalProperties: false, required: keys,
				properties: Object.fromEntries(keys.map((k) => [k, { type: 'number', minimum: 0, maximum: 1 }])) });
			const schema = (q: DecisionQuestion): Json => q.type === 'noul'
				? { type: 'object', additionalProperties: false, required: ['noul'], properties: { noul: { type: 'number', minimum: 0, maximum: 1 } } }
				: { type: 'object', additionalProperties: false, required: ['probabilities'],
					properties: { probabilities: dist(q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))) } };
			const criteria = (q: DecisionQuestion) => q.type === 'noul' ? `true: ${q.criteria.true}; false: ${q.criteria.false}`
				: q.type === 'choice' ? Object.entries(q.criteria).map(([k, d]) => `"${k}": ${d}`).join('; ')
					: `levels, lowest first: ${q.criteria.map((l, i) => `${i} = ${l}`).join('; ')}`;
			const request: AiRequest = { model,
				system: 'Answer each question on its own from the state alone, with JSON only: a noul is the probability that it is true; a choice or a score is a probability for every option or level.',
				messages: [{ role: 'user', content: [`State: ${JSON.stringify(state)}`,
					'Questions:', ...qs.map(([id, q]) => `- ${id} (${q.type}): ${q.instructions} [${criteria(q)}]`)].join('\n') }],
				output: { type: 'object', additionalProperties: false, required: qs.map(([id]) => id), properties: Object.fromEntries(qs.map(([id, q]) => [id, schema(q)])) } };
			let out;
			try {
				out = await infer(request, signal);
			} catch (e) {
				const status = isObj(e) && typeof e['status'] === 'number' ? e['status'] : undefined;
				const refusal = status === undefined ? undefined : refusalOf(status, e instanceof Error ? e.message : '');
				throw refusal ?? e;
			}
			const c = isObj(out.content) ? out.content : {};
			return { answers: Object.fromEntries(qs.map(([id, q]) => [id, decodeAnswer(q, c[id])])), costUsd: out.usage.cost ?? 0, provider: model,
				tokens: { input: out.usage.input, output: out.usage.output } };
		},
	};
}

export type DecisionsApiConfig = { url: string; model: string; apiKey: string; timeoutMillis?: number | undefined };
const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** A Decisions API answer to one question as the port's, or `undefined` when it is not one; a score gains `level`. */
function decisionsAnswer(q: DecisionQuestion, a: unknown): DecisionAnswer | undefined {
	if (!isObj(a)) return undefined;
	const probabilities = isObj(a['probabilities']) ? a['probabilities'] as { [k: string]: number } : {};
	if (q.type === 'noul') { const noul = finite(a['noul']); return noul === undefined ? undefined : { type: 'noul', noul }; }
	const confidence = finite(a['confidence']);
	if (confidence === undefined) return undefined;
	if (q.type === 'choice') return typeof a['choice'] === 'string' ? { type: 'choice', choice: a['choice'], confidence, probabilities } : undefined;
	const score = finite(a['score']);
	// the most probable level; a key names a level by index ("2") or by its label
	const best = Object.entries(probabilities).reduce<[string, number] | undefined>((top, [k, p]) => top === undefined || p > top[1] ? [k, p] : top, undefined);
	const level = best === undefined ? -1 : /^\d+$/.test(best[0]) ? Number(best[0]) : (q.criteria as readonly string[]).indexOf(best[0]);
	return score === undefined || level < 0 ? undefined
		: { type: 'score', score, level, confidence, probabilities, legend: isObj(a['legend']) ? a['legend'] as { [k: string]: string } : {} };
}

/**
 * A `sys_1` on OpenRouter's Decisions API, text only (P37 (3)): one `ask` is one POST `{ model, state, questions }`,
 * field for field; the answers map back as given (a score gains `level`), `usage.cost` (USD) is `costUsd`. No fallback:
 * a timeout, an HTTP error or an unusable answer rejects; a request refusal is the typed error `refusalOf` maps it to.
 * `timeoutMillis` narrows the engine's wall (`DECISION_CALL_MS`); `transport` is the test seam.
 */
export function decisionsSystem1(config: DecisionsApiConfig, transport: typeof fetch = fetch): System1Port {
	return {
		maxChoices: 255, // the Decisions API refuses a choice question with more
		async ask(request, signal) {
			const response = await transport(config.url, {
				method: 'POST',
				signal: config.timeoutMillis === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMillis)]),
				headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
			});
			if (!response.ok) {
				const text = await response.text();
				throw refusalOf(response.status, text) ?? new Error(`decisions: ${response.status} ${text.slice(0, 200)}`);
			}
			const body: unknown = await response.json();
			if (!isObj(body) || !isObj(body['answers'])) throw new Error('decisions: the answer is not an object');
			const wire = body['answers'];
			const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, decisionsAnswer(q, wire[id])]));
			if (Object.values(answers).some((a) => a === undefined)) throw new Error('decisions: an answer is missing or malformed');
			const usage = isObj(body['usage']) ? body['usage'] : {};
			return { answers: answers as { [id: string]: DecisionAnswer }, costUsd: finite(usage['cost']) ?? 0,
				provider: typeof body['provider'] === 'string' ? body['provider'] : config.model,
				tokens: { input: finite(usage['input_tokens']) ?? 0, output: finite(usage['output_tokens']) ?? 0 } };
		},
	};
}
