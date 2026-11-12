import { actor_ref } from '../engine/access/actor.ts';
import { json_schema } from '@norbital-ai/std/kind';
import { automation_fields } from '../decl/runtime/automation-input.ts';
import { uuid } from '../engine/port.ts';
// Each body enters one decoded route; all engine calls remain in the activation's Effect graph.
import {
	Clock,
	Context,
	Crypto,
	Effect,
	FiberSet,
	Layer,
	Option,
	Ref,
	Result,
	Schema,
	Stream
} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { Json } from '../decl/values.ts';
import type { Authority, Bindings, Invocation, Outcome, RowData } from '../engine/contracts.ts';
import { Captured, capturedFields } from '../engine/db/captured.ts';
import { relations, type EngineManifest } from '../engine/manifest.ts';
import { catalog_of } from '../engine/access/pred.ts';
import { bindingsAt } from '../engine/query/reader.ts';
import {
	Conflict,
	Fenced,
	IdentityRefusal,
	Interrupted,
	type DbError,
	type EngineError
} from '../engine/errors.ts';
import { BoltError, CODE } from './errors.ts';
import {
	addressBucket,
	charges_for,
	macKey,
	OPEN_WINDOWS_SQL,
	OpenWindow,
	RateWindows,
	resetAfter,
	type Charge
} from '../engine/access/rate.ts';
import { lazyKeys } from '../engine/identity/session.ts';
import { admit_visitor, parse_callable, decode_acts, startCharge } from '../engine/callables/index.ts';
import {
	AgentBackground,
	agentCallables,
	conversationFor,
	type AgentCallables
} from '../engine/agent/callables.ts';
import { isStaff, transcriptRow } from '../engine/agent/schema.ts';
import { mcpServers } from '../engine/agent/mcp.ts';
import { agentSettings, allowedModel, spent } from '../engine/agent/settings.ts';
import { previewPdf } from '../engine/facilities.ts';
import { lower_read } from '../engine/query/engine.ts';
import { readsAny, viewOutput } from '../engine/access/authority.ts';
import { client_contract } from '../engine/access/operation-outputs.ts';
import { record_capabilities, transformBridge } from '../engine/write/act.ts';
import { restorePreview, restoreRecord } from '../engine/write/restore.ts';
import { subscribe } from '../engine/runs/push.ts';
import { visible_run_names } from '../engine/runs/rows.ts';

import { filter_describe } from '../engine/filter-describe/index.ts';
import type { RateCharge } from '../engine/write/commit.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import {
	Manifest,
	Reads,
	Writes,
	Callables,
	Automations,
	Approvals,
	Live,
	Agents,
	Guest
} from '../engine/services.ts';
import type { ReadIR, RequestRoot } from './reads.ts';
import {
	ActBody,
	SyncControlBody,
	type WriteMapBody,
	LiveBody,
	NoticeRow,
	OwnCall,
	PreviewPdf,
	PushBody,
	QBody,
	type Frame,
	type WireRead
} from './schema.ts';
import {
	BOLT,
	HEADERS,
	INTEGRATIONS,
	PATHS,
	notice_path,
	RATE_LIMITED,
	redact,
	status_of,
	uuidv7_within,
	wire_error
} from './wire.ts';
import { HOOKS, OAUTH_CALLBACK } from '../engine/integrations/links.ts';
import { sseResponse } from './sse.ts';

export class SessionAuthority extends Context.Service<
	SessionAuthority,
	{
		readonly of: (
			request: HttpServerRequest.HttpServerRequest
		) => Effect.Effect<Option.Option<Authority>, BoltError | DbError>;
	}
>()('bolt/SessionAuthority') {}
export class AgentTurns extends Context.Service<
	AgentTurns,
	{
		readonly start: (turn: Effect.Effect<unknown, EngineError>) => Effect.Effect<void>;
		readonly settled: Effect.Effect<void>;
	}
>()('bolt/AgentTurns') {
	static readonly layer = Layer.effect(
		AgentTurns,
		Effect.gen(function* () {
			const turns = yield* FiberSet.make();
			return {
				start: (turn: Effect.Effect<unknown, EngineError>) =>
					FiberSet.run(turns, turn.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)).pipe(
						Effect.asVoid
					),
				settled: FiberSet.awaitEmpty(turns)
			};
		})
	);
}
export class AgentCallTable extends Context.Service<AgentCallTable, AgentCallables>()(
	'bolt/AgentCallTable'
) {
	static readonly layer = Layer.effect(
		AgentCallTable,
		Effect.flatMap(AgentTurns, (turns) =>
			agentCallables.pipe(Effect.provideService(AgentBackground, { start: turns.start }))
		)
	);
}
export class RateLimits extends Context.Service<
	RateLimits,
	{
		readonly ipBucket: (address: string) => Effect.Effect<string, DbError>;
		readonly charge: (
			charges: Parameters<RateWindows['charge']>[0],
			now: number
		) => Effect.Effect<ReturnType<RateWindows['charge']>>;
	}
>()('bolt/RateLimits') {
	static readonly layer = Layer.effect(
		RateLimits,
		Effect.gen(function* () {
			const db = yield* TenantDb;
			// a cell taking a tenant restores its persisted open windows, so a restart does not reset the acts' budgets; a
			// cold start owes this rather than doing it, and the keys wait for the first caller who needs them
			const loaded = new RateWindows(),
				keys = lazyKeys(db);
			db.owe(
				Effect.gen(function* () {
					loaded.load(
						yield* db.rows(OpenWindow, { text: OPEN_WINDOWS_SQL, params: [] }),
						yield* Clock.currentTimeMillis
					);
				}).pipe(Effect.catchTag('BoltError', Effect.die))
			);
			const windows = yield* Ref.make(loaded);
			return {
				ipBucket: (address: string) =>
					Effect.map(keys, ({ ipMac }) => macKey(ipMac, addressBucket(address))),
				charge: (charges: Parameters<RateWindows['charge']>[0], now: number) =>
					Ref.modify(windows, (w) => [w.charge(charges, now), w])
			};
		})
	);
}

const errorJson = (code: string, message: string, status = 500, headers?: Readonly<Record<string, string>>) =>
	HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status, ...(headers === undefined ? {} : { headers }) });
/** Every `rate_limited` refusal on the wire: one message and `Retry-After`. */
export const rateLimitedResponse = (retryAfter: number) =>
	errorJson('rate_limited', RATE_LIMITED, 429, { 'retry-after': String(retryAfter) });
export const requestUrl = (request: HttpServerRequest.HttpServerRequest) =>
	new URL(request.url, 'http://bolt.local');
