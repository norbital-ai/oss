// Structured decisions: one schema at each boundary and one persisted event per call; the host meters at its facility.
import {
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Predicate,
	Result,
	Schema,
	Stream
} from 'effect';
import * as EffectArray from 'effect/Array';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import type { Json } from '../../decl/values.ts';
import type { DecisionQuestion, DecisionState } from '../../decl/runtime/facilities.ts';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import {
	type Authority,
	type Bindings,
	type FacilityError,
	type EmbedInput
} from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { type TenantDbShape } from '../db/tenant-db.ts';
import { Ai, Logs, type AiEvent } from '../ports.ts';
import { Decisions, type DecisionUse, type ReadsShape, type ShapeOf } from '../services.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { exposed, grantedArms, outputsOf } from '../access/authority.ts';
import { q } from '@norbital-ai/store';
import { clip } from '../agent/schema.ts';
import { provideHttp, type HttpOptions, type OpenAiChat } from '../agent/openai-chat.ts';
import { Port } from '../port.ts';
import { RunOutputRow, readsRunResult } from '../runs/index.ts';
import { outputFiles } from '../runs/output-files.ts';
import * as ir from '../../protocol/reads.ts';

export type { DecisionQuestion, DecisionState };
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Question = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('noul'),
		instructions: Schema.String,
		criteria: Schema.Struct({ true: Schema.String, false: Schema.String })
	}),
	Schema.Struct({
		type: Schema.Literal('choice'),
		instructions: Schema.String,
		criteria: Schema.Record(Schema.String, Schema.String).check(
			Schema.makeFilter((value) => Object.keys(value).length > 0)
		)
	}),
	Schema.Struct({
		type: Schema.Literal('score'),
		instructions: Schema.String,
		criteria: Schema.Array(Schema.String).check(Schema.isMinLength(1))
	})
]);
export const DecisionRequestSchema = Schema.Struct({
	state: Schema.Record(Schema.String, Schema.Json),
	questions: Schema.Record(Schema.String, Question).check(
		Schema.makeFilter((value) => Object.keys(value).length > 0)
	)
});
export type DecisionRequest = typeof DecisionRequestSchema.Type;
export const DecisionAnswerSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal('noul'), noul: Probability }),
	Schema.Struct({
		type: Schema.Literal('choice'),
		choice: Schema.String,
		confidence: Schema.Finite,
		probabilities: Schema.Record(Schema.String, Schema.Finite)
	}),
	Schema.Struct({
		type: Schema.Literal('score'),
		score: Schema.Finite,
		level: Schema.Int,
		confidence: Schema.Finite,
		probabilities: Schema.Record(Schema.String, Schema.Finite),
		legend: Schema.Record(Schema.String, Schema.String)
	})
]);
export type DecisionAnswer = typeof DecisionAnswerSchema.Type;
export const DecisionResultSchema = Schema.Struct({
	answers: Schema.Record(Schema.String, DecisionAnswerSchema),
	costUsd: Schema.Finite,
	provider: Schema.String,
	tokens: Schema.optionalKey(Schema.Struct({ input: Schema.Number, output: Schema.Number }))
});
export type DecisionResult = typeof DecisionResultSchema.Type;
export type DecisionFile = Extract<EmbedInput, { readonly $file: unknown }>;
export type System1Request = DecisionRequest;
/** Provider ABI contract stays Promise/AbortSignal at the host adapter only. */
export interface System1Port {
	ask(request: System1Request, signal: AbortSignal): Promise<DecisionResult>;
	readonly maxChoices?: number;
}
export type System1 = {
	readonly ask: (
		request: DecisionRequest
	) => Effect.Effect<DecisionResult, FacilityFailure | Unavailable>;
	readonly maxChoices?: number | undefined;
};
const DECISION_CALL_MS = 3_000;
const FILE_KEYS = new Set(['id', 'name', 'mime', 'size', 'bytes', 'sha256']);
/** A `FileRef` leaf as it crosses the guest boundary: `{ id, name, mime }` (an upload's `size`/`bytes`/`sha256` may ride along). */
const isFileRef = (v: unknown): v is { id: string; name: string; mime: string } =>
	Predicate.isObject(v) &&
	typeof v['id'] === 'string' &&
	typeof v['name'] === 'string' &&
	typeof v['mime'] === 'string' &&
	Object.keys(v).every((k) => FILE_KEYS.has(k));
