// Hosts: `sys_2.infer` over any OpenAI-compatible `/chat/completions` endpoint (bolt-server's `openai` provider, another host's
// OpenRouter). One call is one streamed completion: text deltas reach `onDelta` as they arrive, so the engine's 20 s idle wall
// (`modelCall`) cuts a long generation into a continued step instead of a `timeout` (rule 63); tool calls assemble from
// their pieces and usage comes from the last chunk. A refusal rejects with the HTTP `status` (the engine spots context
// overflow by it). An endpoint that ignores `stream` and answers `application/json` is read whole.
import { Effect, Option, Predicate, Queue, Schema, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { FacilityFailure } from '../../decl/errors.ts';
import { Port, type PortFailure } from '../port.ts';
import type { AiEvent } from '../ports.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type AiRequest, type AiResponse } from '../contracts.ts';
import { csvOf, xlsxCells, xlsxSheets } from '../files/xlsx.ts';

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
	meter?: (costUsd: number, generationId: string) => Promise<void> | void;
};

type Wire = { [k: string]: unknown };
const textOf = (c: Json): string =>
	typeof c === 'string'
		? c
		: Predicate.isObject(c) && typeof c['text'] === 'string'
			? c['text']
			: JSON.stringify(c);
const TEXT = /^(text\/|application\/(json|csv|xml|[\w.-]+\+(json|xml))$)/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dataUrl = (f: { mime: string; bytes: Uint8Array }) =>
	`data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`;

/** Engine messages (`{ text, toolCalls }` assistant rows, `{ id, name, result }` tool rows) as chat messages; files ride the last user message. */
function messagesOf(r: AiRequest): Wire[] {
	const out: Wire[] = r.system === undefined ? [] : [{ role: 'system', content: r.system }];
	for (const m of r.messages) {
		const c = Predicate.isObject(m.content) ? m.content : {};
		if (m.role === 'tool')
			out.push({
				role: 'tool',
				tool_call_id: String(c['id'] ?? ''),
				content: JSON.stringify(c['result'] ?? null)
			});
		else if (m.role === 'assistant') {
			const calls = Array.isArray(c['toolCalls'])
				? c['toolCalls'].filter((x) => Predicate.isObject(x))
				: [];
			// L-BOLT-412: the stored reasoning goes back with its reply (OpenRouter's `reasoning` on an assistant message)
			out.push({
				role: 'assistant',
				content: textOf(m.content),
				...(typeof c['reasoning'] === 'string' && c['reasoning'] !== ''
					? { reasoning: c['reasoning'] }
					: {}),
				...(calls.length === 0
					? {}
					: {
							tool_calls: calls.map((t) => ({
								id: t['id'],
								type: 'function',
								function: { name: t['name'], arguments: JSON.stringify(t['input'] ?? {}) }
							}))
						})
			});
		} else out.push({ role: 'user', content: textOf(m.content) });
	}
	const files = r.files ?? [];
	if (files.length > 0) {
		// images as image parts, a PDF as a file part, text and an xlsx's sheets (as CSV) as text: providers refuse other file parts
		const parts = files.map((f, n) => {
			const name = `attachment-${n + 1}`;
			if (f.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: dataUrl(f) } };
			if (f.mime === 'application/pdf')
				return { type: 'file', file: { filename: name, file_data: dataUrl(f) } };
			if (TEXT.test(f.mime))
				return { type: 'text', text: `${name} (${f.mime}):\n${new TextDecoder().decode(f.bytes)}` };
			if (f.mime === XLSX)
				return {
					type: 'text',
					text: xlsxSheets(f.bytes)
						.map(
							(sheet, i) => `${name} sheet ${i} "${sheet}" (CSV):\n${csvOf(xlsxCells(f.bytes, i))}`
						)
						.join('\n')
				};
			throw new Error(
				`${name}: a file of type ${f.mime} cannot be sent to the model; attach an image, a PDF, text or an xlsx workbook`
			);
		});
		const last = out.findLast((m) => m['role'] === 'user');
		if (last === undefined) out.push({ role: 'user', content: parts });
		else last['content'] = [{ type: 'text', text: last['content'] }, ...parts];
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
	error: Schema.optional(
		Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.Number) })
	),
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				prompt_tokens: Schema.optional(Schema.Number),
				completion_tokens: Schema.optional(Schema.Number),
				cost: Schema.optional(Schema.Number)
			})
		)
	),
	choices: Schema.optional(
		Schema.Array(Schema.Struct({ delta: Schema.optional(Part), message: Schema.optional(Part) }))
	)
});
const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk));
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The caller's HTTP client, else fetch (the caller's `fetch` when given). */
export type HttpOptions = { httpClient?: HttpClient.HttpClient; fetch?: typeof fetch };
export const provideHttp =
	(options: HttpOptions) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const provided =
			options.httpClient === undefined
				? effect.pipe(Effect.provide(FetchHttpClient.layer))
				: effect.pipe(Effect.provideService(HttpClient.HttpClient, options.httpClient));
		return options.httpClient === undefined && options.fetch !== undefined
			? provided.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))
			: provided;
	};
/** One call is a cancellable stream; its final event carries the assembled response. */
export type OpenAiChat = (request: AiRequest) => Stream.Stream<AiEvent, PortFailure>;
export function openAiChat(config: OpenAiChatConfig, options: HttpOptions = {}): OpenAiChat {
	return (request) =>
		Stream.callback<AiEvent, PortFailure>((queue) =>
			Effect.gen(function* () {
				let text = '',
					reasoning = '',
					id = '';
				let usage: NonNullable<Schema.Schema.Type<typeof Chunk>['usage']> = {};
				const calls: Call[] = [];
				const body = yield* Effect.try({
					try: () => ({
						...config.body,
						model: config.models[request.model] ?? request.model,
						messages: messagesOf(request),
						stream: true,
						stream_options: { include_usage: true },
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
					Port.call('ai.headers', LIMITS.callMs.ai)
				);
				if (res.status < 200 || res.status >= 300) {
					const detail = yield* res.text.pipe(
						Effect.mapError(Port.failure('ai')),
						Port.call('ai.body', LIMITS.callMs.ai)
					);
					const tooLarge =
						res.status === 413 ||
						(res.status === 400 && /maximum context|context[_ ](?:length|window)/i.test(detail));
					return yield* Effect.fail(
						new FacilityFailure({
							kind: tooLarge ? 'tooLarge' : 'upstream',
							status: res.status,
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
						onSome: (input) => ({ id: c.id, name: c.name, input }),
						onNone: () => ({
							id: c.id,
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
					finish: toolCalls.length > 0 ? 'tool' : 'stop',
					...(reasoning === '' ? {} : { reasoning }),
					usage: {
						input: usage.prompt_tokens ?? 0,
						output: usage.completion_tokens ?? 0,
						...(usage.cost === undefined ? {} : { cost: usage.cost }),
						...(id === '' ? {} : { call: id })
					}
				};
				yield* Queue.offer(queue, { _tag: 'Response', response });
				yield* Queue.end(queue);
			}).pipe(
				provideHttp(options),
				Effect.mapError(Port.failure('ai')),
				Effect.catch((e) => Queue.fail(queue, e))
			)
		);
}