export const header = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	request.headers[name.toLowerCase()];
export const invalid = (message: string) => BoltError.make('invalid', 'decode', message);
const forbidden = (message: string) => BoltError.make('forbidden', 'admission', message);
export const response_error = (error: unknown) => {
	if (error instanceof IdentityRefusal)
		return errorJson(error.code, error.message, CODE[error.code].status,
			error.retryAfter === undefined ? undefined : { 'retry-after': String(error.retryAfter) });
	if (error instanceof Conflict)
		return errorJson('conflict', 'Another write changed these records.', 409);
	if (error instanceof Fenced)
		return errorJson('fenced', error.message);
	if (error instanceof Interrupted)
		return errorJson('interrupted', 'The workspace generation is closed.');
	const { body, status } = wire_error(error);
	return errorJson(body.error.code, body.error.message, status);
};
type EffectMemo<K, A, E, R> = {
	get(key: K): Effect.Effect<A, E, R> | undefined;
	set(key: K, value: Effect.Effect<A, E, R>): void;
};
/** Cold loads keep their exact result; a reused decoded body is checked by its own route schema. */
const memoized = <K, Stored, A extends Stored, E, R>(
	cache: EffectMemo<K, Stored, E, R>, key: K,
	create: () => Effect.Effect<A, E, R>, reuse: (value: Stored) => Effect.Effect<A, E, R>
) => Effect.gen(function* () {
	const hit = cache.get(key);
	if (hit !== undefined) return yield* hit.pipe(Effect.flatMap(reuse));
	const value = yield* Effect.cached(create());
	cache.set(key, value);
	return yield* value;
});
/** HttpIncomingMessage caches JSON consumption. This also memoizes Schema decoding for admission and dispatch. */
const bodies = new WeakMap<
	HttpServerRequest.HttpServerRequest,
	Map<object, Effect.Effect<unknown, BoltError>>
>();
export const requestBody = <A>(
	request: HttpServerRequest.HttpServerRequest,
	schema: Schema.Decoder<A>
): Effect.Effect<A, BoltError> =>
	Effect.gen(function* () {
		let decoded = bodies.get(request);
		if (decoded === undefined) {
			decoded = new Map();
			bodies.set(request, decoded);
		}
		return yield* memoized(decoded, schema, () => request.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })),
				Effect.mapError((e) => invalid(String(e)))
			), (value) => Schema.is(Schema.toType(schema))(value)
				? Effect.succeed(value)
				: Effect.fail(invalid('A cached body did not match its route.')));
	});
export const bindings = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis;
	const m = yield* Manifest;
	return bindingsAt(now, m.workspace.tz);
});
const committed = (output: Json): Outcome => ({ kind: 'committed', output, records: [] });
const JsonObject = Schema.Record(Schema.String, Schema.Json);
type ActRateAdmission = {
	readonly verdict: ReturnType<RateWindows['charge']>;
	readonly charges: readonly RateCharge[];
	/** Seconds until every charged window resets: the `Retry-After` of a refusal the statement decides. */
	readonly resetAfter: number;
};
const actAdmissions = new WeakMap<
	HttpServerRequest.HttpServerRequest,
	Effect.Effect<ActRateAdmission, EngineError, RateLimits>
>();
/**
 * Whom a `per: 'actor'` limit counts: a member, else a visitor's IP. An anonymous user is an identity for ownership and
 * linking, never a rate bucket: one client could mint many, and its IP is what it cannot change cheaply.
 */
const individual = (authority: Authority, ip: string | undefined): string | undefined =>
	authority.actor.kind === 'member'
		? authority.actor.id
		: authority.actor.kind === 'visitor'
			? ip
			: undefined;
/** The caller's address bucket, only when its limits name one: a member's call asks nothing of the database for it. */
const ipFor = (
	limits: RateLimits['Service'],
	request: HttpServerRequest.HttpServerRequest,
	authority: Authority
) =>
	authority.actor.kind === 'visitor' || authority.limits.some((rule) => rule.per === 'ip')
		? limits.ipBucket(Option.getOrElse(request.remoteAddress, () => '0.0.0.0'))
		: Effect.succeed(undefined);
/** The limit keys an `/act` body names: its callables (a PDF preview is `convert`). */
const actCallables = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.map(requestBody(request, ActBody), (body) =>
		'acts' in body ? Object.keys(body.acts) : [body.callable === 'convert.previewPdf' ? 'convert' : body.callable]);
/** Shell admission and dispatch share one charge; direct protocol hosts use the same native peer address. */
export const requestActRate = Effect.fn('protocol.requestActRate')(function* (
	request: HttpServerRequest.HttpServerRequest,
	authority: Authority,
	callables: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<readonly string[], BoltError> = actCallables
): Effect.fn.Return<ActRateAdmission, EngineError, RateLimits> {
	return yield* memoized(actAdmissions, request, () => Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const limits = yield* RateLimits;
			const bucket = yield* ipFor(limits, request, authority);
			const ip = authority.limits.some((rule) => rule.per === 'ip') ? bucket : undefined;
			const actor = individual(authority, bucket);
			const who = {
				...(actor === undefined ? {} : { actor }),
				...(ip === undefined ? {} : { ip })
			};
			const common = charges_for(authority, ['act'], who);
			const persistent = (charges: readonly Charge[]) => ({
				charges: charges.map((charge) => ({
					rule: charge.rule,
					bucket: charge.bucket,
					limit: charge.limit,
					windowStart: new Date(now - (now % charge.windowMs)).toISOString()
				})),
				resetAfter: resetAfter(charges, now)
			});
			const verdict = yield* limits.charge(common, now);
			if (!verdict.ok) return { verdict, ...persistent(common) };
			const named = charges_for(authority, yield* callables(request), who).filter(
				(charge) =>
					!common.some((prior) => prior.rule === charge.rule && prior.bucket === charge.bucket)
			);
			return {
				verdict: yield* limits.charge(named, now),
				...persistent([...common, ...named])
			};
		}), Effect.succeed);
});
/** Public page loaders and wire reads obey the same visitor surface restrictions. */
/** One record as the caller's generic views read it: through its view output (`default` when held). */
const viewGet = (m: EngineManifest, authority: Authority, model: string, id: string) =>
	Effect.map(lower_read(m, 'get', [model, id]), (read): ReadIR => {
		const output = viewOutput(m, authority, model);
		return read.kind === 'get' && output !== undefined ? { ...read, output } : read;
	});
