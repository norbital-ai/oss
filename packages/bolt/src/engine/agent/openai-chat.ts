// Hosts: `sys_2.infer` over any OpenAI-compatible `/chat/completions` endpoint (bolt-server's `openai` provider, another host's
// OpenRouter). One call is one streamed completion: text deltas reach `onDelta` as they arrive, so the engine's 20 s idle wall
// (`modelCall`) cuts a long generation into a continued step instead of a `timeout` (rule 63); tool calls assemble from
// their pieces and usage comes from the last chunk. A refusal rejects with the HTTP `status` (the engine spots context
// overflow by it). An endpoint that ignores `stream` and answers `application/json` is read whole.
import { Clock, Effect, Option, Predicate, Queue, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { FacilityFailure } from '../../decl/errors.ts';
import { Port, type PortFailure } from '../port.ts';
import type { AiEvent } from '../ports.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type AiRequest, type AiResponse } from '../contracts.ts';
import { filePart } from './ingest.ts';
import { SaidContent, StepContent, textOf } from './schema.ts';

export type OpenAiChatConfig = {
	/** The API base, e.g. `https://openrouter.ai/api/v1`. */
	endpoint: string;
	credential?: string | undefined;
	/** Model class → provider model id; any other `r.model` (a catalog id the engine already checked) goes as is. */
	models: { readonly [modelClass: string]: string };
	/** Extra request fields the provider takes (OpenRouter's `usage: { include: true }`). */
	body?: { readonly [k: string]: Json };
	/** `response_format.json_schema.strict` for structured output. */
	strict?: boolean;
	/** The provider's charge for one call (`usage.cost`, USD) under its generation id, awaited before `infer` resolves. */
	meter?: (cost_usd: number, generationId: string) => Promise<void> | void;
};

type Wire = { [k: string]: unknown };
const inFlightBudget = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			error: Schema.Struct({
				metadata: Schema.Struct({
					reason: Schema.Literal('in_flight_budget_exhausted'),
					headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
				})
			})
		})
	)
);

/** The engine's messages decoded as its transcript rows hold them, by role. */
const stepOf = Schema.decodeUnknownOption(StepContent),
	saidOf = Schema.decodeUnknownOption(SaidContent);
/**
 * Engine messages (`{ text, toolCalls }` assistant rows, `{ id, name, result }` tool rows) as chat messages. A file a call
 * opened follows that call's results as a user message, on the one request after it: at the end, where no later prefix
 * holds it. One whose call is no longer in the history rides the last user message.
 */