const isDecisionFile = (v: unknown): v is DecisionFile =>
	Predicate.isObject(v) &&
	Predicate.isObject(v['$file']) &&
	v['$file']['bytes'] instanceof Uint8Array;
const walk = (v: unknown, leaf: (x: unknown) => unknown): unknown => {
	const r = leaf(v);
	if (r !== undefined) return r;
	if (EffectArray.isArray(v)) return v.map((x) => walk(x, leaf));
	return Predicate.isObject(v) && !(v instanceof Uint8Array)
		? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, leaf)]))
		: v;
};
/** Every `FileRef` id a value names. */
const fileIds = (value: unknown): string[] => {
	const out = new Set<string>();
	walk(value, (x) => (isFileRef(x) ? (out.add(x.id), x) : undefined));
	return [...out];
};
/** Hosts: the input with each `$file` replaced by `encode(file, n)`, the provider's format for it (n counts from 0). */
export const encodeFiles = (
	input: unknown,
	encode: (file: DecisionFile['$file'], n: number) => Json
): Json => {
	let n = 0;
	return Schema.decodeUnknownSync(Schema.Json)(
		walk(input, (x) => (isDecisionFile(x) ? encode(x.$file, n++) : undefined))
	);
};

/** A provider's HTTP refusal as the typed error it maps to (P37); `undefined` is an ordinary failure. Hosts share it. */
export function refusalOf(
	status: number,
	body: string
): Exclude<FacilityError, { kind: 'unavailable' }> | undefined {
	if (status < 400 || status >= 500) return undefined;
	const message = body.slice(0, 500) || `the provider refused the request (${status})`;
	if (
		status === 413 ||
		/context.{0,20}(length|window|limit)|too (long|large)|maximum.{0,20}(tokens|context)/i.test(
			body
		)
	)
		return { kind: 'tooLarge', message, status };
	if (status === 429) return { kind: 'rateLimited', message, status };
	if (status === 415 || /unsupported|not supported|does not support/i.test(body))
		return { kind: 'unsupported', message, status };
	return { kind: 'invalid', message, status };
}

const normalized = (keys: readonly string[], raw: unknown): { [k: string]: number } => {
	const p = keys.map((k) => {
		const v = Predicate.isObject(raw) ? Number(raw[k]) : 0;
		return Number.isFinite(v) && v > 0 ? v : 0;
	});
	const sum = p.reduce((a, b) => a + b, 0);
	return Object.fromEntries(keys.map((k, i) => [k, sum === 0 ? 1 / keys.length : p[i]! / sum]));
};
const argmax = (p: { readonly [k: string]: number }): [string, number] =>
	Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a));
/** A provider's stated distribution as the port's answer: the most probable option or level, its probability the confidence. */
const Distribution = Schema.Union([
	Schema.Struct({ noul: Probability }),
	Schema.Struct({ probabilities: Schema.Record(Schema.String, Probability) })
]);
function responseOf(question: DecisionQuestion, raw: typeof Distribution.Type): DecisionAnswer {
	if (question.type === 'noul' && 'noul' in raw) return { type: 'noul', noul: raw.noul };
	if (!('probabilities' in raw))
		throw BoltError.make('internal', 'decode', 'the structured answer does not match its question');
	if (question.type === 'choice') {
		const probabilities = normalized(Object.keys(question.criteria), raw.probabilities),
			[choice, confidence] = argmax(probabilities);
		return { type: 'choice', choice, confidence, probabilities };
	}
	if (question.type === 'score') {
		const probabilities = normalized(
				question.criteria.map((_, index) => String(index)),
				raw.probabilities
			),
			[level, confidence] = argmax(probabilities);
		return {
			type: 'score',
			score: Object.entries(probabilities).reduce(
				(score, [index, probability]) => score + Number(index) * probability,
				0
			),
			level: Number(level),
			confidence,
			probabilities,
			legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label]))
		};
	}
	throw BoltError.make('internal', 'decode', 'the structured answer does not match its question');
}