export const readAdmitted = (
	authority: Authority,
	read:
		| {
				readonly kind: string;
				readonly model?: string | undefined;
				readonly roots?: readonly RequestRoot[] | undefined;
		  }
		| undefined
): boolean =>
	authority.actor.kind !== 'visitor' ||
	(read !== undefined &&
		(read.kind === 'request'
			? // a read request (a page loader's `ctx.query`): every root a current read the visitor may make
				(read.roots ?? []).length > 0 &&
				(read.roots ?? []).every((root) => 'read' in root && readAdmitted(authority, root.read))
			: (read.kind === 'read' || read.kind === 'get') &&
				typeof read.model === 'string' &&
				admit_visitor(authority, { read: read.model }) === null));
const readAdmissions = new WeakMap<
	HttpServerRequest.HttpServerRequest,
	Effect.Effect<ReturnType<RateWindows['charge']>, DbError, RateLimits>
>();
/** Charge one read request (`/q`, a live registration, a page loader) once, before decoding or running it. */
export const requestReadRate = Effect.fn('protocol.requestReadRate')(function* (
	request: HttpServerRequest.HttpServerRequest,
	authority: Authority
) {
	return yield* memoized(readAdmissions, request, () => Effect.gen(function* () {
			const limits = yield* RateLimits;
			const ip = yield* ipFor(limits, request, authority);
			const actor = individual(authority, ip);
			return yield* limits.charge(
				charges_for(authority, ['read'], {
					...(actor === undefined ? {} : { actor }),
					...(ip === undefined ? {} : { ip })
				}),
				yield* Clock.currentTimeMillis
			);
		}), Effect.succeed);
});
/** Visitor wire reads are the same granted model pages and records as their server-loader IR. */
export const wireReadAdmitted = (authority: Authority, read: WireRead | undefined): boolean => {
	if (authority.actor.kind !== 'visitor') return true;
	if (read?.m !== 'query') return false;
	const admits = (model: string | undefined, args: Json | undefined): boolean =>
		model !== undefined &&
		!(
			Schema.is(JsonObject)(args) &&
			args['search'] !== undefined &&
			typeof args['search'] !== 'string'
		) &&
		readAdmitted(authority, { kind: 'read', model: model });
	const [request] = read.a;
	// a read request (the only query form): each path's root granted, no index search
	return (
		Schema.is(JsonObject)(request) &&
		Object.entries(request).every(([path, layer]) => admits(path.split('.', 1)[0], layer))
	);
};
const liveViewAdmitted = wireReadAdmitted;

const dispatchWrites = Effect.fn('protocol.dispatchWrites')(function* (
	body: WriteMapBody,
	key: string,
	retry: boolean,
	authority: Authority,
	request: HttpServerRequest.HttpServerRequest
) {
	const admission = yield* requestActRate(request, authority);
	if (!admission.verdict.ok) return {
		outcome: { kind: 'refused', code: 'rate_limited', message: RATE_LIMITED } satisfies Outcome,
		v: yield* (yield* Live).v,
		retryAfter: admission.verdict.retryAfter
	};
	const decoded = yield* decode_acts(yield* Manifest, body.acts);
	return yield* (yield* Callables).acts({
		name: 'act',
		acts: decoded.acts,
		outputs: decoded.outputs,
		key,
		issuedAt: body.issued_at,
		retry,
		rate: admission.charges,
		authority,
		bindings: yield* bindings,
		invocationId: yield* uuid(yield* Crypto.Crypto),
		from: 'Client'
	});
});

