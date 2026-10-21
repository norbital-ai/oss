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
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import type { Json } from '../decl/values.ts';
import type { Authority, Bindings, Outcome, RowData } from '../engine/contracts.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import {
	Conflict,
	Fenced,
	IdentityRefusal,
	Interrupted,
	type DbError,
	type EngineError
} from '../engine/errors.ts';
import { BoltError, CODE } from './errors.ts';
import { addressBucket, chargesFor, macKey, RateWindows } from '../engine/access/rate.ts';
import { loadKeys } from '../engine/identity/session.ts';
import { admitVisitor, parseCallable } from '../engine/callables/index.ts';
import { AgentBackground, agentCallables, conversationFor } from '../engine/agent/callables.ts';
import { isStaff, transcriptRow } from '../engine/agent/schema.ts';
import { mcpServers } from '../engine/agent/mcp.ts';
import { agentSettings, allowedModel, spent } from '../engine/agent/settings.ts';
import { lowerRead } from '../engine/query/engine.ts';
import { lowerKeyedMember } from '../engine/query/keyed.ts';
import { fingerprint, schemaSlice } from '../engine/schema/plan.ts';
import { recordCapabilities } from '../engine/write/act.ts';
import { restorePreview, restoreRecord } from '../engine/write/restore.ts';
import { subscribe } from '../engine/runs/push.ts';
import { actorRef } from '../engine/write/commit.ts';
import { filterDescribe } from '../engine/filter-describe/index.ts';
import type { RateCharge } from '../engine/write/commit.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import {
	Manifest,
	Reads,
	Writes,
	Callables,
	Approvals,
	Live,
	Agents,
	type AgentCallables
} from '../engine/services.ts';
import type { ReadIR } from './ir-types.ts';
import {
	ActBody,
	LiveBody,
	NoticeRow,
	OwnCall,
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
	noticePath,
	redact,
	statusOf,
	uuidv7Within,
	wireError
} from './wire.ts';
import { HOOKS, OAUTH_CALLBACK } from '../engine/integrations/links.ts';
import { sseResponse } from './sse.ts';
import type { Handler } from './host.ts';

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
		readonly ipBucket: (address: string) => string;
		readonly charge: (
			charges: Parameters<RateWindows['charge']>[0],
			now: number
		) => Effect.Effect<ReturnType<RateWindows['charge']>>;
	}
>()('bolt/RateLimits') {
	static readonly layer = Layer.effect(
		RateLimits,
		Effect.gen(function* () {
			const windows = yield* Ref.make(new RateWindows());
			const keys = yield* loadKeys(yield* TenantDb);
			return {
				ipBucket: (address: string) => macKey(keys.ipMac, addressBucket(address)),
				charge: (charges: Parameters<RateWindows['charge']>[0], now: number) =>
					Ref.modify(windows, (w) => [w.charge(charges, now), w])
			};
		})
	);
}

export const requestUrl = (request: HttpServerRequest.HttpServerRequest) =>
	new URL(request.url, 'http://bolt.local');
export const header = (request: HttpServerRequest.HttpServerRequest, name: string) =>
	request.headers[name.toLowerCase()];
export const invalid = (message: string) => BoltError.make('invalid', 'decode', message);
export const responseError = (error: unknown) => {
	if (error instanceof IdentityRefusal)
		return HttpServerResponse.jsonUnsafe(
			{ error: { code: error.code, message: error.message } },
			{
				status: CODE[error.code].status,
				...(error.retryAfter === undefined
					? {}
					: { headers: { 'retry-after': String(error.retryAfter) } })
			}
		);
	if (error instanceof Conflict)
		return HttpServerResponse.jsonUnsafe(
			{ error: { code: 'conflict', message: 'Another write changed these records.' } },
			{ status: 409 }
		);
	if (error instanceof Fenced)
		return HttpServerResponse.jsonUnsafe(
			{ error: { code: 'fenced', message: error.message } },
			{ status: 500 }
		);
	if (error instanceof Interrupted)
		return HttpServerResponse.jsonUnsafe(
			{ error: { code: 'interrupted', message: 'The workspace generation is closed.' } },
			{ status: 500 }
		);
	const { body, status } = wireError(error);
	return HttpServerResponse.jsonUnsafe(body, { status });
};
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
		const hit = decoded.get(schema);
		if (hit !== undefined)
			return yield* hit.pipe(
				Effect.flatMap((value) =>
					Schema.is(Schema.toType(schema))(value)
						? Effect.succeed(value)
						: Effect.fail(invalid('A cached body did not match its route.'))
				)
			);
		const value = yield* Effect.cached(
			request.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })),
				Effect.mapError((e) => invalid(String(e)))
			)
		);
		decoded.set(schema, value);
		return yield* value;
	});