const answerCriteria = (request: DecisionRequest) =>
	DecisionResultSchema.check(
		Schema.makeFilter(
			(result) =>
				Object.entries(request.questions).every(([id, question]) => {
					const answer = result.answers[id];
					if (answer === undefined || answer.type !== question.type) return false;
					if (question.type === 'choice' && answer.type === 'choice')
						return Object.hasOwn(question.criteria, answer.choice);
					if (question.type === 'score' && answer.type === 'score')
						return answer.level >= 0 && answer.level < question.criteria.length;
					return true;
				}),
			{ message: 'sys_1 answered outside the offered criteria' }
		)
	);
export const ask = Effect.fn('Decisions.ask')(function* (
	ai: ShapeOf<typeof Ai>,
	request: DecisionRequest,
	ms: number = DECISION_CALL_MS
) {
	if (fileIds(request.state).length > 0)
		return yield* Effect.fail(
			new FacilityFailure({
				kind: 'invalid',
				message:
					'a sys_1 state is text only: describe a file (name, mime, size, caption), never pass it'
			})
		);
	const result = yield* ai.ask(request).pipe(
		Effect.timeoutOrElse({
			duration: Math.min(ms, DECISION_CALL_MS),
			orElse: () =>
				Effect.fail(
					new FacilityFailure({
						kind: 'timeout',
						message: 'sys_1 did not answer within its wall'
					})
				)
		})
	);
	return yield* Schema.decodeUnknownEffect(answerCriteria(request))(result).pipe(
		Effect.mapError((error) => new FacilityFailure({ kind: 'invalid', message: error.message }))
	);
});
export const failed = (result: DecisionResult | FacilityError): result is FacilityError =>
	'kind' in result;
export const choiceOf = (result: DecisionResult, id: string): string | undefined => {
	const answer = result.answers[id];
	return answer?.type === 'choice' ? answer.choice : undefined;
};
export const noulOf = (result: DecisionResult, id: string): number => {
	const answer = result.answers[id];
	return answer?.type === 'noul' ? answer.noul : 0;
};
const clipState = (value: Json): Json =>
	typeof value === 'string'
		? clip(value)
		: Array.isArray(value)
			? value.map(clipState)
			: value !== null && typeof value === 'object'
				? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipState(item)]))
				: value;
export const decisionEvent = (
	use: DecisionUse,
	request: DecisionRequest,
	result: DecisionResult | FacilityError
): { readonly [key: string]: Json } => ({
	use,
	system: 1,
	state: clipState(request.state),
	questions: Object.keys(request.questions),
	...(failed(result)
		? {
				error: result.kind,
				...(result.kind === 'unavailable' || result.status === undefined
					? {}
					: { status: result.status })
			}
		: {
				answers: result.answers,
				costUsd: result.costUsd,
				provider: result.provider,
				...(result.tokens === undefined ? {} : { tokens: result.tokens })
			})
});
export const DecisionTrace = Context.Reference<
	{ readonly invocation: string; readonly run: string; readonly automation: string } | undefined
>('bolt/DecisionTrace', { defaultValue: () => undefined });
export const DecisionsLive = Layer.effect(
	Decisions,
	Effect.gen(function* () {
		const ai = yield* Ai,
			crypto = yield* Crypto.Crypto,
			logs = yield* Logs;
		return Decisions.of({
			decide: Effect.fn('Decisions.decide')(function* (use, request) {
				const trace = yield* DecisionTrace;
				const result = yield* Effect.result(ask(ai, request));
				const event = Result.isSuccess(result) ? result.success : wireFailure(result.failure);
				const now = new Date(yield* Clock.currentTimeMillis).toISOString();
				const call = yield* crypto
					.randomUUIDv4()
					.pipe(
						Effect.mapError(
							(error) => new FacilityFailure({ kind: 'upstream', message: error.message })
						)
					);
				yield* logs.write({
					at: now,
					severity: Result.isSuccess(result) ? 'info' : 'warn',
					event: 'decision.made',
					invocation: trace?.invocation ?? call,
					run: trace?.run ?? null,
					conversation: null,
					turn: null,
					attributes: {
						...decisionEvent(use, request, event),
						...(trace === undefined ? {} : { automation: trace.automation, run: trace.run })
					}
				});
				if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
				return result.success;
			})
		});
	})
);