export type ActCall = {
	readonly callable: string;
	readonly input: Json;
	readonly key: string;
	readonly issuedAt: string;
	readonly retry?: boolean | undefined;
	readonly observed?: { readonly [id: string]: number } | undefined;
	readonly rate?: readonly RateCharge[] | undefined;
};
export const dispatch_act = Effect.fn('protocol.dispatchAct')(function* (
	call: ActCall,
	authority: Authority,
	request?: HttpServerRequest.HttpServerRequest
) {
	const m = yield* Manifest,
		live = yield* Live,
		b = yield* bindings;
	const limited = (retryAfter: number) =>
		Effect.map(live.v, (v) => ({
			outcome: { kind: 'refused', code: 'rate_limited', message: RATE_LIMITED } satisfies Outcome,
			v,
			retryAfter
		}));
	const admitted = request === undefined ? undefined : yield* requestActRate(request, authority);
	if (admitted !== undefined && !admitted.verdict.ok)
		return yield* limited(admitted.verdict.retryAfter);
	const own = yield* AgentCallTable;
	const agent = own[call.callable];
	if (agent !== undefined) {
		const input = yield* Schema.decodeUnknownEffect(agent.input)(call.input).pipe(
			Effect.mapError((e) => invalid(String(e)))
		);
		if (call.callable === 'sys_message.post') {
			const verdict = yield* (yield* RateLimits).charge(
				charges_for(
					authority,
					['agent'],
					authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}
				),
				Date.parse(b.now)
			);
			if (!verdict.ok) return yield* limited(verdict.retryAfter);
		}
		const output = yield* agent.run(input, authority);
		return { outcome: committed(output), v: yield* live.v };
	}
	if (
		[
			'run',
			'approvals.decide',
			'filter.describe',
			'filter.options',
			'sys_notification.mark_read',
			'history.preview',
			'history.restore'
		].includes(call.callable)
	) {
		const decoded = yield* Schema.decodeUnknownEffect(OwnCall, { onExcessProperty: 'error' })({
			callable: call.callable,
			input: call.input
		}).pipe(Effect.mapError((e) => invalid(String(e))));
		let outcome: Outcome;
		if (decoded.callable === 'run') {
			if (m.automations[decoded.input.automation]?.mode === 'call') {
				if ('id' in decoded.input || 'runs' in decoded.input)
					outcome = { kind: 'refused', code: 'invalid_input', message: 'A call takes one input and no run ids.' };
				else outcome = yield* (yield* Automations).call({ automation: decoded.input.automation, input: decoded.input.input ?? {}, authority, bindings: b });
			} else if (!('runs' in decoded.input) && !('id' in decoded.input)) {
				outcome = { kind: 'refused', code: 'invalid_input', message: 'A job names its run ids.' };
			} else {
			const runs = ('runs' in decoded.input ? decoded.input.runs : [decoded.input]).map((run) => ({
				id: run.id,
				input: run.input ?? {}
			}));
			outcome = runs.every((run) => uuidv7_within(run.id, Date.parse(b.now)))
				? yield* (yield* Callables).start({
						automation: decoded.input.automation,
						runs,
						authority,
						bindings: b
					})
				: {
						kind: 'refused',
						code: 'invalid_input',
						message: 'A run id is a uuidv7 minted within 24 hours.',
						field: 'id'
					};
			}
			if (outcome.kind === 'refused' && outcome.code === 'rate_limited')
				return yield* limited(
					resetAfter([startCharge(decoded.input.automation, authority)], Date.parse(b.now))
				);
		} else if (decoded.callable === 'approvals.decide') {
			const decision = yield* (yield* Approvals).decide({
				...decoded.input,
				authority,
				now: b.now
			});
			outcome =
				decision.kind === 'decided'
					? committed({ request_id: decision.request_id, status: decision.status })
					: decision;
		} else if (decoded.callable === 'sys_notification.mark_read') {
			if (authority.actor.kind !== 'member' || authority.actor.external)
				return yield* Effect.fail(
					forbidden('Only staff members have an inbox.'));
			const db = yield* TenantDb;
			const captured = yield* db.returning(Captured, {
				text: `UPDATE sys_notification SET read_at = $4::timestamptz WHERE member = $1 AND ($2::boolean OR id IN (SELECT jsonb_array_elements_text($3::jsonb))) AND read_at IS NULL RETURNING ${capturedFields("'sys_notification'")}`,
				params: [
					authority.actor.id,
					'all' in decoded.input,
					'ids' in decoded.input ? decoded.input.ids : [],
					b.now
				]
			});
			live.publish(captured);
			outcome = committed(null);
		} else if (decoded.callable === 'history.preview') {
			const previewed = yield* restorePreview(yield* probe, decoded.input, authority, b);
			outcome = previewed.ok ? committed(previewed.preview) : previewed.outcome;
		} else if (decoded.callable === 'history.restore') {
			const writes = yield* Writes;
			const restored = yield* restoreRecord(yield* probe, writes.act, decoded.input, {
				...call,
				...(admitted === undefined ? {} : { rate: [...(call.rate ?? []), ...admitted.charges] }),
				authority,
				bindings: b,
				invocationId: yield* uuid(yield* Crypto.Crypto)
			});
			return { outcome: restored.outcome, v: restored.v ?? (yield* live.v) };
		} else {
			const filters = yield* filter_describe;
			if (decoded.callable === 'filter.describe') {
				const verdict = yield* (yield* RateLimits).charge(
					charges_for(
						authority,
						['agent'],
						authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}
					),
					Date.parse(b.now)
				);
				if (!verdict.ok) return yield* limited(verdict.retryAfter);
				const result = yield* filters.describe({
					model: decoded.input.model,
					text: decoded.input.text,
					authority,
					bindings: b,
					...(decoded.input.fields === undefined ? {} : { localFields: decoded.input.fields })
				});
				outcome = result.ok
					? committed({
							...(result.where === undefined ? {} : { where: result.where }),
							...(result.order_by === undefined ? {} : { order_by: result.order_by })
						})
					: {
							kind: 'refused',
							code: result.code === 'not_found' ? 'not_found' : 'invalid_input',
							message: result.message
						};
			} else if (decoded.callable === 'filter.options') {
				const result = yield* filters.options({
					model: decoded.input.model,
					authority,
					bindings: b,
					...(decoded.input.fields === undefined ? {} : { localFields: decoded.input.fields })
				});
				outcome = result.ok
					? committed({ fields: result.fields })
					: {
							kind: 'refused',
							code: result.code === 'not_found' ? 'not_found' : 'invalid_input',
							message: result.message
						};
			} else return yield* Effect.fail(invalid('Unknown own callable.'));
		}
		return { outcome, v: yield* live.v };
	}
	const parsed = parse_callable(call.callable, m);
	if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
	const callable = parsed.success;
	const context = {
		...call,
		...(admitted === undefined ? {} : { rate: [...(call.rate ?? []), ...admitted.charges] }),
		authority,
		bindings: b,
		invocationId: yield* uuid(yield* Crypto.Crypto)
	};
	if (callable._tag === 'Verb')
		return yield* (yield* Writes).act({
			...context,
			model: callable.model,
			verb: callable.verb,
			mode: { _tag: 'Direct' }
		});
	return yield* Effect.fail(
		BoltError.make('unknown_callable', 'decode', `there is no callable '${call.callable}'`)
	);
});

/** What a record's checks run with outside an act: the write's guest and its workspace-read bridge. */
const probe = Effect.gen(function* () {
	const manifest = yield* Manifest,
		db = yield* TenantDb,
		guest = yield* Guest;
	return {
		manifest,
		db,
		guest,
		bridge: (invocation: Invocation, over: typeof db = db) =>
			transformBridge(manifest, over, invocation)
	};
});
const lower = Effect.fn('protocol.lower_read')(function* (
	authority: Authority,
	read: WireRead
): Effect.fn.Return<ReadIR, EngineError, Manifest | TenantDb> {
	const m = yield* Manifest;
	if (read.m === 'transcript') {
		const id = String(read.a[0] ?? ''),
			conversation = yield* conversationFor(authority, id);
		const tail = read.a[1];
		const n = Schema.is(JsonObject)(tail) && typeof tail['tail'] === 'number' ? tail['tail'] : 0;
		const start =
			n > 0
				? yield* (yield* TenantDb).one(Schema.Struct({ seq: Schema.NumberFromString }), {
						text: 'SELECT seq::text AS seq FROM sys_message WHERE conversation = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1',
						params: [id, Math.floor(n) - 1]
					})
				: Option.none();
		return {
			kind: 'transcript',
			model: 'sys_message',
			conversation: id,
			thread: conversation.integration !== null,
			...(conversation.run == null ? {} : { automation: true }),
			...(Option.isSome(start) ? { from: start.value.seq } : {})
		};
	}
	if (read.m === 'conversations' || read.m === 'inbox') {
		if (authority.actor.kind !== 'member' || (read.m === 'inbox' && authority.actor.external))
			return yield* Effect.fail(
				forbidden('Not available to this member.'));
		if (read.m === 'conversations')
			return { kind: 'conversations', model: 'sys_conversation', member: authority.actor.id };
		const options = read.a[0];
		return {
			kind: 'inbox',
			model: 'sys_notification',
			member: authority.actor.id,
			...(Schema.is(JsonObject)(options) && options['requests'] === true ? { requests: true } : {})
		};
	}
	if (read.m === 'runs') {
		const o = read.a[0];
		const options = Schema.is(JsonObject)(o) ? o : {};
		const automation =
			typeof options['automation'] === 'string' ? options['automation'] : undefined;
		const id = typeof options['id'] === 'string' ? options['id'] : undefined;
		// rule 56: every run is staff's; a holder of an automation (external included) reads its runs; one run by id is
		// answered as `run_view` lets the caller read it
		if (
			authority.actor.kind !== 'member' ||
			(authority.actor.external &&
				id === undefined &&
				(automation === undefined || !visible_run_names(authority).includes(automation)))
		)
			return yield* Effect.fail(
				forbidden('No runs for this member.'));
		const limit = typeof options['limit'] === 'number' ? options['limit'] : 100;
		return {
			kind: 'runs',
			model: 'sys_run',
			limit,
			automation,
			id,
			...(options['brief'] === true ? { brief: true } : {})
		};
	}
	return yield* lower_read(m, read.m, read.a);
});