function messagesOf(r: AiRequest): Wire[] {
	const out: Wire[] = r.system === undefined ? [] : [{ role: 'system', content: r.system }];
	// every step keeps its reasoning on every later call: a message never changes once sent, so the provider's cached
	// prefix holds. Dropping it at a new turn re-billed the whole conversation at each message a person sent.
	const files = (r.files ?? []).map((f, n) => ({
		call: f.call,
		part: filePart(f, `attachment-${n + 1}`)
	}));
	const calls = new Set(
		r.messages.flatMap((m) =>
			m.role === 'tool' ? Option.toArray(Option.map(stepOf(m.content), (step) => step.id)) : []
		)
	);
	/** Assistant tool-call ids still awaiting their result, in the order the provider sent them. */
	const pending: string[] = [];
	// the files the run of tool results just written opened, as one user message after it
	let ran: string[] = [];
	const opened = () => {
		const parts = files
			.filter((f) => f.call !== undefined && ran.includes(f.call))
			.map((f) => f.part);
		if (parts.length > 0) out.push({ role: 'user', content: parts });
		ran = [];
	};
	for (const m of r.messages) {
		if (m.role !== 'tool') opened();
		if (m.role === 'tool') {
			const step = Option.getOrUndefined(stepOf(m.content)),
				claimed = step?.id === undefined || step.id === '' ? undefined : step.id,
				held = claimed === undefined ? -1 : pending.indexOf(claimed);
			if (held >= 0) pending.splice(held, 1);
			const id = claimed ?? pending.shift();
			if (claimed !== undefined) ran.push(claimed);
			// a result the transcript can no longer decode still answers the call before it; an orphan is user text
			if (id === undefined) out.push({ role: 'user', content: textOf(m.content) });
			else
				out.push({
					role: 'tool',
					tool_call_id: id,
					content: JSON.stringify(step?.result ?? null)
				});
		} else if (m.role === 'assistant') {
			const said = Option.getOrUndefined(saidOf(m.content)),
				reply = typeof said === 'object' ? said : null,
				calls = reply?.toolCalls ?? [];
			pending.push(...calls.map((t) => t.id).filter((id) => id !== ''));
			// L-BOLT-412: the stored reasoning goes back with its reply (OpenRouter's `reasoning` on an assistant message)
			out.push({
				role: 'assistant',
				content: textOf(m.content),
				...(reply?.reasoning === undefined || reply.reasoning === ''
					? {}
					: { reasoning: reply.reasoning }),
				...(calls.length === 0
					? {}
					: {
							tool_calls: calls.map((t) => ({
								id: t.id,
								type: 'function',
								function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) }
							}))
						})
			});
		} else out.push({ role: 'user', content: textOf(m.content) });
	}
	opened();
	const loose = files.filter((f) => f.call === undefined || !calls.has(f.call)).map((f) => f.part);
	if (loose.length > 0) {
		const last = out.findLast((m) => m['role'] === 'user' && typeof m['content'] === 'string');
		if (last === undefined) out.push({ role: 'user', content: loose });
		else last['content'] = [{ type: 'text', text: last['content'] }, ...loose];
	}
	return out;
}
type Call = { id: string; name: string; args: string };
const WireCall = Schema.Struct({
	index: Schema.optional(Schema.Number),
	id: Schema.optional(Schema.String),
	function: Schema.optional(
		Schema.Struct({
			name: Schema.optional(Schema.String),
			arguments: Schema.optional(Schema.String)
		})
	)
});
const Part = Schema.Struct({
	content: Schema.optional(Schema.NullOr(Schema.String)),
	reasoning: Schema.optional(Schema.NullOr(Schema.String)),
	tool_calls: Schema.optional(Schema.Array(WireCall))
});
const Chunk = Schema.Struct({
	id: Schema.optional(Schema.String),
	/** OpenRouter's name for who answered: a conversation's cache lives there. */
	provider: Schema.optional(Schema.String),
	error: Schema.optional(
		Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.Number) })
	),
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				prompt_tokens: Schema.optional(Schema.Number),
				completion_tokens: Schema.optional(Schema.Number),
				cost: Schema.optional(Schema.Number),
				prompt_tokens_details: Schema.optional(
					Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }))
				),
				completion_tokens_details: Schema.optional(
					Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }))
				)
			})
		)
	),
	choices: Schema.optional(
		Schema.Array(
			Schema.Struct({
				delta: Schema.optional(Part),
				message: Schema.optional(Part),
				finish_reason: Schema.optional(Schema.NullOr(Schema.String))
			})
		)
	)
});
const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk));
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The caller's HTTP client, else fetch (the caller's `fetch` when given). */
export type HttpOptions = { http_client?: HttpClient.HttpClient; fetch?: typeof fetch };
export const provide_http =
	(options: HttpOptions) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const provided =
			options.http_client === undefined
				? effect.pipe(Effect.provide(FetchHttpClient.layer))
				: effect.pipe(Effect.provideService(HttpClient.HttpClient, options.http_client));
		return options.http_client === undefined && options.fetch !== undefined
			? provided.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))
			: provided;
	};
