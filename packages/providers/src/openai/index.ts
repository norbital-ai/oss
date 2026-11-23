// Hosts: `sys_2.infer` over any OpenAI-compatible `/chat/completions` endpoint (bolt-server's `openai` provider, another host's
// OpenRouter). One call is one streamed completion: text deltas reach `onDelta` as they arrive, so the engine's 20 s idle wall
// (`modelCall`) cuts a long generation into a continued step instead of a `timeout`; tool calls assemble from
// their pieces and usage comes from the last chunk. A refusal rejects with the HTTP `status` (the engine spots context
// overflow by it). An endpoint that ignores `stream` and answers `application/json` is read whole.
import { Clock, Effect, Exit, Fiber, Hash, Option, Queue, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import {
	type AiEvent,
	type AiPrice,
	type AiRequest,
	type AiResponse,
	FacilityFailure,
	type OpenAiChat,
	Port,
	type PortFailure,
	provide_http,
	type HttpOptions
} from '@norbital-ai/host-api';
import type { Json } from 'effect/Schema';
import { AiAssistantContent, AiToolResult, HOST_LIMITS, textOf } from '@norbital-ai/host-api';
import { fileParts } from './files.ts';

/** An OpenAI-compatible `/chat/completions` endpoint for `open_ai_chat`: base URL, key, model map and metering. */
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
	/** A model's listed price, for an endpoint that reports no charge of its own: the call costs its tokens at that price. */
	price?: (model: string) => AiPrice | undefined;
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
const stepOf = Schema.decodeUnknownOption(AiToolResult),
	saidOf = Schema.decodeUnknownOption(AiAssistantContent);
/** What never changes in a conversation names it: a compaction starts a new prefix, nothing cached to lose, and sorts again. */
export const session_of = (request: Pick<AiRequest, 'system' | 'messages'>) =>
	String(Hash.string(`${request.system ?? ''}${JSON.stringify(request.messages[0])}`));

const CACHE_CONTROL = { type: 'ephemeral' } as const;
const isAnthropicModel = (model: string): boolean => {
	const lower = model.toLowerCase();
	return lower.startsWith('anthropic/') || lower.includes('claude');
};
const isOpenAiModel = (model: string): boolean => {
	const lower = model.toLowerCase();
	return lower.startsWith('openai/') || lower.startsWith('gpt-') || /^o[1-9]/.test(lower);
};
const markMessageCache = (message: Wire): boolean => {
	const content = message['content'];
	if (typeof content === 'string') {
		if (content.length === 0) return false;
		message['content'] = [{ type: 'text', text: content, cache_control: CACHE_CONTROL }];
		return true;
	}
	if (Array.isArray(content) && content.length > 0) {
		const last = content[content.length - 1];
		if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
			const updated = [...content];
			updated[updated.length - 1] = { ...last, cache_control: CACHE_CONTROL };
			message['content'] = updated;
			return true;
		}
	}
	return false;
};
const applyAnthropicCaching = (messages: Wire[], tools: Wire[] | undefined): void => {
	const first = messages[0];
	if (first !== undefined && first['role'] === 'system') markMessageCache(first);
	if (tools !== undefined && tools.length > 0) {
		const lastTool = tools[tools.length - 1];
		if (lastTool !== undefined) tools[tools.length - 1] = { ...lastTool, cache_control: CACHE_CONTROL };
	}
	const start = first !== undefined && first['role'] === 'system' ? 1 : 0;
	if (messages.length - start >= 2) {
		for (let i = messages.length - 2; i >= start; i--) {
			const msg = messages[i];
			if (msg !== undefined && markMessageCache(msg)) break;
		}
	}
};

/**
 * Engine messages (`{ text, toolCalls }` assistant rows, `{ id, name, result }` tool rows) as chat messages. A file a call
 * opened follows that call's results as a user message, on the one request after it: at the end, where no later prefix
 * holds it. Loose request files (`call === undefined`) anchor on the first user message so later nudges/repairs preserve
 * the cached prefix; one whose call is no longer in the history rides the last user message.
 */