export const bindings = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis;
	const m = yield* Manifest;
	return {
		now: new Date(now).toISOString(),
		today: new Intl.DateTimeFormat('en-CA', {
			timeZone: m.workspace.tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		}).format(new Date(now)),
		tz: m.workspace.tz,
		params: {}
	} satisfies Bindings;
});
const committed = (output: Json): Outcome => ({ kind: 'committed', output, records: [] });
const JsonObject = Schema.Record(Schema.String, Schema.Json);
type ActRateAdmission = {
	readonly verdict: ReturnType<RateWindows['charge']>;
	readonly charges: readonly RateCharge[];
};
const actAdmissions = new WeakMap<
	HttpServerRequest.HttpServerRequest,
	Effect.Effect<ActRateAdmission, EngineError, RateLimits>
>();
/** Shell admission and dispatch share one charge; direct protocol hosts use the same native peer address. */
export const requestActRate = Effect.fn('protocol.requestActRate')(function* (
	request: HttpServerRequest.HttpServerRequest,
	authority: Authority
): Effect.fn.Return<ActRateAdmission, EngineError, RateLimits> {
	const existing = actAdmissions.get(request);
	if (existing !== undefined) return yield* existing;
	const admission = yield* Effect.cached(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const limits = yield* RateLimits;
			const ip = authority.limits.some((rule) => rule.per === 'ip')
				? limits.ipBucket(Option.getOrElse(request.remoteAddress, () => '0.0.0.0'))
				: undefined;
			const who = {
				...(authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}),
				...(ip === undefined ? {} : { ip })
			};
			const common = chargesFor(
				authority,
				['act', ...(authority.actor.kind === 'visitor' ? ['register'] : [])],
				who
			);
			const persistent = (charges: ReturnType<typeof chargesFor>): readonly RateCharge[] =>
				charges.map((charge) => ({
					rule: charge.rule,
					bucket: charge.bucket,
					limit: charge.limit,
					windowStart: new Date(now - (now % charge.windowMs)).toISOString()
				}));
			const verdict = yield* limits.charge(common, now);
			if (!verdict.ok) return { verdict, charges: persistent(common) };
			const body = yield* requestBody(request, ActBody);
			const named = chargesFor(authority, [body.callable], who).filter(
				(charge) =>
					!common.some((prior) => prior.rule === charge.rule && prior.bucket === charge.bucket)
			);
			return {
				verdict: yield* limits.charge(named, now),
				charges: persistent([...common, ...named])
			};
		})
	);
	actAdmissions.set(request, admission);
	return yield* admission;
});
/** Public page loaders and wire reads obey the same visitor surface restrictions. */
export const readAdmitted = (
	authority: Authority,
	read: { readonly kind: string; readonly collection?: string | undefined } | undefined
): boolean =>
	authority.actor.kind !== 'visitor' ||
	(read !== undefined &&
		(read.kind === 'read' || read.kind === 'get') &&
		typeof read.collection === 'string' &&
		admitVisitor(authority, { read: read.collection }) === null);
const readAdmissions = new WeakMap<
	HttpServerRequest.HttpServerRequest,
	Effect.Effect<ReturnType<RateWindows['charge']>, never, RateLimits>
