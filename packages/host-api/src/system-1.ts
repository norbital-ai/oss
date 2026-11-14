// System 1 adapters a host binds as its `sys_1` (`System1Port`): a decisions API over HTTP (the native wire or OpenAI's)
// and a chat model's structured output, with the checks both sides share: the inline-image budget and the answer's fit
// to the offered criteria. Provider refusals and HTTP errors fail as facility failures.
import { Effect, Predicate, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
	type AiEvent,
	type DecisionAnswer,
	type DecisionRequest,
	DecisionResult,
	type OpenAiChat
} from './ai.ts';
import { FacilityFailure, type Unavailable } from './errors.ts';
import { model_schema } from './json-schema.ts';
import { Port, provide_http, type HttpOptions } from './port.ts';

import type { Json } from '@norbital-ai/store';
type Question = DecisionRequest['questions'][string];
type Entry = Question['instructions'];
const isList = (v: Json): v is readonly Json[] => Array.isArray(v);
const isObj = (v: Json): v is { readonly [k: string]: Json } =>
	v !== null && typeof v === 'object' && !isList(v);
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const DecisionImage = Schema.Struct({
	type: Schema.Literal('image_url'),
	image_url: Schema.Struct({
		url: Schema.String.check(
			Schema.isPattern(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/)
		)
	})
});
/** Inline images only: stored references are resolved by their owner, never by a provider fetching an arbitrary URL. */
const imageData = (image: typeof DecisionImage.Type) =>
	image.image_url.url.slice(image.image_url.url.indexOf(',') + 1);
/** A request's inline images, at most 16 and 20 MiB: the state's text naming each `image-<n>`, and the images. */
export const decision_images = (state: DecisionRequest['state']) =>
	Effect.gen(function* () {
		const found: Json[] = [];
		const text = walkJson(state, (value) => {
			if (!isObj(value) || value['type'] !== 'image_url') return undefined;
			found.push(value);
			return `image-${found.length}`;
		});
		const images = yield* Schema.decodeUnknownEffect(Schema.Array(DecisionImage))(found).pipe(
			Effect.mapError((error) => FacilityFailure.invalid(error.message))
		);
		if (
			images.length > 16 ||
			images.reduce((n, image) => {
				const data = imageData(image);
				return (
					n +
					Math.floor((data.length * 3) / 4) -
					(data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
				);
			}, 0) >
				20 * 1024 * 1024
		)
			return yield* Effect.fail(
				new FacilityFailure({
					kind: 'too_large',
					message: 'System 1 images exceed the 16-image / 20 MiB budget'
				})
			);
		return { text, images };
	});
/** System 1 as an Effect: one bounded decision call, failing as a facility failure or `unavailable`; a host adapts it to its `System1Port`. */
export type System1 = {
	readonly ask: (
		request: DecisionRequest
	) => Effect.Effect<DecisionResult, FacilityFailure | Unavailable>;
	readonly maxChoices?: number | undefined;
};
/** System 1's wall: one decision call, at most 3 s. */
export const DECISION_CALL_MS = 3_000;
const walkJson = (v: Json, leaf: (x: Json) => Json | undefined): Json => {
	const r = leaf(v);
	if (r !== undefined) return r;
	if (isList(v)) return v.map((x) => walkJson(x, leaf));
	return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkJson(x, leaf)])) : v;
};

/** A provider's HTTP refusal as the facility failure it maps to (P37); `undefined` is an ordinary failure. Hosts share it. */
export function refusal_of(status: number, body: string): FacilityFailure | undefined {
	if (status < 400 || status >= 500) return undefined;
	const message = body.slice(0, 500) || `the provider refused the request (${status})`;
	if (
		status === 413 ||
		/context.{0,20}(length|window|limit)|too (long|large)|maximum.{0,20}(tokens|context)/i.test(
			body
		)
	)
		return new FacilityFailure({ kind: 'too_large', message, status });
	if (status === 429) return new FacilityFailure({ kind: 'rate_limited', message, status });
	if (status === 415 || /unsupported|not supported|does not support/i.test(body))
		return new FacilityFailure({ kind: 'unsupported', message, status });
	return new FacilityFailure({ kind: 'invalid', message, status });
}