/** One notice of `GET /__bolt/notices`; its `at` is the event id a reconnect names in `Last-Event-ID`. */
type NoticeEvent = {
	readonly id: string;
	readonly title: string;
	readonly body: string | null;
	readonly path: string;
	readonly at: string;
};
const inboxRow = Schema.decodeUnknownOption(NoticeRow);
const inboxPage = Schema.decodeUnknownOption(Schema.Struct({ rows: Schema.Array(Schema.Json) }));

const releaseChanged = Effect.fn('protocol.releaseChanged')(function* (request: HttpServerRequest.HttpServerRequest) {
	const stated = header(request, HEADERS.contract);
	if (stated === undefined || stated === client_contract(yield* Manifest)) return undefined;
	return HttpServerResponse.jsonUnsafe({
		outcome: { kind: 'refused', code: 'release_changed', message: 'The workspace was updated; reload the page.' },
		v: yield* (yield* Live).v
	}, { status: 409 });
});
export const BoltRoutes = {
	[`POST ${PATHS.sync_control}` as const]: {
		guest: false,
		run: Effect.fn('protocol.sync_control')(function* (request: HttpServerRequest.HttpServerRequest, authority: Authority) {
			const body = yield* requestBody(request, SyncControlBody);
			if (header(request, HEADERS.key) !== body.id)
				return yield* Effect.fail(invalid('The idempotency key must equal the sync run id.'));
			const changed = yield* releaseChanged(request);
			if (changed !== undefined) return changed;
			const admitted = yield* requestActRate(request, authority, () =>
				Effect.succeed([`${body.model}.sync.${body.sync}`]));
			if (!admitted.verdict.ok) return rateLimitedResponse(admitted.verdict.retryAfter);
			const b = yield* bindings;
			if (!uuidv7_within(body.id, Date.parse(b.now)))
				return yield* Effect.fail(invalid('A sync run id is a uuidv7 minted within 24 hours.'));
			const outcome = redact(yield* (yield* Callables).sync_control({
				model: body.model, sync: body.sync, id: body.id, input: body.input, authority, bindings: b
			}), authority.actor);
			return HttpServerResponse.jsonUnsafe({ outcome, v: yield* (yield* Live).v }, {
				status: status_of(outcome),
				...(outcome.kind === 'refused' && outcome.code === 'rate_limited'
					? { headers: { 'retry-after': String(resetAfter([startCharge(`${body.model}.sync.${body.sync}`, authority)], Date.parse(b.now))) } }
					: {})
			});
		})
	},
	[`POST ${PATHS.q}` as const]: {
		guest: 'reads',
		run: Effect.fn('protocol.q')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const rate = yield* requestReadRate(request, authority);
			if (!rate.ok) return rateLimitedResponse(rate.retryAfter);
			const body = yield* requestBody(request, QBody);
			if (body.reads.some((read) => !wireReadAdmitted(authority, read)))
				return yield* Effect.fail(forbidden('Visitors may not do this.'));
			const batch = yield* Effect.forEach(body.reads, (read) => lower(authority, read));
			const values = yield* (yield* Reads).run(batch, { as: 'caller', authority }, yield* bindings);
			if (values.length !== batch.length)
				return yield* Effect.fail(
					BoltError.make(
						'bad_answer',
						'deliver',
						`The reader returned ${values.length} answers for ${batch.length} reads.`
					)
				);
			return HttpServerResponse.jsonUnsafe({ answers: values });
		})
	},
	[`POST ${PATHS.act}` as const]: {
		guest: true,
		run: Effect.fn('protocol.act')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const key = header(request, HEADERS.key);
			if (!key) return yield* Effect.fail(invalid(`${HEADERS.key} is required (rule 31)`));
			const body = yield* requestBody(request, ActBody),
				live = yield* Live;
			const changed = yield* releaseChanged(request);
			if (changed !== undefined) return changed;
			if ('callable' in body && body.callable === 'convert.previewPdf') {
				if (authority.actor.kind !== 'member')
					return yield* Effect.fail(
						forbidden('Only members may convert documents.'));
				const admitted = yield* requestActRate(request, authority);
				if (!admitted.verdict.ok)
					return HttpServerResponse.jsonUnsafe(
						{
							outcome: { kind: 'refused', code: 'rate_limited', message: RATE_LIMITED },
							v: yield* live.v
						},
						{ status: 429, headers: { 'retry-after': String(admitted.verdict.retryAfter) } }
					);
				const { source, options } = yield* Schema.decodeUnknownEffect(PreviewPdf)(body.input).pipe(
					Effect.mapError((error) => invalid(String(error)))
				);
				const bytes = yield* previewPdf(source, options).pipe(
					Effect.mapError((error) =>
						BoltError.make(
							error._tag === 'Unavailable' ? 'unavailable' : 'invalid',
							'facility',
							error.message,
							error
						)
					)
				);
				return HttpServerResponse.uint8Array(bytes, {
					contentType: 'application/pdf',
					headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
				});
			}
			if ('callable' in body) {
				const generated = parse_callable(body.callable, yield* Manifest);
				if (Result.isSuccess(generated) && generated.success._tag === 'Verb')
					return yield* Effect.fail(invalid('Generated writes take a map of callable to inputs.'));
			}
			const retry = header(request, HEADERS.retry) === '1';
			const reply = yield* ('acts' in body
				? dispatchWrites(body, key, retry, authority, request)
				: dispatch_act(
					{ callable: body.callable, input: body.input, observed: body.observed, issuedAt: body.issued_at, key, retry },
					authority,
					request
				));
			const outcome = redact(reply.outcome, authority.actor);
			// every 429 names its wait: a cell's own count says it; a refusal the statement decided waits out its windows
			const retryAfter =
				outcome.kind === 'refused' && outcome.code === 'rate_limited'
					? 'retryAfter' in reply
						? reply.retryAfter
						: (yield* requestActRate(request, authority)).resetAfter
					: undefined;
			return HttpServerResponse.jsonUnsafe(
				{ outcome, v: reply.v },
				{
					status: status_of(outcome),
					...(retryAfter === undefined ? {} : { headers: { 'retry-after': String(retryAfter) } })
				}
			);
		})
	},
	[`GET ${PATHS.live}` as const]: {
		guest: false,
		run: Effect.fn('protocol.stream')(function* (
			_request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			return sseResponse((yield* Live).connect(authority));
		})
	},
	[`GET ${PATHS.notices}` as const]: {
		guest: false,
		run: Effect.fn('protocol.notices')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const read = yield* lower(authority, { m: 'inbox', a: [] }),
				live = yield* Live;
			const since = Date.parse(
				header(request, 'Last-Event-ID') ?? requestUrl(request).searchParams.get('since') ?? ''
			);
			// the inbox view's first answer replays unread notices after `since`; every later one carries only arrivals
			let first = true;
			const none: readonly NoticeEvent[] = [];
			const notices = (frame: Frame): readonly NoticeEvent[] => {
				if (frame.t !== 'answer' && frame.t !== 'patch') return none;
				let rows: readonly NoticeRow[];
				if (first && frame.t === 'answer') {
					rows = Number.isNaN(since) ? [] : Option.match(inboxPage(frame.value), {
						onNone: () => [],
						onSome: (page) => page.rows
							.flatMap((row) => Option.toArray(inboxRow(row)))
							.filter((row) => !row.read && Date.parse(row.at) > since)
							.reverse()
					});
				} else rows = (frame.arrivals ?? []).flatMap((row) => Option.toArray(inboxRow(row)));
				first = false;
				return rows.map((row) => ({
					id: row.id,
					title: row.title,
					body: row.body,
					path: notice_path(row.link),
					at: row.at
				}));
			};
			return sseResponse(
				live.connect(authority).pipe(
					Stream.takeWhile((frame) => frame.t !== 'close' && frame.t !== 'error'),
					Stream.mapEffect((frame) =>
						frame.t === 'hello'
							? live.register(frame.conn, 'notices', { read }).pipe(Effect.as(none))
							: Effect.sync(() => notices(frame))
					),
					Stream.flattenIterable
				),
				(notice) => notice.at
			);
		})
	},
	[`POST ${PATHS.live}` as const]: {
		guest: 'live',
		admits: liveViewAdmitted,
		run: Effect.fn('protocol.register')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const rate = yield* requestReadRate(request, authority);
			if (!rate.ok) return rateLimitedResponse(rate.retryAfter);
			const body = yield* requestBody(request, LiveBody),
				live = yield* Live,
				owner = yield* live.authorityOf(body.conn);
			if (Option.isSome(owner) && actor_ref(owner.value.actor) !== actor_ref(authority.actor))
				return yield* Effect.fail(
					forbidden('the live connection belongs to another session'));
			if (Option.isSome(owner) && owner.value.key !== authority.key)
				yield* live.authorize(body.conn, authority);
			yield* Effect.forEach(body.drop ?? [], (view) => live.drop(body.conn, view));
			const errors = yield* Effect.forEach(
				body.add ?? [],
				(view) =>
					Effect.gen(function* () {
						if (!liveViewAdmitted(authority, view.read))
							return yield* Effect.fail(
								forbidden('Visitors may not do this.'));
						yield* live.register(body.conn, view.view, {
							read: yield* lower(authority, view.read)
						});
						return Option.none<{ view: string; code: string; message: string }>();
					}).pipe(
						Effect.catch((e) =>
							Effect.succeed(
								Option.some({
									view: view.view,
									code: e instanceof BoltError ? e.code : 'internal',
									message: e.message
								})
							)
						)
					),
				{ concurrency: 'unbounded' }
			);
			return HttpServerResponse.jsonUnsafe({ errors: errors.flatMap(Option.toArray) });
		})
	},
	[`POST ${PATHS.push}` as const]: {
		guest: false,
		run: Effect.fn('protocol.push')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			if (!isStaff(authority))
				return yield* Effect.fail(
					forbidden('Only staff members receive notices.'));
			const body = yield* requestBody(request, PushBody);
			if (
				body.endpoint.length > 2048 ||
				('kind' in body && body.kind === 'apns'
					? !/^[0-9a-f]{64,512}$/i.test(body.endpoint)
					: !('remove' in body) && !/^https:\/\//.test(body.endpoint))
			)
				return yield* Effect.fail(invalid('Invalid push subscription.'));
			if (authority.actor.kind !== 'member')
				return yield* Effect.fail(
					forbidden('Only staff members receive notices.'));
			yield* subscribe(authority.actor.id, body);
			return HttpServerResponse.empty({ status: 204 });
		})
	},
	[`GET ${PATHS.agent}/models` as const]: {
		guest: false,
		run: Effect.fn('protocol.models')(function* (
			_request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const m = yield* Manifest;
			if (
				authority.actor.kind !== 'member' ||
				(authority.actor.external ? m.agent.external : m.agent.internal) === undefined
			)
				return yield* Effect.fail(
					forbidden('The assistant is not available to you here.'));
			// an administrator's runtime settings narrow the picker (one model hides it); administrators also read the whole
			// catalogue, the settings and this month's spend (Settings, Organization); the session rail reads the MCP servers
			const catalog = yield* (yield* Agents).models,
				db = yield* TenantDb,
				settings = yield* agentSettings(db);
			const models = catalog.models.filter(
				(x) => settings.models.length === 0 || settings.models.includes(x.id)
			);
			return HttpServerResponse.jsonUnsafe({
				value: {
					models,
					default: allowedModel(settings, catalog.default),
					mcp: mcpServers(m, authority),
					...(authority.admin
						? {
								admin: {
									catalog: catalog.models,
									settings,
									spent: yield* spent(db, null),
									// the policies a member can hold: those a source team names (automation and kiosk policies hold no member)
									policies: [
										...new Set(
											Object.values(m.teams).flatMap((team) =>
												'policies' in team ? team.policies : team
											)
										)
									].sort()
								}
							}
						: {})
				}
			});
		})
	},
	[`GET ${PATHS.agent}` as const]: {
		guest: false,
		run: Effect.fn('protocol.transcript')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const p = requestUrl(request).searchParams,
				id = p.get('conversation') ?? '',
				conversation = yield* conversationFor(authority, id);
			const before = Number(p.get('before')),
				limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
			const raw = yield* (yield* Agents).transcript(
				id,
				p.has('before') && Number.isFinite(before) ? { before, limit } : undefined
			);
			return HttpServerResponse.jsonUnsafe({
				value: {
					status: conversation.status,
					rows: raw.flatMap(
						(row) => transcriptRow(row, isStaff(authority), conversation.integration !== null) ?? []
					),
					...(p.has('before') ? { more: raw.length === limit, first: raw[0]?.seq ?? before } : {})
				}
			});
		})
	},
	[`GET ${PATHS.approval}` as const]: {
		guest: false,
		run: Effect.fn('protocol.approval')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const p = requestUrl(request).searchParams,
				approvals = yield* Approvals,
				reads = yield* Reads,
				b = yield* bindings,
				m = yield* Manifest;
			const readable = (model: string, id: string) =>
				viewGet(m, authority, model, id).pipe(
					Effect.flatMap((read) => reads.run([read], { as: 'caller', authority }, b)),
					Effect.map(([row]) => row !== null && row !== undefined),
					Effect.catchTag('BoltError', () => Effect.succeed(false))
				);
			const id = p.get('id');
			// an absent repeated param filters nothing; `[]` would match no request
			const many = (key: string) => (p.has(key) ? p.getAll(key) : undefined);
			if (id === null)
				return HttpServerResponse.jsonUnsafe({
					value: yield* approvals.list(
						{
							...(p.get('model') === null ? {} : { model: p.get('model') ?? '' }),
							records: many('record'),
							ids: many('request'),
							all: p.get('all') === '1'
						},
						authority,
						readable
					)
				});
			const view = yield* approvals.view(id, authority, readable);
			return Option.isNone(view)
				? response_error(BoltError.make('not_found', 'admission', 'Not found or no access.'))
				: HttpServerResponse.jsonUnsafe({ value: view.value });
		})
	},
	[`GET ${PATHS.record_capabilities}` as const]: {
		guest: false,
		run: Effect.fn('protocol.capabilities')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const p = requestUrl(request).searchParams,
				model = p.get('model'),
				id = p.get('id');
			if (!model || !id) return yield* Effect.fail(invalid('model and id are required'));
			if ([...p.keys()].some((key) => !['model', 'id', 'parent_model', 'parent_id', 'relation', 'parent_revision'].includes(key)))
				return yield* Effect.fail(invalid('Unknown record capability parameter.'));
			const pc = p.get('parent_model'),
				pi = p.get('parent_id'),
				relation = p.get('relation'),
				revision = p.get('parent_revision');
			const parent =
				pc === null && pi === null && relation === null && revision === null
					? undefined
					: pc &&
						  pi &&
						  relation &&
						  revision !== null &&
						  Number.isSafeInteger(Number(revision)) &&
						  Number(revision) > 0
						? { model: pc, id: pi, relation, revision: Number(revision) }
						: null;
			if (parent === null)
				return yield* Effect.fail(
					invalid('a nested capability read requires its parent model, id, relation and revision')
				);
			const m = yield* Manifest,
				reads = yield* Reads,
				b = yield* bindings;
			const value = yield* record_capabilities(
				yield* probe,
				model,
				id,
				authority,
				b,
				(c, i): Effect.Effect<RowData | null, EngineError> =>
					viewGet(m, authority, c, i)
						.pipe(
							Effect.flatMap((read) => reads.run([read], { as: 'caller', authority }, b)),Effect.map(([row]) => (Schema.is(JsonObject)(row) ? row : null))),
				parent
			);
			return value === null
				? response_error(BoltError.make('not_found', 'admission', 'Not found or no access.'))
				: HttpServerResponse.jsonUnsafe({ value });
		})
	},
	[`GET ${PATHS.openapi}` as const]: {
		guest: false,
		run: Effect.fn('protocol.openapi')(function* (
			_request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const m = yield* Manifest;
			return HttpServerResponse.jsonUnsafe(openapi(m, authority, client_contract(m)));
		})
	}
} as const;
const routeOf = (request: HttpServerRequest.HttpServerRequest) =>
	Object.entries(BoltRoutes).find(
		([key]) => key === `${request.method} ${requestUrl(request).pathname}`
	)?.[1];