>();
/** Charge one visitor read request before decoding or running its loader. */
export const requestReadRate = Effect.fn('protocol.requestReadRate')(function* (
	request: HttpServerRequest.HttpServerRequest,
	authority: Authority
) {
	if (authority.actor.kind !== 'visitor') return { ok: true } as const;
	const existing = readAdmissions.get(request);
	if (existing !== undefined) return yield* existing;
	const admission = yield* Effect.cached(
		Effect.gen(function* () {
			const limits = yield* RateLimits;
			return yield* limits.charge(
				chargesFor(authority, ['read'], {
					ip: limits.ipBucket(Option.getOrElse(request.remoteAddress, () => '0.0.0.0'))
				}),
				yield* Clock.currentTimeMillis
			);
		})
	);
	readAdmissions.set(request, admission);
	return yield* admission;
});
const liveViewAdmitted = (authority: Authority, read: WireRead | undefined): boolean =>
	readAdmitted(
		authority,
		read !== undefined && typeof read.a[0] === 'string'
			? { kind: read.m, collection: read.a[0] }
			: undefined
	);

export type ActCall = {
	readonly callable: string;
	readonly input: Json;
	readonly key: string;
	readonly issuedAt: string;
	readonly retry?: boolean | undefined;
	readonly observed?: { readonly [id: string]: number } | undefined;
	readonly onConflict?: 'update' | 'keep' | undefined;
	readonly rate?: readonly RateCharge[] | undefined;
};
export const dispatchAct = Effect.fn('protocol.dispatchAct')(function* (
	call: ActCall,
	authority: Authority,
	request?: HttpServerRequest.HttpServerRequest
) {
	const m = yield* Manifest,
		live = yield* Live,
		b = yield* bindings;
	const admitted = request === undefined ? undefined : yield* requestActRate(request, authority);
	if (admitted !== undefined && !admitted.verdict.ok)
		return {
			outcome: {
				kind: 'refused',
				code: 'rateLimited',
				message: `Too many requests; retry in ${admitted.verdict.retryAfter} s.`
			} satisfies Outcome,
			v: yield* live.v
		};
	const own = yield* AgentCallTable;
	const agent = own[call.callable];
	if (agent !== undefined) {
		const input = yield* Schema.decodeUnknownEffect(agent.input)(call.input).pipe(
			Effect.mapError((e) => invalid(String(e)))
		);
		if (call.callable === 'sys_message.post') {
			const verdict = yield* (yield* RateLimits).charge(
				chargesFor(
					authority,
					['agent'],
					authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}
				),
				Date.parse(b.now)
			);
			if (!verdict.ok)
				return {
					outcome: {
						kind: 'refused',
						code: 'rateLimited',
						message: `Too many requests; retry in ${verdict.retryAfter} s.`
					} satisfies Outcome,
					v: yield* live.v
				};
		}
		const output = yield* agent.run(input, authority);
		return { outcome: committed(output), v: yield* live.v };
	}
	if (
		[
			'start',
			'approvals.process',
			'filter.describe',
			'filter.options',
			'sys_notification.markRead',
			'history.preview',
			'history.restore'
		].includes(call.callable)
	) {
		const decoded = yield* Schema.decodeUnknownEffect(OwnCall)({
			callable: call.callable,
			input: call.input
		}).pipe(Effect.mapError((e) => invalid(String(e))));
		let outcome: Outcome;
		if (decoded.callable === 'start') {
			const runs = ('runs' in decoded.input ? decoded.input.runs : [decoded.input]).map((run) => ({
				id: run.id,
				input: run.input ?? {}
			}));
			outcome = runs.every((run) => uuidv7Within(run.id, Date.parse(b.now)))
				? yield* (yield* Callables).start({
						automation: decoded.input.automation,
						runs,
						authority,
						bindings: b
					})
				: {
						kind: 'refused',
						code: 'invalidInput',
						message: 'A run id is a uuidv7 minted within 24 hours.',
						field: 'id'
					};
		} else if (decoded.callable === 'approvals.process') {
			const decision = yield* (yield* Approvals).process({
				...decoded.input,
				authority,
				now: b.now
			});
			outcome =
				decision.kind === 'decided'
					? committed({ requestId: decision.requestId, status: decision.status })
					: decision;
		} else if (decoded.callable === 'sys_notification.markRead') {
			if (authority.actor.kind !== 'member' || authority.actor.external)
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'Only staff members have an inbox.')
				);
			const db = yield* TenantDb;
			yield* db.write({
				text: 'UPDATE sys_notification SET read_at = $4::timestamptz WHERE member = $1 AND ($2::boolean OR id IN (SELECT jsonb_array_elements_text($3::jsonb))) AND read_at IS NULL',
				params: [
					authority.actor.id,
					'all' in decoded.input,
					'ids' in decoded.input ? decoded.input.ids : [],
					b.now
				]
			});
			live.syncChanged('sys_notification');
			outcome = committed(null);
		} else if (decoded.callable === 'history.preview') {
			const previewed = yield* restorePreview(
				{ manifest: m, db: yield* TenantDb },
				decoded.input,
				authority,
				b
			);
			outcome = previewed.ok ? committed(previewed.preview) : previewed.outcome;
		} else if (decoded.callable === 'history.restore') {
			const writes = yield* Writes;
			const restored = yield* restoreRecord(
				{ manifest: m, db: yield* TenantDb },
				writes.act,
				decoded.input,
				{
					...call,
					...(admitted === undefined ? {} : { rate: [...(call.rate ?? []), ...admitted.charges] }),
					authority,
					bindings: b,
					invocationId: yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
						Effect.mapError((error) =>
							BoltError.make(
								'unavailable',
								'facility',
								'Secure random UUID generation failed.',
								error
							)
						)
					)
				}
			);
			return { outcome: restored.outcome, v: restored.v ?? (yield* live.v) };
		} else {
			const filters = yield* filterDescribe;
			if (decoded.callable === 'filter.describe') {
				const verdict = yield* (yield* RateLimits).charge(
					chargesFor(
						authority,
						['agent'],
						authority.actor.kind === 'member' ? { actor: authority.actor.id } : {}
					),
					Date.parse(b.now)
				);
				if (!verdict.ok)
					return {
						outcome: {
							kind: 'refused',
							code: 'rateLimited',
							message: `Too many requests; retry in ${verdict.retryAfter} s.`
						} satisfies Outcome,
						v: yield* live.v
					};
				const result = yield* filters.describe({
					collection: decoded.input.collection,
					text: decoded.input.text,
					authority,
					bindings: b,
					...(decoded.input.fields === undefined ? {} : { localFields: decoded.input.fields })
				});
				outcome = result.ok
					? committed({
							...(result.where === undefined ? {} : { where: result.where }),
							...(result.orderBy === undefined ? {} : { orderBy: result.orderBy })
						})
					: {
							kind: 'refused',
							code: result.code === 'notFound' ? 'notFound' : 'invalidInput',
							message: result.message
						};
			} else if (decoded.callable === 'filter.options') {
				const result = yield* filters.options({
					collection: decoded.input.collection,
					authority,
					bindings: b,
					...(decoded.input.fields === undefined ? {} : { localFields: decoded.input.fields })
				});
				outcome = result.ok
					? committed({ fields: result.fields })
					: {
							kind: 'refused',
							code: result.code === 'notFound' ? 'notFound' : 'invalidInput',
							message: result.message
						};
			} else return yield* Effect.fail(invalid('Unknown own callable.'));
		}
		return { outcome, v: yield* live.v };
	}
	const parsed = parseCallable(call.callable, m);
	if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
	const callable = parsed.success;
	const context = {
		...call,
		...(admitted === undefined ? {} : { rate: [...(call.rate ?? []), ...admitted.charges] }),
		authority,
		bindings: b,
		invocationId: yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		)
	};
	if (callable._tag === 'Verb')
		return yield* (yield* Writes).act({
			...context,
			collection: callable.collection,
			verb: callable.verb,
			mode: { _tag: 'Direct' }
		});
	if (callable._tag === 'Action')
		return yield* (yield* Callables).action({
			...context,
			collection: callable.collection,
			action: callable.action,
			from: 'Client'
		});
	return yield* Effect.fail(
		BoltError.make('unknownCallable', 'decode', `there is no callable '${call.callable}'`)
	);
});