/** One call is a cancellable stream; its final event carries the assembled response. */
export type OpenAiChat = (request: AiRequest) => Stream.Stream<AiEvent, PortFailure>;
export function open_ai_chat(config: OpenAiChatConfig, options: HttpOptions = {}): OpenAiChat {
	return (request) =>
		Stream.callback<AiEvent, PortFailure>((queue) =>
			Effect.gen(function* () {
				let text = '',
					reasoning = '',
					id = '';
				// the provider's own last choice: `length` means the reply was cut, not that the model stopped
				let finishReason: string | null = null;
				let usage: NonNullable<Schema.Schema.Type<typeof Chunk>['usage']> = {};
				let provider = '';
				const calls: Call[] = [];
				const model = config.models[request.model] ?? request.model;
				const body = yield* Effect.try({
					try: () => ({
						...config.body,
						model,
						messages: messagesOf(request),
						stream: true,
						stream_options: { include_usage: true },
						...(request.effort === undefined ? {} : { reasoning_effort: request.effort }),
						...(request.tools === undefined || request.tools.length === 0
							? {}
							: {
									tools: request.tools.map((t) => ({
										type: 'function',
										function: { name: t.name, description: t.description, parameters: t.input }
									}))
								}),
						...(request.output === undefined
							? {}
							: {
									response_format: {
										type: 'json_schema',
										json_schema: {
											name: 'output',
											...(config.strict === true ? { strict: true } : {}),
											schema: request.output
										}
									}
								})
					}),
					catch: Port.failure('ai')
				});
				const req = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${config.endpoint.replace(/\/$/, '')}/chat/completions`, {
						headers: {
							'content-type': 'application/json',
							...(config.credential === undefined
								? {}
								: { authorization: `Bearer ${config.credential}` })
						}
					}),
					body
				).pipe(Effect.mapError(Port.failure('ai')));
				const res = yield* HttpClient.execute(req).pipe(
					Effect.mapError(Port.failure('ai')),
					// a provider answers its headers with its first token: as late as an uncached long prompt takes. Nothing has
					// streamed yet, so a stall is an upstream failure the caller may resend
					Port.call('ai.headers', 60_000),
					Effect.mapError((error) =>
						error instanceof FacilityFailure && error.kind === 'timeout'
							? new FacilityFailure({ kind: 'upstream', message: error.message })
							: error
					)
				);
				if (res.status < 200 || res.status >= 300) {
					const detail = yield* res.text.pipe(
						Effect.mapError(Port.failure('ai')),
						Port.call('ai.body', LIMITS.callMs.ai)
					);
					const too_large =
						res.status === 413 ||
						(res.status === 400 && /maximum context|context[_ ](?:length|window)/i.test(detail));
					const budget = res.status === 402 ? inFlightBudget(detail) : Option.none();
					const limited = res.status === 429 || Option.isSome(budget);
					const hint =
						res.headers['retry-after'] ??
						(Option.isSome(budget)
							? Object.entries(budget.value.error.metadata.headers ?? {}).find(
									([name]) => name.toLowerCase() === 'retry-after'
								)?.[1]
							: undefined);
					const delay =
						hint === undefined
							? Number.NaN
							: /^\d+(?:\.\d+)?$/.test(hint.trim())
								? Number(hint) * 1000
								: Date.parse(hint) - (yield* Clock.currentTimeMillis);
					return yield* Effect.fail(
						new FacilityFailure({
							kind: too_large ? 'too_large' : limited ? 'rate_limited' : 'upstream',
							status: res.status,
							...(Number.isFinite(delay) && delay >= 0 ? { retry_after_ms: delay } : {}),
							message: `the model provider refused the request (HTTP ${res.status}): ${detail.slice(0, 500)}`
						})
					);
				}
				const accept = Effect.fn('OpenAiChat.chunk')(function* (
					chunk: Schema.Schema.Type<typeof Chunk>,
					whole: boolean
				) {
					if (chunk.error !== undefined)
						return yield* Effect.fail(
							new FacilityFailure({
								kind: 'upstream',
								message: chunk.error.message ?? 'the model stream failed',
								...(chunk.error.code === undefined ? {} : { status: chunk.error.code })
							})
						);
					if (chunk.provider !== undefined) provider = chunk.provider;
					if (chunk.id !== undefined) {
						if (id !== '' && id !== chunk.id)
							return yield* Effect.fail(
								new FacilityFailure({
									kind: 'upstream',
									message: `the model stream switched call id from ${id} to ${chunk.id}`
								})
							);
						id = chunk.id;
					}
					if (chunk.usage != null) usage = chunk.usage;
					finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
					const part = whole ? chunk.choices?.[0]?.message : chunk.choices?.[0]?.delta;
					if (part?.content != null && part.content !== '') {
						text += part.content;
						yield* Queue.offer(queue, { _tag: 'Delta', text: part.content });
					}
					if (part?.reasoning != null && part.reasoning !== '') {
						reasoning += part.reasoning;
						yield* Queue.offer(queue, { _tag: 'Progress', reasoning: part.reasoning });
					}
					if ((part?.tool_calls?.length ?? 0) > 0)
						yield* Queue.offer(queue, { _tag: 'Progress', reasoning: undefined });
					if (!(part?.content || part?.reasoning || (part?.tool_calls?.length ?? 0) > 0))
						yield* Queue.offer(queue, { _tag: 'Progress', reasoning: undefined });
					for (const t of part?.tool_calls ?? []) {
						const index = t.index ?? calls.length;
						const call = (calls[index] ??= { id: '', name: '', args: '' });
						if (t.id !== undefined) call.id = t.id;
						call.name += t.function?.name ?? '';
						call.args += t.function?.arguments ?? '';
					}
				});
				if ((res.headers['content-type'] ?? '').includes('application/json')) {
					yield* accept(
						yield* decodeChunk(yield* res.text.pipe(Port.call('ai.body', LIMITS.callMs.ai))).pipe(
							Effect.mapError(Port.failure('ai'))
						),
						true
					);
				} else {
					yield* Stream.transformPull(res.stream, (pull) =>
						Effect.succeed(pull.pipe(Port.call('ai.stream', LIMITS.callMs.ai)))
					).pipe(
						Stream.decodeText(),
						Stream.splitLines,
						Stream.map((s) => s.trim()),
						Stream.filter(
							(s) => s.startsWith(':') || (s.startsWith('data:') && s.slice(5).trim() !== '[DONE]')
						),
						// A keep-alive comment is the provider still generating: OpenRouter holds a tool call's arguments
						// back until they are whole and sends only these meanwhile.
						Stream.runForEach((s) =>
							s.startsWith(':')
								? Queue.offer(queue, { _tag: 'Progress', reasoning: undefined })
								: decodeChunk(s.slice(5).trim()).pipe(
										Effect.mapError(Port.failure('ai')),
										Effect.flatMap((chunk) => accept(chunk, false))
									)
						),
						Effect.mapError(Port.failure('ai'))
					);
				}
				if (usage.cost !== undefined && id !== '' && config.meter !== undefined)
					yield* Port.attempt('ai.meter', () =>
						Promise.resolve(config.meter?.(usage.cost ?? 0, id))
					).pipe(Port.call('ai.meter', LIMITS.callMs.ai));
				const toolCalls = calls.map((c) =>
					Option.match(parseJson(c.args === '' ? '{}' : c.args), {
						onSome: (input) => ({
							id: c.id === '' ? `call_${crypto.randomUUID()}` : c.id,
							name: c.name,
							input
						}),
						onNone: () => ({
							id: c.id === '' ? `call_${crypto.randomUUID()}` : c.id,
							name: c.name,
							input: {},
							invalid: 'the tool arguments are not valid JSON'
						})
					})
				);
				const content =
					request.output === undefined || toolCalls.length > 0
						? text
						: Option.getOrElse(parseJson(text), () => text);
				const response: AiResponse = {
					content,
					toolCalls,
					finish: finishReason === 'length' ? 'cut' : toolCalls.length > 0 ? 'tool' : 'stop',
					...(reasoning === '' ? {} : { reasoning }),
					usage: {
						input: usage.prompt_tokens ?? 0,
						output: usage.completion_tokens ?? 0,
						...(usage.cost === undefined ? {} : { cost: usage.cost }),
						...(id === '' ? {} : { call: id }),
						...(provider === '' ? {} : { provider }),
						...(usage.prompt_tokens_details?.cached_tokens == null
							? {}
							: { cached: usage.prompt_tokens_details.cached_tokens }),
						...(usage.completion_tokens_details?.reasoning_tokens == null
							? {}
							: { reasoning: usage.completion_tokens_details.reasoning_tokens })
					}
				};
				yield* Queue.offer(queue, { _tag: 'Response', response });
				yield* Queue.end(queue);
			}).pipe(
				provide_http(options),
				Effect.mapError(Port.failure('ai')),
				Effect.catch((e) => Queue.fail(queue, e))
			)
		);
}