export const needs_guest = Effect.fn('protocol.needsGuest')(
	function* (request: HttpServerRequest.HttpServerRequest) {
		const url = requestUrl(request);
		const path = url.pathname;
		// Provider callbacks and instance management must remain reachable while guest slots are held.
		if (path.startsWith(PATHS.files))
			return (
				(request.method === 'GET' || request.method === 'HEAD') &&
				/^(64|512|1024)$/.test(url.searchParams.get('preview') ?? '')
			);
		if (path.startsWith(HOOKS) || path === OAUTH_CALLBACK) return false;
		// Studio runs on the host (source, builds, cutover); admitted, its publish would wait out its own drain
		if (path.startsWith(`${BOLT}/shell/studio`)) return false;
		if (path.startsWith(INTEGRATIONS))
			return request.method === 'POST' && path.slice(INTEGRATIONS.length).split('/')[1] === 'test';
		const route = routeOf(request);
		if (route === undefined) return true;
		if (typeof route.guest === 'boolean') return route.guest;
		const reads =
			route.guest === 'reads'
				? (yield* requestBody(request, QBody)).reads
				: ((yield* requestBody(request, LiveBody)).add?.map((view) => view.read) ?? []);
		return reads.some((read) => {
			if (read.m !== 'query') return false;
			const [request] = read.a;
			// a layer map is JSON read by the store; only a search body (an index's or semantic search) runs guest code
			return (
				!Schema.is(JsonObject)(request) ||
				Object.values(request).some(
					(layer) => !Schema.is(JsonObject)(layer) || Schema.is(JsonObject)(layer['search'])
				)
			);
		});
	},
	Effect.catch(() => Effect.succeed(true))
);
export const bolt_routes = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const route = routeOf(request);
		if (route === undefined) return Option.none<HttpServerResponse.HttpServerResponse>();
		const authority = yield* (yield* SessionAuthority).of(request);
		if (Option.isNone(authority))
			return Option.some(
				HttpServerResponse.jsonUnsafe(
					{ error: { code: 'unauthenticated', message: 'Sign in first.' } },
					{ status: 401 }
				)
			);
		return Option.some(yield* route.run(request, authority.value));
	}).pipe(
		Effect.catch((e) => Effect.succeed(Option.some(response_error(e)))),
		Effect.catchCause((cause) =>
			Effect.logWarning(cause).pipe(Effect.as(Option.some(response_error(cause))))
		)
	);