const normalized = (keys: readonly string[], raw: unknown): { [k: string]: number } => {
	const entries = keys.map((key) => {
		const value = Predicate.isObject(raw) ? Number(raw[key]) : 0;
		return [key, Number.isFinite(value) && value > 0 ? value : 0] as const;
	});
	const sum = entries.reduce((total, [, value]) => total + value, 0);
	return Object.fromEntries(
		entries.map(([key, value]) => [key, sum === 0 ? 1 / entries.length : value / sum])
	);
};
const argmax = (p: { readonly [k: string]: number }): [string, number] =>
	Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a));
/** A provider's stated distribution as the port's answer: the most probable option or level, its probability the confidence. */
const Distribution = Schema.Union([
	Schema.Struct({ noul: Probability }),
	Schema.Struct({ probabilities: Schema.Record(Schema.String, Probability) })
]);
function responseOf(question: Question, raw: typeof Distribution.Type): DecisionAnswer {
	if (question.type === 'noul' && 'noul' in raw) return { type: 'noul', noul: raw.noul };
	if (!('probabilities' in raw))
		throw FacilityFailure.invalid('the structured answer does not match its question');
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
	throw FacilityFailure.invalid('the structured answer does not match its question');
}

const DeclaredAnswer = {
	noul: Schema.Struct({ noul: Probability }),
	choice: Schema.Struct({
		choice: Schema.String,
		confidence: Schema.Number,
		probabilities: Schema.Record(Schema.String, Schema.Number)
	}),
	score: Schema.Struct({
		score: Schema.Number,
		confidence: Schema.Number,
		probabilities: Schema.Record(Schema.String, Schema.Number),
		legend: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
	})
};
const decodeProviderAnswers = Effect.fn('Decisions.decodeProviderAnswers')(function* (
	request: DecisionRequest,
	raw: Readonly<Record<string, unknown>>,
	format: 'declared' | 'distribution',
	metadata: Omit<DecisionResult, 'answers'>
) {
	const answers: Record<string, DecisionAnswer> = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (format === 'distribution') {
			const value = yield* Schema.decodeUnknownEffect(Distribution)(raw[id]).pipe(
				Effect.mapError(Port.failure('sys_1'))
			);
			answers[id] = yield* Effect.try({
				try: () => responseOf(question, value),
				catch: Port.failure('sys_1')
			});
			continue;
		}
		const decoded = yield* Schema.decodeUnknownEffect(DeclaredAnswer[question.type])(raw[id]).pipe(
			Effect.mapError(Port.failure('sys_1'))
		);
		if ('noul' in decoded) answers[id] = { type: 'noul', noul: decoded.noul };
		else if ('choice' in decoded) answers[id] = { type: 'choice', ...decoded };
		else if (question.type === 'score') {
			const best = Object.entries(decoded.probabilities).sort((a, b) => b[1] - a[1])[0];
			const level = best === undefined ? -1 : /^\d+$/.test(best[0])
				? Number(best[0]) : question.criteria.indexOf(best[0]);
			answers[id] = {
				type: 'score',
				score: decoded.score,
				confidence: decoded.confidence,
				probabilities: decoded.probabilities,
				level,
				legend: Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry]))
			};
		}
	}
	return yield* Schema.decodeUnknownEffect(answer_criteria(request))({ ...metadata, answers }).pipe(
		Effect.mapError(Port.failure('sys_1'))
	);
});