export type DecisionsApiConfig = {
	url: string;
	model: string;
	apiKey: string;
	timeoutMillis?: number | undefined;
};
export function decisionsSystem1(config: DecisionsApiConfig, options: HttpOptions = {}): System1 {
	const Response = Schema.Struct({
		answers: Schema.Record(Schema.String, Schema.Json),
		usage: Schema.optionalKey(
			Schema.Struct({
				cost: Schema.optionalKey(Schema.Number),
				input_tokens: Schema.optionalKey(Schema.Number),
				output_tokens: Schema.optionalKey(Schema.Number)
			})
		),
		provider: Schema.optionalKey(Schema.String)
	});
	return {
		maxChoices: 255,
		ask: Effect.fn('Decisions.httpAsk')(
			function* (request) {
				const body = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(config.url, {
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							'content-type': 'application/json'
						}
					}),
					{ model: config.model, state: request.state, questions: request.questions }
				).pipe(Effect.mapError(Port.failure('sys_1')));
				const response = yield* HttpClient.execute(body).pipe(
					Effect.mapError(Port.failure('sys_1'))
				);
				if (response.status >= 400) {
					const text = yield* response.text.pipe(Effect.mapError(Port.failure('sys_1')));
					const refusal = refusalOf(response.status, text);
					return yield* Effect.fail(
						refusal === undefined
							? new FacilityFailure({
									kind: 'upstream',
									message: `decisions: ${response.status} ${text.slice(0, 200)}`
								})
							: new FacilityFailure({
									kind: refusal.kind,
									message: refusal.message,
									status: response.status
								})
					);
				}
				const wire = yield* HttpClientResponse.schemaBodyJson(Response)(response).pipe(
					Effect.mapError(Port.failure('sys_1'))
				);
				const answers: Record<string, DecisionAnswer> = {};
				for (const [id, question] of Object.entries(request.questions)) {
					const raw = wire.answers[id];
					const decoded = yield* Schema.decodeUnknownEffect(
						question.type === 'noul'
							? Schema.Struct({ noul: Probability })
							: question.type === 'choice'
								? Schema.Struct({
										choice: Schema.String,
										confidence: Schema.Number,
										probabilities: Schema.Record(Schema.String, Schema.Number)
									})
								: Schema.Struct({
										score: Schema.Number,
										confidence: Schema.Number,
										probabilities: Schema.Record(Schema.String, Schema.Number),
										legend: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
									})
					)(raw).pipe(Effect.mapError(Port.failure('sys_1')));
					if ('noul' in decoded) answers[id] = { type: 'noul', noul: decoded.noul };
					else if ('choice' in decoded) answers[id] = { type: 'choice', ...decoded };
					else if (question.type === 'score') {
						const best = Object.entries(decoded.probabilities).sort((a, b) => b[1] - a[1])[0];
						const level =
							best === undefined
								? -1
								: /^\d+$/.test(best[0])
									? Number(best[0])
									: question.criteria.indexOf(best[0]);
						answers[id] = {
							type: 'score',
							score: decoded.score,
							confidence: decoded.confidence,
							probabilities: decoded.probabilities,
							level,
							legend: decoded.legend ?? {}
						};
					}
				}
				return yield* Schema.decodeUnknownEffect(answerCriteria(request))({
					answers,
					costUsd: wire.usage?.cost ?? 0,
					provider: wire.provider ?? config.model,
					tokens: { input: wire.usage?.input_tokens ?? 0, output: wire.usage?.output_tokens ?? 0 }
				}).pipe(Effect.mapError(Port.failure('sys_1')));
			},
			(effect) =>
				effect.pipe(
					provideHttp(options),
					Effect.timeoutOrElse({
						duration: config.timeoutMillis ?? DECISION_CALL_MS,
						orElse: () =>
							Effect.fail(
								new FacilityFailure({
									kind: 'timeout',
									message: 'decisions did not answer within its wall'
								})
							)
					})
				)
		)
	};
}
export function structuredSystem1(infer: OpenAiChat, model: string): System1 {
	return {
		ask: Effect.fn('Decisions.structuredAsk')(function* (request) {
			const entries = Object.entries(request.questions);
			const fields = Object.fromEntries(
				entries.map(([id, question]) => [
					id,
					question.type === 'noul'
						? Schema.Struct({ noul: Probability })
						: Schema.Struct({
								probabilities: Schema.Struct(
									Object.fromEntries(
										(question.type === 'choice'
											? Object.keys(question.criteria)
											: question.criteria.map((_, index) => String(index))
										).map((key) => [key, Probability])
									)
								)
							})
				])
			);
			const responseSchema = Schema.Struct(fields);
			const document = Schema.toJsonSchemaDocument(responseSchema, { onExcessProperty: 'error' });
			const output = yield* Schema.decodeUnknownEffect(Schema.Json)({
				...document.schema,
				$defs: document.definitions
			}).pipe(Effect.mapError(Port.failure('sys_1')));
			const events = yield* Stream.runCollect(
				infer({
					model,
					system:
						'Answer each question independently from the state alone. Return JSON probabilities for every option or level.',
					messages: [{ role: 'user', content: JSON.stringify(request) }],
					output
				})
			);
			const response = events.findLast(
				(event): event is Extract<AiEvent, { _tag: 'Response' }> => event._tag === 'Response'
			)?.response;
			if (response === undefined)
				return yield* Effect.fail(
					new FacilityFailure({
						kind: 'upstream',
						message: 'the model stream ended without a response'
					})
				);
			const decoded = yield* Schema.decodeUnknownEffect(responseSchema)(response.content).pipe(
				Effect.mapError(Port.failure('sys_1'))
			);
			const answers: Record<string, DecisionAnswer> = {};
			for (const [id, question] of entries) {
				const value = yield* Schema.decodeUnknownEffect(Distribution)(decoded[id]).pipe(
					Effect.mapError(Port.failure('sys_1'))
				);
				answers[id] = yield* Effect.try({
					try: () => responseOf(question, value),
					catch: Port.failure('sys_1')
				});
			}
			return yield* Schema.decodeUnknownEffect(answerCriteria(request))({
				answers,
				costUsd: response.usage.cost ?? 0,
				provider: model,
				tokens: { input: response.usage.input, output: response.usage.output }
			}).pipe(Effect.mapError(Port.failure('sys_1')));
		})
	};
}