function openapi(m: EngineManifest, authority: Authority, version: string): Json {
	const may = (model: string, verb: 'read' | 'create' | 'update' | 'delete') =>
		verb === 'read'
			? readsAny(authority, model)
			: authority.admin || (authority.models[model]?.[verb]?.length ?? 0) > 0;
	const exposed = Object.keys(m.exposures);
	const catalog = catalog_of(m),
		relation_index = relations(m);
	const target = (model: string): Json => ({
		type: 'object',
		required: catalog.models.get(model)?.audit === true ? ['id', 'revision'] : ['id'],
		properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 0 } }
	});
	const list = (items: Json): Json => ({ type: 'array', items });
	const update = (model: string, set: Json): Json => ({
		type: 'object', additionalProperties: false, required: ['target', 'set'],
		properties: { target: target(model), set }
	});
	/** Follow the same compiled column paths and root grant arms as write admission, including child actions. */
	const input = (
		root: string,
		model: string,
		path: string,
		verb: 'create' | 'update',
		mode = verb,
		parent?: string
	): Json => {
		const declared = m.exposures[root]?.[verb]?.columns ?? {};
		const held = (declared[path] ?? []).filter((field) =>
			field !== parent && (authority.admin ||
				(authority.models[root]?.[verb] ?? []).some((arm) => arm.columns[path]?.includes(field)))
		);
		const properties: Record<string, Json> = {};
		for (const field of held) {
			const kind = m.models[model]?.fields[field],
				relation = m.relationships[`${model}.${field}`];
			if (kind !== undefined) properties[field] = json_schema(kind);
			else if (relation !== undefined) properties[field] = json_schema({ kind: 'ref', ...relation });
		}
		for (const at of Object.keys(declared)) {
			const name = at.startsWith(`${path}.`) ? at.slice(path.length + 1) : '';
			if (name === '' || name.includes('.') || (!authority.admin &&
				!(authority.models[root]?.[verb] ?? []).some((arm) => Object.hasOwn(arm.columns, at))))
				continue;
			const relation = relation_index.inverse.get(`${model}.${name}`);
			if (relation === undefined) continue;
			const child = input(root, relation.from, at, verb, 'create', relation.fk),
				row = target(relation.from);
			properties[name] = mode === 'create'
				? list(relation.spec.owned ? child : { oneOf: [child, row] })
				: {
					type: 'object', additionalProperties: false,
					properties: {
						create: list(child),
						update: list(update(relation.from, input(root, relation.from, at, verb, 'update', relation.fk))),
						delete: list(row),
						...(relation.spec.owned ? {} : { link: list(row) }),
						...(!relation.spec.owned && relation.spec.optional ? { unlink: list(row) } : {})
					}
				};
		}
		// Transform-filled fields and defaults are judged by the write engine; submitted columns retain their native kinds.
		return { type: 'object', additionalProperties: false, properties };
	};
	const writes = Object.fromEntries(exposed.flatMap((model) =>
		(['create', 'update', 'delete'] as const)
			.filter((verb) => m.exposures[model]?.[verb] !== undefined && may(model, verb))
			.map((verb): [string, Json] => [
				`${model}.${verb}`,
				list(verb === 'create'
					? input(model, model, model, verb)
					: verb === 'update'
						? update(model, input(model, model, model, verb))
						: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: target(model) } })
			])
	));
	const automations = (authority.admin ? Object.keys(m.automations) : authority.automations)
		.filter((name) => m.automations[name] !== undefined);
	const run_inputs = automations.flatMap((name): Json[] => {
		const automation = m.automations[name];
		if (automation === undefined) return [];
		const start = {
			input: json_schema({ kind: 'object', fields: automation_fields(automation.input) }),
			id: { type: 'string' }
		};
		return [
			{
				type: 'object', additionalProperties: false, required: ['automation'],
				properties: { automation: { const: name }, ...start }
			},
			{
				type: 'object', additionalProperties: false, required: ['automation', 'runs'],
				properties: {
					automation: { const: name },
					runs: { type: 'array', minItems: 1, items: {
						type: 'object', additionalProperties: false, required: ['id'], properties: start
					} }
				}
			}
		];
	});
	const body = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
	const responses = {
		200: { description: 'answered' },
		202: { description: 'pending_approval, or running: the act continues as the named run' },
		401: { description: 'unauthenticated' },
		422: { description: 'refused' }
	};
	return {
		openapi: '3.1.0',
		info: { title: 'Bolt workspace', version },
		components: { securitySchemes: { api_key: { type: 'http', scheme: 'bearer' } } },
		security: [{ api_key: [] }],
		paths: {
			[PATHS.sync_control]: {
				post: {
					operationId: 'sync_control',
					description: 'Native manual refresh or file transfer. Requires a member and the relevant sync capability or file grants; this is not an automation start.',
					parameters: [
						{ name: HEADERS.key, in: 'header', required: true, description: 'The same uuidv7 as body.id.', schema: { type: 'string' } },
						{ name: HEADERS.contract, in: 'header', schema: { type: 'string', const: version } }
					],
					requestBody: body({
						type: 'object', additionalProperties: false, required: ['model', 'sync', 'id', 'input', 'issued_at'],
						properties: {
							model: { type: 'string' }, sync: { type: 'string' },
							id: { type: 'string', format: 'uuid' }, issued_at: { type: 'string', format: 'date-time' },
							input: { type: 'object', description: 'Remote: { instance?, partition? }. File: { mode: import, file, context? } or { mode: template | export, format?, to?, where?, context? }.' }
						}
					}),
					responses
				}
			},
			[PATHS.q]: {
				post: {
					operationId: 'q',
					requestBody: body({
						type: 'object',
						required: ['reads'],
						properties: {
							reads: {
								type: 'array',
								items: {
									type: 'object',
									required: ['m', 'a'],
									properties: {
										m: { enum: ['query', 'aggregate', 'history'] },
										a: {
											type: 'array',
											prefixItems: [
												{
													enum: exposed.filter((model) => may(model, 'read'))
												}
											]
										}
									}
								}
							}
						}
					}),
					responses
				}
			},
			[PATHS.act]: {
				post: {
					operationId: 'act',
					parameters: [
						{ name: HEADERS.key, in: 'header', required: true, schema: { type: 'string' } },
						{ name: HEADERS.contract, in: 'header', schema: { type: 'string', const: version } }
					],
					requestBody: body({
						oneOf: [
							{
								type: 'object', additionalProperties: false, required: ['acts', 'issued_at'],
								properties: {
									acts: { type: 'object', additionalProperties: false, properties: writes },
									issued_at: { type: 'string', format: 'date-time' }
								}
							},
							...(run_inputs.length === 0 ? [] : [{
								type: 'object', additionalProperties: false, required: ['callable', 'input', 'issued_at'],
								properties: {
									callable: { const: 'run' }, input: { oneOf: run_inputs },
									issued_at: { type: 'string', format: 'date-time' }
								}
							}])
						]
					}),
					responses
				}
			}
		}
	};
}