function messagesOf(r: AiRequest): Wire[] {
	const out: Wire[] = r.system === undefined ? [] : [{ role: 'system', content: r.system }];
	// every step keeps its reasoning on every later call: a message never changes once sent, so the provider's cached
	// prefix holds. Dropping it at a new turn re-billed the whole conversation at each message a person sent.
	const files = (r.files ?? []).map((f, n) => ({
		call: f.call,
		parts: fileParts(f, `attachment-${n + 1}`)
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
			.flatMap((f) => f.parts);
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
			// the stored reasoning goes back with its reply (OpenRouter's `reasoning` on an assistant message)
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
	const loose = files.filter((f) => f.call === undefined).flatMap((f) => f.parts);
	if (loose.length > 0) {
		const first = out.find((m) => m['role'] === 'user' && typeof m['content'] === 'string');
		if (first === undefined) out.push({ role: 'user', content: loose });
		else first['content'] = [{ type: 'text', text: first['content'] }, ...loose];
	}
	const stranded = files
		.filter((f) => f.call !== undefined && !calls.has(f.call))
		.flatMap((f) => f.parts);
	if (stranded.length > 0) {
		const last = out.findLast((m) => m['role'] === 'user' && typeof m['content'] === 'string');
		if (last === undefined) out.push({ role: 'user', content: stranded });
		else last['content'] = [{ type: 'text', text: last['content'] }, ...stranded];
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
const OPENROUTER_RECONCILE_MS = 1_500;
const OpenRouterGeneration = Schema.Struct({
	data: Schema.optional(
		Schema.Struct({
			total_cost: Schema.optional(Schema.NullOr(Schema.Number))
		})
	),
	total_cost: Schema.optional(Schema.NullOr(Schema.Number))
});
const decodeOpenRouterGeneration = Schema.decodeUnknownEffect(
	Schema.fromJsonString(OpenRouterGeneration)
);
const isOpenRouterEndpoint = (baseUrl: string): boolean => {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
	} catch {
		return baseUrl.toLowerCase().includes('openrouter.ai');
	}
};

/**
 * Model inference over an OpenAI-compatible endpoint: each request is one streamed completion whose text deltas arrive
 * as events and whose last event carries the assembled response. A refusal fails with the HTTP status.
 */
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
				const baseUrl = config.endpoint.replace(/\/$/, '');
				const isOpenRouter = isOpenRouterEndpoint(baseUrl);
				const body = yield* Effect.try({
					try: () => {
						const messages = messagesOf(request);
						const tools: Wire[] | undefined =
							request.tools === undefined || request.tools.length === 0
								? undefined
								: request.tools.map((t) => ({
										type: 'function',
										function: { name: t.name, description: t.description, parameters: t.input }
									}));
						if (isAnthropicModel(model)) applyAnthropicCaching(messages, tools);
						const cacheKey =
							isOpenAiModel(model) && config.body?.['prompt_cache_key'] === undefined
								? typeof config.body?.['session_id'] === 'string'
									? config.body['session_id']
									: session_of(request)
								: undefined;
						const reasoningHint =
							request.reasoning_effort === undefined
								? {}
								: isOpenRouter
									? { reasoning: { effort: request.reasoning_effort } }
									: { reasoning_effort: request.reasoning_effort };
						return {
							...reasoningHint,
							...config.body,
							model,
							messages,
							stream: true,
							stream_options: { include_usage: true },
							...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
							...(tools === undefined ? {} : { tools }),
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
						};
					},
					catch: Port.failure('ai')
				});
				const req = yield* HttpClientRequest.bodyJson(
					HttpClientRequest.post(`${baseUrl}/chat/completions`, {
						headers: {
							'content-type': 'application/json',
							...(config.credential === undefined
								? {}
								: { authorization: `Bearer ${config.credential}` })
						}
					}),
					body
				).pipe(Effect.mapError(Port.failure('ai')));
				const promptChars = yield* Effect.try({
					try: () => JSON.stringify(body).length,
					catch: () => 0
				}).pipe(Effect.orElseSucceed(() => 0));
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
						Port.call('ai.body', HOST_LIMITS.callMs.ai)
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
				const fallbackId = `chat_${crypto.randomUUID()}`;
				let metered = false;
				const computeCost = (aborted: boolean) => {
					const rawInput = usage.prompt_tokens ?? 0;
					const rawOutput = usage.completion_tokens ?? 0;
					const estimatedOutput = Math.ceil(
						(text.length +
							reasoning.length +
							calls.reduce((sum, c) => sum + c.name.length + c.args.length, 0)) /
							4
					);
					const input =
						aborted && rawInput === 0 ? Math.max(1, Math.ceil(promptChars / 4)) : rawInput;
					const output = aborted && rawOutput === 0 ? estimatedOutput : rawOutput;
					const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
					const price = usage.cost === undefined ? config.price?.(model) : undefined;
					const cost =
						usage.cost ??
						(price === undefined
							? undefined
							: ((Math.max(0, input - cached)) * price.input +
									cached * (price.cached ?? price.input) +
									output * price.output) /
								1_000_000);
					return { input, output, cost };
				};
				const reconcileOpenRouterCost = (generationId: string) =>
					Effect.gen(function* () {
						const queryReq = HttpClientRequest.get(
							`${baseUrl}/generation?id=${encodeURIComponent(generationId)}`,
							{
								headers:
									config.credential === undefined
										? {}
										: { authorization: `Bearer ${config.credential}` }
							}
						);
						const fetchCost = Effect.gen(function* () {
							const genRes = yield* HttpClient.execute(queryReq);
							if (genRes.status < 200 || genRes.status >= 300) return undefined;
							const raw = yield* genRes.text;
							const decoded = yield* decodeOpenRouterGeneration(raw);
							const exact = decoded.data?.total_cost ?? decoded.total_cost;
							return typeof exact === 'number' && Number.isFinite(exact) && exact >= 0
								? exact
								: undefined;
						});
						const child = yield* Effect.forkDetach(Effect.interruptible(fetchCost));
						return yield* Fiber.join(child).pipe(
							Port.call('ai.generation', OPENROUTER_RECONCILE_MS),
							Effect.onError(() => Fiber.interrupt(child))
						);
					}).pipe(Effect.catch(() => Effect.succeed(undefined)));
				const settleMeter = (aborted: boolean) =>
					Effect.gen(function* () {
						if (metered || config.meter === undefined) return;
						let { cost } = computeCost(aborted);
						const meterId = id !== '' ? id : aborted ? fallbackId : '';
						if (aborted && usage.cost === undefined && isOpenRouter && id !== '') {
							const exact = yield* reconcileOpenRouterCost(id);
							if (exact !== undefined) cost = exact;
						}
						if (cost === undefined || meterId === '') return;
						metered = true;
						const report = Port.attempt('ai.meter', () =>
							Promise.resolve(config.meter?.(cost, meterId))
						).pipe(Port.call('ai.meter', HOST_LIMITS.callMs.ai));
						yield* aborted ? report.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore) : report;
					});
				const consume: Effect.Effect<void, PortFailure> = (
					res.headers['content-type'] ?? ''
				).includes('application/json')
					? res.text.pipe(
							Effect.mapError(Port.failure('ai')),
							Port.call('ai.body', HOST_LIMITS.callMs.ai),
							Effect.flatMap((raw) => decodeChunk(raw).pipe(Effect.mapError(Port.failure('ai')))),
							Effect.flatMap((chunk) => accept(chunk, true)),
							Effect.asVoid
						)
					: Stream.transformPull(res.stream, (pull) =>
							Effect.succeed(pull.pipe(Port.call('ai.stream', HOST_LIMITS.callMs.ai)))
						).pipe(
							Stream.decodeText(),
							Stream.splitLines,
							Stream.map((s) => s.trim()),
							Stream.filter(
								(s) =>
									s.startsWith(':') || (s.startsWith('data:') && s.slice(5).trim() !== '[DONE]')
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
				yield* consume.pipe(
					Effect.onExit((exit) =>
						Exit.isSuccess(exit) ? Effect.void : Effect.uninterruptible(settleMeter(true))
					)
				);
				const { input, output, cost } = computeCost(false);
				yield* settleMeter(false);
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
					tool_calls: toolCalls,
					finish: finishReason === 'length' ? 'cut' : toolCalls.length > 0 ? 'tool' : 'stop',
					...(reasoning === '' ? {} : { reasoning }),
					usage: {
						input,
						output,
						...(cost === undefined ? {} : { cost }),
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