const StoredFile = Schema.Struct({
	id: Schema.String,
	key: Schema.String,
	sha256: Schema.String,
	name: Schema.String,
	mime: Schema.String,
	field: Schema.String
});
type FileRow = Omit<typeof StoredFile.Type, 'id'>;
/** The `sys_file` rows a value names, by id (a missing one is absent). */
export const storedFiles = Effect.fn('Decisions.storedFiles')(function* (
	db: TenantDbShape,
	value: unknown
) {
	const ids = fileIds(value);
	if (ids.length === 0) return new Map<string, FileRow>();
	const rows = yield* db.rows(StoredFile, {
		text: `SELECT id, key, sha256, name, mime, coalesce(field, '') AS field FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
		params: [JSON.stringify(ids)]
	});
	return new Map(rows.map(({ id, ...file }) => [id, file]));
});
/**
 * Whether `authority` may read a stored file, as `GET /__bolt/files/<id>` checks: an administrator, or a row holding it in
 * its model's file field that an output the caller holds reads.
 * A conversation's file (`sys_conversation.inputs` / `outputs`) is its uploader's, and then the conversation's: its owner, a member who
 * posted in it (in the app or as a linked envoy sender), and staff for an instance's conversation. Filed into a record (an
 * envoy's photo), it is also that record's: whoever reads it there, as for any file field.
 */
export const readableFile = Effect.fn('Decisions.readableFile')(function* (
	o: {
		manifest: EngineManifest;
		db: TenantDbShape;
		read: ReadsShape['run'];
		authority: Authority;
		bindings: Bindings;
	},
	id: string,
	owner: string
) {
	if (o.authority.actor.kind === 'member') {
		const notified = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_notification WHERE member = $1 AND attachments @> $2::jsonb LIMIT 1`,
			params: [o.authority.actor.id, JSON.stringify([{ id }])]
		});
		if (Option.isSome(notified)) return true;
	}
	/** A row of `model` holding the file in `field` that an output the caller holds reads. ponytail: ≤ 20 holders are tried. */
	const held = Effect.fn('Decisions.body')(function* (model: string, field: string) {
		if (o.authority.models[model] === undefined) return false;
		const holders = yield* o.db.rows(Schema.Struct({ id: Schema.String }), {
			text: `SELECT id::text AS id FROM ${q(model)} WHERE ${q(field)} @> $1::jsonb OR ${q(field)} @> $2::jsonb LIMIT 20`,
			params: [JSON.stringify({ id }), JSON.stringify([{ id }])]
		});
		const cat = catalogOf(o.manifest);
		const outputs = outputsOf(o.manifest, model).filter(
			(output) =>
				(o.authority.admin || grantedArms(o.authority, model, output) !== undefined) &&
				exposed(o.manifest, model, model, model, output).includes(field)
		);
		for (const output of outputs)
			for (const h of holders) {
				const read = ir.get(cat, model, h.id, { select: { [field]: true } });
				const [got] = yield* o.read(
					[read.kind === 'get' ? { ...read, output } : read],
					{ as: 'caller', authority: o.authority },
					o.bindings
				);
				if (JSON.stringify((Predicate.isObject(got) ? got[field] : null) ?? null).includes(id))
					return true;
			}
		return false;
	});
	if (owner === 'sys_conversation.inputs' || owner === 'sys_conversation.outputs') {
		const a = o.authority.actor;
		// ponytail: every file field is scanned for a holder; a file-field index if this read gets hot
		const filed = Effect.fn('Decisions.body')(function* () {
			for (const [c, spec] of Object.entries(o.manifest.models))
				for (const [f, def] of Object.entries(spec.fields))
					if (def.kind === 'file' && (yield* held(c, f))) return true;
			return false;
		});
		if (a.kind !== 'member') return yield* filed();
		const r = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_file WHERE id = $1 AND field = $7 AND created_by = $2
			UNION ALL SELECT true AS found FROM sys_conversation c WHERE (c.inputs @> $3::jsonb OR c.outputs @> $3::jsonb)
				AND (c.owner = $2 OR ($6 AND c.integration IS NULL) OR ($4 AND c.integration IS NOT NULL AND c.envoy IN (SELECT jsonb_array_elements_text($5::jsonb))) OR EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id
					AND ($2 IN (p."as"->>'member', p."as"->'envoy'->>'member'))))
			LIMIT 1`,
			params: [
				id,
				a.id,
				JSON.stringify([{ id }]),
				!a.external,
				// an instance's thread files: participants (below) and staff on a `public` envoy only (own, participant, public)
				JSON.stringify(
					Object.entries(o.manifest.envoys)
						.filter(([, e]) => e.audience === 'public')
						.map(([name]) => name)
				),
				// admins read in-app files; an envoy thread's only through the rule above (owner 2026-09-26)
				o.authority.admin,
				owner
			]
		});
		return Option.isSome(r) || (yield* filed());
	}
	if (o.authority.admin) return true;
	const automation = o.manifest.automations[owner];
	if (automation !== undefined) {
		let after: string | null = null;
		for (;;) {
			const row: Option.Option<typeof RunOutputRow.Type> = yield* o.db.one(RunOutputRow, {
				text: `SELECT id, automation, output, starter FROM sys_run WHERE automation = $1 AND ($3::text IS NULL OR id > $3) AND jsonb_path_exists(output, '$.**.id ? (@ == $id)', jsonb_build_object('id', $2::text)) ORDER BY id LIMIT 1`,
				params: [owner, id, after]
			});
			if (Option.isNone(row)) return false;
			if (
				readsRunResult(o.authority, row.value) &&
				outputFiles(
					automation.output,
					row.value.output,
					o.manifest.customFields,
					o.manifest.models
				).some((file) => file.id === id)
			)
				return true;
			after = row.value.id;
		}
	}
	const [model, field] = owner.split('.');
	// An import upload or export file belongs to the member who ran its file sync or conversion.
	if (field === '$import' || field === '$export') {
		if (o.authority.actor.kind !== 'member') return false;
		const r = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3 LIMIT 1`,
			params: [id, owner, o.authority.actor.id]
		});
		return Option.isSome(r);
	}
	if (
		model === undefined ||
		field === undefined ||
		o.manifest.models[model]?.fields[field]?.kind !== 'file'
	)
		return false;
	return yield* held(model, field);
});

const wireFailure = (error: FacilityFailure | Unavailable): FacilityError =>
	error._tag === 'Unavailable'
		? { kind: 'unavailable', facility: error.facility, reason: error.reason }
		: {
				kind: error.kind,
				message: error.message,
				...(error.status === undefined ? {} : { status: error.status })
			};