/** `DecisionResult` that answers each question of `request` within its offered criteria. */
export const answer_criteria = (request: DecisionRequest) =>
	DecisionResult.check(
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

type DecisionsApiConfig = {
	/** Jev/OpenRouter by default; OpenAI native `/v1/decisions` uses its own wire format. */
	format?: 'jev' | 'openai';
	url: string;
	model: string;
	api_key: string;
	timeout_ms?: number | undefined;
};
const OpenAiDecisionResponse = Schema.Struct({
	model: Schema.String,
	answers: Schema.Array(
		Schema.Union([
			Schema.Struct({
				name: Schema.String,
				type: Schema.Literal('predicate'),
				probability: Probability
			}),
			Schema.Struct({
				name: Schema.String,
				type: Schema.Literal('choice'),
				choice: Schema.String,
				confidence: Probability,
				probabilities: Schema.Array(
					Schema.Struct({ value: Schema.String, probability: Probability })
				)
			}),
			Schema.Struct({
				name: Schema.String,
				type: Schema.Literal('score'),
				score: Schema.Finite,
				confidence: Probability,
				probabilities: Schema.Array(
					Schema.Struct({ value: Schema.Int, label: Schema.String, probability: Probability })
				)
			}),
			Schema.Struct({ name: Schema.String, type: Schema.Literal('refusal') })
		])
	),
	usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })
});
const entryText = (entry: Entry): string =>
	typeof entry === 'string' ? entry : JSON.stringify(entry ?? null);
/** Only the adapter knows OpenAI's predicate/choices/levels spelling. */
function openAiDecisionRequest(
	request: DecisionRequest,
	model: string,
	media: Effect.Success<ReturnType<typeof decision_images>>
): Json {
	return {
		model,
		input:
			media.images.length === 0
				? typeof request.state === 'string'
					? request.state
					: JSON.stringify(request.state)
				: [
						{
							role: 'user',
							content: [
								{ type: 'input_text', text: JSON.stringify(media.text) },
								...media.images.flatMap((image, n) => [
									{ type: 'input_text', text: `image-${n + 1}` },
									{ type: 'input_image', image_url: image.image_url.url }
								])
							]
						}
					],
		questions: Object.entries(request.questions).map(([name, question]) => {
			const instructions = entryText(question.instructions);
			switch (question.type) {
				case 'noul':
					return {
						name,
						type: 'predicate',
						instructions:
							question.criteria == null
								? instructions
								: JSON.stringify({
										instructions: question.instructions ?? null,
										criteria: question.criteria
									})
					};
				case 'choice':
					return {
						name,
						type: 'choice',
						instructions,
						choices: Object.entries(question.criteria).map(([value, description]) => ({
							value,
							description: entryText(description)
						}))
					};
				case 'score':
					return {
						name,
						type: 'score',
						instructions,
						levels: question.criteria.map((description, index) => ({
							label: String(index),
							description: entryText(description)
						}))
					};
			}
		})
	};
}
function openAiDecisionWire(response: typeof OpenAiDecisionResponse.Type) {
	return {
		provider: response.model,
		usage: response.usage,
		answers: Object.fromEntries(
			response.answers.map((answer) => {
				if (answer.type === 'refusal')
					throw new FacilityFailure({
						kind: 'invalid',
						message: `System 1 refused question '${answer.name}'`
					});
				if (answer.type === 'predicate') return [answer.name, { noul: answer.probability }];
				const probabilities = Object.fromEntries(
					answer.probabilities.map(({ value, probability }) => [String(value), probability])
				);
				return [
					answer.name,
					answer.type === 'choice'
						? { choice: answer.choice, confidence: answer.confidence, probabilities }
						: { score: answer.score, confidence: answer.confidence, probabilities }
				];
			})
		)
	};
}
/**
 * System 1 over an HTTP decisions API (the native wire or OpenAI's format), bearer-authenticated. Provider refusals and
 * HTTP errors fail as facility failures; the call is bounded by `timeout_ms` (default 3 s).
 */