const lower = Effect.fn('protocol.lowerRead')(function* (
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
			collection: 'sys_message',
			conversation: id,
			thread: conversation.integration !== null,
			...(Option.isSome(start) ? { from: start.value.seq } : {})
		};
	}
	if (read.m === 'conversations' || read.m === 'inbox') {
		if (authority.actor.kind !== 'member' || (read.m === 'inbox' && authority.actor.external))
			return yield* Effect.fail(
				BoltError.make('forbidden', 'admission', 'Not available to this member.')
			);
		if (read.m === 'conversations')
			return { kind: 'conversations', collection: 'sys_conversation', member: authority.actor.id };
		const options = read.a[0];
		return {
			kind: 'inbox',
			collection: 'sys_notification',
			member: authority.actor.id,
			...(Schema.is(JsonObject)(options) && options['requests'] === true ? { requests: true } : {})
		};
	}
	return yield* Effect.try({
		try: () => lowerRead(m, read.m, read.a),
		catch: (e) => (e instanceof BoltError ? e : invalid(String(e)))
	});
});

type LoweredQRead = {
	readonly keys: readonly string[] | null;
	readonly reads: readonly ReadIR[];
};
const lowerQRead = Effect.fn('protocol.lowerQRead')(function* (
	authority: Authority,
	read: WireRead,
	scope: number
): Effect.fn.Return<LoweredQRead, EngineError, Manifest | TenantDb> {
	const set = read.a[0];
	if (read.m !== 'read' || !Schema.is(JsonObject)(set))
		return { keys: null, reads: [yield* lower(authority, read)] };
	if (read.a.length !== 1)
		return yield* Effect.fail(invalid('a keyed read takes one set argument'));
	const m = yield* Manifest;
	const earlier = new Set<string>();
	const members = yield* Effect.forEach(Object.entries(set), ([key, spec]) =>
		Effect.try({
			try: () => {
				const ir = lowerKeyedMember(
					'read',
					key,
					spec,
					(method, args) => lowerRead(m, method, args),
					`q:${scope}`,
					earlier
				);
				earlier.add(key);
				return ir;
			},
			catch: (error) => (error instanceof BoltError ? error : invalid(String(error)))
		})
	);
	return { keys: Object.keys(set), reads: members };
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

export const BoltRoutes = {
	[`POST ${PATHS.q}` as const]: {
		guest: 'reads',
		run: Effect.fn('protocol.q')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const body = yield* requestBody(request, QBody);
			if (body.reads.some((r) => ['transcript', 'inbox', 'conversations'].includes(r.m)))
				return yield* Effect.fail(invalid('This read is live-only.'));
			const groups = yield* Effect.forEach(body.reads, (read, index) =>
				lowerQRead(authority, read, index)
			);
			const batch = groups.flatMap((group) => group.reads);
			const values = yield* (yield* Reads).run(batch, { as: 'caller', authority }, yield* bindings);
			if (values.length !== batch.length)
				return yield* Effect.fail(
					BoltError.make(
						'badAnswer',
						'deliver',
						`The reader returned ${values.length} answers for ${batch.length} reads.`
					)
				);
			const answers: Json[] = [];
			let offset = 0;
			for (const group of groups) {
				if (group.keys === null) {
					const value = values[offset++];
					if (value === undefined)
						return yield* Effect.fail(
							BoltError.make('badAnswer', 'deliver', 'The reader omitted a read answer.')
						);
					answers.push(value);
				} else {
					const keyed: (readonly [string, Json])[] = [];
					for (const key of group.keys) {
						const value = values[offset++];
						if (value === undefined)
							return yield* Effect.fail(
								BoltError.make('badAnswer', 'deliver', `The reader omitted member '${key}' answer.`)
							);
						keyed.push([key, value]);
					}
					answers.push(Object.fromEntries(keyed));
				}
			}
			return HttpServerResponse.jsonUnsafe({ answers });
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
			const stated = header(request, HEADERS.contract),
				contract = fingerprint(schemaSlice(yield* Manifest));
			if (stated !== undefined && stated !== contract)
				return HttpServerResponse.jsonUnsafe(
					{
						outcome: {
							kind: 'refused',
							code: 'releaseChanged',
							message: 'The workspace was updated; reload the page.'
						},
						v: yield* live.v
					},
					{ status: 409 }
				);
			const { outcome, v } = yield* dispatchAct(
				{ ...body, key, retry: header(request, HEADERS.retry) === '1' },
				authority,
				request
			);
			return HttpServerResponse.jsonUnsafe(
				{ outcome: redact(outcome, authority.actor), v },
				{ status: statusOf(outcome) }
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
				if (frame.t !== 'answer') return none;
				const replay = first;
				first = false;
				const rows: readonly NoticeRow[] = replay
					? Number.isNaN(since)
						? []
						: Option.match(inboxPage(frame.value), {
								onNone: () => [],
								onSome: (page) =>
									page.rows
										.flatMap((row) => Option.toArray(inboxRow(row)))
										.filter((row) => !row.read && Date.parse(row.at) > since)
										.reverse()
							})
					: (frame.arrivals ?? []).flatMap((row) => Option.toArray(inboxRow(row)));
				return rows.map((row) => ({
					id: row.id,
					title: row.title,
					body: row.body,
					path: noticePath(row.link),
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
			const body = yield* requestBody(request, LiveBody),
				live = yield* Live,
				owner = yield* live.authorityOf(body.conn);
			if (Option.isSome(owner) && actorRef(owner.value.actor) !== actorRef(authority.actor))
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'the live connection belongs to another session')
				);
			if (Option.isSome(owner) && owner.value.key !== authority.key)
				yield* live.authorize(body.conn, authority);
			yield* Effect.forEach(body.drop ?? [], (view) => live.drop(body.conn, view));
			const errors = yield* Effect.forEach(
				body.add ?? [],
				(view) =>
					Effect.gen(function* () {
						if (!liveViewAdmitted(authority, view.read))
							return yield* Effect.fail(
								BoltError.make('forbidden', 'admission', 'Visitors may not do this.')
							);
						yield* live.register(body.conn, view.view, {
							read: yield* lower(authority, view.read),
							...(view.every === undefined ? {} : { every: view.every }),
							...(view.on === undefined ? {} : { on: view.on })
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
					BoltError.make('forbidden', 'admission', 'Only staff members receive notices.')
				);
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
					BoltError.make('forbidden', 'admission', 'Only staff members receive notices.')
				);
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
					BoltError.make('forbidden', 'admission', 'The assistant is not available to you here.')
				);
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
			// a publish or rollback that restarted the workspace under this conversation gets its closing reply on open
			if (!p.has('before')) yield* (yield* Agents).resumeSettled(id);
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
			const readable = (collection: string, id: string) =>
				reads.run([lowerRead(m, 'get', [collection, id])], { as: 'caller', authority }, b).pipe(
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
							...(p.get('collection') === null ? {} : { collection: p.get('collection') ?? '' }),
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
				? responseError(BoltError.make('notFound', 'admission', 'Not found or no access.'))
				: HttpServerResponse.jsonUnsafe({ value: view.value });
		})
	},
	[`GET ${PATHS.recordCapabilities}` as const]: {
		guest: false,
		run: Effect.fn('protocol.capabilities')(function* (
			request: HttpServerRequest.HttpServerRequest,
			authority: Authority
		) {
			const p = requestUrl(request).searchParams,
				collection = p.get('collection'),
				id = p.get('id');
			if (!collection || !id) return yield* Effect.fail(invalid('collection and id are required'));
			const pc = p.get('parentCollection'),
				pi = p.get('parentId'),
				relation = p.get('relation'),
				revision = p.get('parentRevision');
			const parent =
				pc === null && pi === null && relation === null && revision === null
					? undefined
					: pc &&
						  pi &&
						  relation &&
						  revision !== null &&
						  Number.isSafeInteger(Number(revision)) &&
						  Number(revision) > 0
						? { collection: pc, id: pi, relation, revision: Number(revision) }
						: null;
			if (parent === null)
				return yield* Effect.fail(
					invalid(
						'a nested capability read requires its parent collection, id, relation and revision'
					)
				);
			const m = yield* Manifest,
				db = yield* TenantDb,
				reads = yield* Reads,
				b = yield* bindings;
			const value = yield* recordCapabilities(
				{ manifest: m, db },
				collection,
				id,
				authority,
				b,
				(c, i): Effect.Effect<RowData | null, EngineError> =>
					reads
						.run([lowerRead(m, 'get', [c, i])], { as: 'caller', authority }, b)
						.pipe(Effect.map(([row]) => (Schema.is(JsonObject)(row) ? row : null))),
				parent
			);
			return value === null
				? responseError(BoltError.make('notFound', 'admission', 'Not found or no access.'))
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
			return HttpServerResponse.jsonUnsafe(openapi(m, authority, fingerprint(schemaSlice(m))));
		})
	}
} as const;
const routeOf = (request: HttpServerRequest.HttpServerRequest) =>
	Object.entries(BoltRoutes).find(
		([key]) => key === `${request.method} ${requestUrl(request).pathname}`
	)?.[1];
export const needsGuest = Effect.fn('protocol.needsGuest')(
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
		return reads.some((read) => read.m === 'query' || read.m === 'similar');
	},
	Effect.catch(() => Effect.succeed(true))
);
export const boltRoutes = (request: HttpServerRequest.HttpServerRequest) =>
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
		Effect.catch((e) => Effect.succeed(Option.some(responseError(e)))),
		Effect.catchCause((cause) =>
			Effect.logWarning(cause).pipe(Effect.as(Option.some(responseError(cause))))
		)
	);

function openapi(m: EngineManifest, authority: Authority, version: string): Json {
	const may = (collection: string, verb: 'read' | 'create' | 'update' | 'delete') =>
		authority.admin || (authority.collections[collection]?.[verb].length ?? 0) > 0;
	const named = (collection: string, part: 'queries' | 'actions') =>
		Object.entries(m.collections[collection]?.[part] ?? {})
			.filter(
				([name, spec]) =>
					spec.internal !== true &&
					(authority.admin || authority.collections[collection]?.[part].includes(name))
			)
			.map(([name]) => `${collection}.${name}`);
	const collections = Object.keys(m.collections);
	const callables = [
		...collections.flatMap((collection) =>
			(['create', 'update', 'delete'] as const)
				.filter((verb) => m.collections[collection]?.[verb] !== undefined && may(collection, verb))
				.map((verb) => `${collection}.${verb}`)
		),
		...collections.flatMap((collection) => named(collection, 'actions')),
		...((authority.admin ? Object.keys(m.automations) : authority.automations).length > 0
			? ['start']
			: [])
	];
	const body = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
	const responses = {
		200: { description: 'answered' },
		202: { description: 'pendingApproval' },
		401: { description: 'unauthenticated' },
		422: { description: 'refused' }
	};
	return {
		openapi: '3.1.0',
		info: { title: 'Bolt workspace', version },
		components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
		security: [{ apiKey: [] }],
		paths: {
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
										m: { enum: ['read', 'get', 'aggregate', 'similar', 'history', 'query'] },
										a: {
											type: 'array',
											prefixItems: [
												{
													enum: [
														...collections.filter((collection) => may(collection, 'read')),
														...collections.flatMap((collection) => named(collection, 'queries'))
													]
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
						oneOf: callables.map((callable) => ({
							type: 'object',
							required: ['callable', 'input', 'issuedAt'],
							properties: {
								callable: { const: callable },
								input: { type: 'object' },
								issuedAt: { type: 'string', format: 'date-time' }
							}
						}))
					}),
					responses
				}
			}
		}
	};
}