export function decisions_system_1(config: DecisionsApiConfig, options: HttpOptions = {}): System1 {
	const Response = Schema.Struct({
		id: Schema.optionalKey(Schema.String),
		model: Schema.optionalKey(Schema.String),
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
				const media = yield* decision_images(request.state);
				if (
					config.format === 'openai' &&
					(Object.keys(request.questions).length > 400 ||
						Object.values(request.questions).some((question) =>
							question.type === 'choice'
								? Object.keys(question.criteria).length < 2
								: question.type === 'score' && question.criteria.length < 2
						))
				)
					return yield* Effect.fail(
						new FacilityFailure({
							kind: 'invalid',
							message:
								'OpenAI Decisions accepts at most 400 questions, at least two choices, and at least two score levels'
						})
					);
				const payload = yield* Effect.try({
					try: (): Json => {
						if (config.format === 'openai')
							return openAiDecisionRequest(request, config.model, media);
						const assets = Object.fromEntries(media.images.map((image, n) => [
							`bolt-image-${n + 1}-${globalThis.crypto.randomUUID()}`,
							{
								type: 'image',
								format: image.image_url.url.startsWith('data:image/png;') ? 'png' : 'jpeg',
								data_base64: imageData(image)
							}
						]));
						const names = Object.keys(assets);
						let imageIndex = 0;
						const state = walkJson(request.state, (value) => isObj(value) && value['type'] === 'image_url'
							? names[imageIndex++] : undefined);
						return { model: config.model, state, questions: request.questions,
							...(media.images.length === 0 ? {} : { assets }) };
					},
					catch: Port.failure('sys_1')
				});
				const body = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(config.url, {
						headers: {
							authorization: `Bearer ${config.api_key}`,
							'content-type': 'application/json',
							...(media.images.length === 0 ? {} : { 'TypeSafe-Danger-Zone-Images': 'true' })
						}
					}),
					payload
				).pipe(Effect.mapError(Port.failure('sys_1')));
				const response = yield* HttpClient.execute(body).pipe(
					Effect.mapError(Port.failure('sys_1'))
				);
				if (response.status >= 400) {
					const text = yield* response.text.pipe(Effect.mapError(Port.failure('sys_1')));
					const refusal = refusal_of(response.status, text);
					return yield* Effect.fail(
						refusal ??
							new FacilityFailure({
								kind: 'upstream',
								message: `decisions: ${response.status} ${text.slice(0, 200)}`
							})
					);
				}
				const wire = yield* (
					config.format === 'openai'
						? HttpClientResponse.schemaBodyJson(OpenAiDecisionResponse)(response).pipe(
								Effect.flatMap((native) =>
									Effect.try({
										try: () => openAiDecisionWire(native),
										catch: Port.failure('sys_1')
									})
								),
								Effect.flatMap(Schema.decodeUnknownEffect(Response))
							)
						: HttpClientResponse.schemaBodyJson(Response)(response)
				).pipe(Effect.mapError(Port.failure('sys_1')));
				return yield* decodeProviderAnswers(request, wire.answers, 'declared', {
					cost_usd: wire.usage?.cost ?? 0,
					provider: wire.provider ?? config.model,
					model: wire.model ?? config.model,
					...(wire.id === undefined ? {} : { call: wire.id }),
					tokens: { input: wire.usage?.input_tokens ?? 0, output: wire.usage?.output_tokens ?? 0 }
				});
			},
			(effect) =>
				effect.pipe(
					provide_http(options),
					Port.call('decisions', config.timeout_ms ?? DECISION_CALL_MS, 'decisions did not answer within its wall')
				)
		)
	};
}
/** System 1 over a chat model's structured output: each question becomes a probability object in one JSON-schema answer. */
export function structured_system_1(infer: OpenAiChat, model: string): System1 {
	return {
		ask: Effect.fn('Decisions.structuredAsk')(function* (request) {
			const media = yield* decision_images(request.state);
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
			const output = yield* Effect.try({
				try: () => model_schema(responseSchema, true),
				catch: Port.failure('sys_1')
			}).pipe(
				Effect.flatMap((schema) =>
					Schema.decodeUnknownEffect(Schema.Json)(schema).pipe(Effect.mapError(Port.failure('sys_1')))
				)
			);
			const events = yield* Stream.runCollect(
				infer({
					model,
					system:
						'Answer each question independently from the state alone. Return JSON probabilities for every option or level.',
					messages: [
						{
							role: 'user',
							content:
								media.images.length === 0
									? JSON.stringify(request)
									: [
											{ type: 'text', text: JSON.stringify({ ...request, state: media.text }) },
											...media.images.flatMap((image, n) => [
												{ type: 'text', text: `image-${n + 1}` },
												image
											])
										]
						}
					],
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
			return yield* decodeProviderAnswers(request, decoded, 'distribution', {
				cost_usd: response.usage.cost ?? 0,
				provider: model,
				tokens: { input: response.usage.input, output: response.usage.output }
			});
		})
	};
}
