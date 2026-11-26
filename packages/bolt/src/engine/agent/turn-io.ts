// Per-turn I/O: structured logging, usage metering, observed model calls, typing presence, streaming rows, compaction and plan verification.
import {
	textOf,
	type AiRequest,
	type AiResponse,
	type FacilityFailure,
	type LogEvent,
	type Unavailable,
	uuidv7
} from '@norbital-ai/host-api';
import { sha256_hex } from '@norbital-ai/store';
import {
	Cause,
	Clock,
	Effect,
	Exit,
	Fiber,
	FiberHandle,
	Queue,
	Schedule,
	Schema,
	Stream
} from 'effect';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { settle as settleMessage, stream as streamMessage } from '../conversations/store.ts';
import type { Logs } from '../ports.ts';
import { Chain } from '../write/sql.ts';
import { modelCall } from './ai.ts';
import { COMPACT_FORMAT, modelTranscript, projection } from './context.ts';
import { isObj } from './draft.ts';
import type { AgentStore, InsertMessageRow } from './messages.ts';
import { requestEvidence, sequenceRanges } from './request.ts';
import type { As, ConversationRow, MessageRow, Meta, Plan, Usage } from './schema.ts';
import {
	AI_GAUGE_USD,
	fit,
	memoryOf,
	NO_AI,
	STREAM_FLUSH_MS,
	STREAM_GROWTH_RATIO,
	STREAM_MAX_SILENCE_MS,
	TYPING_REFRESH_MS,
	Unusable,
	type AgentConfig,
	type DrainOptions,
	type Streamer,
	type TurnState
} from './shared.ts';
import { inApp, storable } from './schema.ts';

export type StreamerDeps = {
	readonly id: string;
	readonly turn: string;
	readonly insert: AgentStore['insert'];
	readonly messageStatement: AgentStore['messageStatement'];
};

/**
 * The step's reply as the model writes it: one `streaming` row (the cut row a continuation extends), rewritten at most
 * every STREAM_FLUSH_MS once content has grown meaningfully (geometric threshold with a bounded silence ceiling to
 * avoid O(N^2) full-row DB rewrites), skipping no-op writes and redundant pre-settle flushes on normal completion.
 */
export const makeStreamer = (deps: StreamerDeps) =>
	Effect.fn('Agents.streamer')(function* (
		from: {
			row: MessageRow;
			text: string;
			reasoning: string;
		} | null
	) {
		const { id, turn, insert, messageStatement } = deps;
		let row = from?.row ?? null,
			text = from?.text ?? '',
			reasoning = from?.reasoning ?? '',
			lastFlushedTextLen = text.length,
			lastFlushedReasoningLen = reasoning.length,
			lastFlushAt = yield* Clock.currentTimeMillis,
			dirty = false,
			queued = false,
			closing = false,
			forceFlush = false;
		const textChunks: string[] = [];
		const reasoningChunks: string[] = [];
		// the text so far lives here; the queue only signals that it grew, so it holds one item however fast the model writes
		const queue = yield* Queue.sliding<void, Cause.Done>(1);
		const notify = () => {
			dirty = true;
			if (!queued) {
				queued = true;
				Queue.offerUnsafe(queue, undefined);
			}
		};
		const flush = yield* Stream.fromQueue(queue).pipe(
			Stream.groupedWithin(1024, STREAM_FLUSH_MS),
			Stream.runForEach(() =>
				Effect.gen(function* () {
					queued = false;
					if (closing && !forceFlush) return;
					if (!dirty && textChunks.length === 0 && reasoningChunks.length === 0) return;
					if (textChunks.length > 0) {
						text = text === '' ? textChunks.join('') : text + textChunks.join('');
						textChunks.length = 0;
					}
					if (reasoningChunks.length > 0) {
						reasoning =
							reasoning === '' ? reasoningChunks.join('') : reasoning + reasoningChunks.join('');
						reasoningChunks.length = 0;
					}
					const snapshotText = text,
						snapshotReasoning = reasoning;
					const deltaLen =
						snapshotText.length -
						lastFlushedTextLen +
						(snapshotReasoning.length - lastFlushedReasoningLen);
					if (deltaLen <= 0) {
						dirty = false;
						return;
					}
					const now = yield* Clock.currentTimeMillis;
					if (!forceFlush && row !== null) {
						const flushedLen = lastFlushedTextLen + lastFlushedReasoningLen;
						const minDelta = Math.floor(flushedLen * STREAM_GROWTH_RATIO);
						if (deltaLen < minDelta && now - lastFlushAt < STREAM_MAX_SILENCE_MS) {
							dirty = true;
							return;
						}
					}
					dirty = false;
					const content = {
						text: snapshotText,
						toolCalls: [],
						...(snapshotReasoning === '' ? {} : { reasoning: snapshotReasoning })
					};
					if (row === null)
						row = yield* insert({
							conversation: id,
							role: 'assistant',
							content,
							text: snapshotText,
							state: 'streaming',
							turn
						});
					else {
						const chain = new Chain(),
							source = streamMessage(chain, row.id, snapshotText, content);
						row = (yield* messageStatement(chain, source))[0] ?? row;
					}
					lastFlushedTextLen = snapshotText.length;
					lastFlushedReasoningLen = snapshotReasoning.length;
					lastFlushAt = now;
				}).pipe(
					// a flush only shows progress: one the database refuses is skipped, and the next writes everything so far
					Effect.catch((error) => {
						dirty = true;
						return Effect.logWarning('agent stream flush skipped', error);
					})
				)
			),
			Effect.forkScoped
		);
		const handle: Streamer = {
			delta: (value: string) => {
				if (value.length === 0) return;
				textChunks.push(value);
				notify();
			},
			reasoning: (value: string) => {
				if (value.length === 0) return;
				reasoningChunks.push(value);
				notify();
			},
			end: (flushFinal = false) =>
				Effect.gen(function* () {
					closing = true;
					forceFlush = flushFinal;
					if (
						flushFinal &&
						(dirty || textChunks.length > 0 || reasoningChunks.length > 0) &&
						!queued
					) {
						queued = true;
						Queue.offerUnsafe(queue, undefined);
					}
					yield* Queue.end(queue);
					yield* Fiber.join(flush);
					return row;
				})
		};
		return handle;
	});

export type TurnIoDeps = {
	readonly id: string;
	readonly turn: string;
	readonly config: AgentConfig;
	readonly logs: Logs['Service'];
	readonly manifestHash: string;
	readonly store: AgentStore;
	readonly current: TurnState;
	readonly onWrite?: DrainOptions['onWrite'];
};

export const makeTurnIo = Effect.fn('Agents.makeTurnIo')(function* (deps: TurnIoDeps) {
	const { id, turn, config, logs, manifestHash, store, current, onWrite } = deps;
	const { insert, messageStatement } = store;

	const log = (event: Pick<LogEvent, 'at' | 'severity' | 'event' | 'attributes'>) =>
		logs.write({
			at: event.at,
			severity: event.severity,
			event: event.event,
			invocation: turn,
			run: null,
			conversation: id,
			turn,
			attributes: event.attributes
		});

	const add = (u: Partial<Usage> & { provider?: string }, calls: number) => {
		current.usage.input += u.input ?? 0;
		current.usage.output += u.output ?? 0;
		current.usage.calls += calls;
		if (typeof u.cost === 'number') current.usage.cost = (current.usage.cost ?? 0) + u.cost;
		if (typeof u.cached === 'number') current.usage.cached = (current.usage.cached ?? 0) + u.cached;
		if (typeof u.reasoning === 'number')
			current.usage.reasoning = (current.usage.reasoning ?? 0) + u.reasoning;
		if (u.provider !== undefined)
			current.usage.providers = [...new Set([...(current.usage.providers ?? []), u.provider])];
	};

	/**
	 * each provider call is one immutable `ai.call` observation: its call id (the metering key), model, tokens
	 * and charge, `settlement: 'pending'` for the meter; a call reported without a charge or id is `attention`, never a guessed cost.
	 */
	const used = Effect.fn('Agents.recordUsage')(function* (r: AiResponse, request: string) {
		add(r.usage, 1);
		const { cost, call } = r.usage,
			over = cost !== undefined && cost > AI_GAUGE_USD,
			incomplete = cost === undefined || call === undefined,
			// the prefix is append-only, so a cache read under half the last one is a rewrite to find (or a provider switch)
			cacheDrop = r.usage.cached !== undefined && r.usage.cached < current.cached / 2;
		current.cached = r.usage.cached ?? current.cached;
		yield* log({
			at: (yield* config.bindings).now,
			severity: incomplete || over || cacheDrop ? 'warn' : 'info',
			event: 'ai.call',
			attributes: {
				category: 'chat',
				request,
				call: call ?? null,
				...(r.usage.provider === undefined ? {} : { provider: r.usage.provider }),
				model: current.model,
				input: r.usage.input,
				output: r.usage.output,
				cached: r.usage.cached ?? null,
				reasoning: r.usage.reasoning ?? null,
				prompt: r.usage.prompt ?? null,
				cost: cost ?? null,
				settlement: incomplete ? 'attention' : 'pending',
				...(over ? { gauge: AI_GAUGE_USD } : {}),
				...(cacheDrop ? { cacheDrop: true } : {}),
				...memoryOf()
			}
		});
	});

	const observed = Effect.fn('Agents.model')(function* (
		operation: 'chat' | 'compact' | 'verify',
		rows: readonly MessageRow[],
		conv: Pick<ConversationRow, 'plan'>,
		work: (
			onRequest: (request: AiRequest) => Effect.Effect<void>
		) => Effect.Effect<AiResponse, FacilityFailure | Unavailable>,
		sender?: string
	) {
		const request_id = uuidv7();
		const startedAt = yield* Clock.currentTimeMillis;
		const result = yield* work((request) =>
			log({
				at: new Date(startedAt).toISOString(),
				severity: 'info',
				event: 'ai.request',
				attributes: {
					request: request_id,
					phase: 'prepared',
					operation,
					manifest: manifestHash,
					evidence: requestEvidence(request),
					context: {
						through: rows.at(-1)?.seq ?? 0,
						projected: sequenceRanges(projection(rows, conv).map((row) => row.seq)),
						plan:
							conv.plan === null
								? null
								: {
										status: conv.plan.status,
										checkpoint: conv.plan.checkpoint,
										sha256: sha256_hex(JSON.stringify(conv.plan))
									},
						senderHash: sender === undefined ? null : sha256_hex(sender)
					}
				}
			})
		).pipe(
			Effect.onExit((exit) =>
				Effect.gen(function* () {
					yield* log({
						at: new Date(yield* Clock.currentTimeMillis).toISOString(),
						severity: 'info',
						event: 'ai.request.finished',
						attributes: {
							request: request_id,
							status: Exit.isSuccess(exit)
								? 'answered'
								: Cause.hasInterruptsOnly(exit.cause)
									? 'interrupted'
									: 'failed',
							finish: Exit.isSuccess(exit) ? exit.value.finish : null,
							milliseconds: (yield* Clock.currentTimeMillis) - startedAt,
							...memoryOf()
						}
					});
				})
			)
		);
		yield* used(result, request_id);
		return result;
	});

	const wall = config.wall_ms === undefined ? {} : { wallMs: config.wall_ms };

	// the linked chat shows the assistant typing from the step that answers new input until its reply is written (and
	// shipped by `onWrite`); a turn that ends while it still shows stops it
	const composing = yield* FiberHandle.make<void, never>();
	const typing = (on: boolean) =>
		current.typingIn === null || config.typing === undefined
			? Effect.void
			: config.typing(current.typingIn.integration, current.typingIn.thread, on);

	const startTyping = (conv: ConversationRow) =>
		Effect.gen(function* () {
			if (conv.integration === null || conv.thread === null || current.typingIn !== null) return;
			current.typingIn = { integration: conv.integration, thread: conv.thread };
			yield* FiberHandle.run(
				composing,
				typing(true).pipe(Effect.repeat(Schedule.spaced(TYPING_REFRESH_MS)), Effect.asVoid)
			);
		});

	const stopTyping = (paused: boolean) =>
		Effect.gen(function* () {
			if (current.typingIn === null) return;
			yield* FiberHandle.clear(composing);
			if (paused) yield* typing(false);
			current.typingIn = null;
		});

	const wrote = Effect.fn('Agents.wrote')(function* (row: MessageRow) {
		if (row.role === 'assistant' && (row.text ?? '') !== '') yield* stopTyping(false);
		if (onWrite !== undefined)
			yield* onWrite(row).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		return row;
	});

	const write = Effect.fn('Agents.write')(function* (r: InsertMessageRow) {
		return yield* wrote(yield* insert({ ...r, turn }));
	});

	/** A system row of this turn: the step's closing notes, events, asides, checkpoints and verdicts. */
	const systemRow = (
		text: string,
		meta: Meta,
		extra: Pick<InsertMessageRow, 'state' | 'mode' | 'as'> = {}
	) => write({ conversation: id, role: 'system', content: { text }, text, meta, ...extra });

	const appendNote = (text: string) => systemRow(text, { tag: 'note' });

	/** Rewrites a row the step already wrote (its streamed reply, its running tool call) as finished, in one statement. */
	const rewrite = Effect.fn('Agents.rewrite')(function* (
		row: MessageRow,
		content: Json,
		text: string | null,
		meta: Meta | null,
		extra: { state?: 'confirm'; as?: As | null } = {}
	) {
		const chain = new Chain(),
			source = settleMessage(chain, row.id, {
				content: storable(
					row.role === 'tool' && isObj(content)
						? { ...content, assistant: row.content.assistant }
						: content
				),
				text: text === null ? null : storable(text),
				meta: meta === null ? null : storable(meta),
				state: extra.state ?? null,
				...(extra.as === undefined ? {} : { as: extra.as })
			});
		const [updated] = yield* messageStatement(chain, source);
		if (updated === undefined)
			return yield* BoltError.make('corrupt', 'commit', 'the message settle returned no row');
		return updated;
	});

	/** An assistant row: the step's streamed row finished in place, else a new one. */
	const reply = (partial: MessageRow | null, content: Json, text: string, meta: Meta | null) =>
		partial !== null
			? Effect.flatMap(rewrite(partial, content, text, meta), wrote)
			: write({ conversation: id, role: 'assistant', content, text, meta });

	const streamer = makeStreamer({ id, turn, insert, messageStatement });

	const fail = Effect.fn('Agents.fail')(function* (
		conv: ConversationRow,
		text: string,
		code: string,
		detail?: string
	) {
		current.reply = yield* reply(null, { text, toolCalls: [] }, text, {
			tag: 'failed',
			code,
			...(detail !== undefined && inApp(conv) ? { detail } : {}),
			...(current.usage.calls === 0 ? {} : { usage: { ...current.usage } })
		});
		// a failed turn is a workspace log line naming the real reason; only an absent port is the missing provider
		const message =
			code === 'unavailable' && detail === NO_AI ? 'AI provider not configured' : (detail ?? code);
		yield* log({
			at: (yield* config.bindings).now,
			severity: code === 'unavailable' ? 'warn' : 'error',
			event: 'agent.failed',
			attributes: { code, message }
		});
	});

	/**
	 * The turn's one closing line (`agent.turn`): who it served, what it took and how it ended, never its words or its
	 * people. `stopped`: `reply`, `question` (asked, or waiting on a confirmation), `failed`, `stopped` (by a person),
	 * `limit` (a spend limit) or `steps` (the step cap).
	 */
	const summary = Effect.fn('Agents.turnSummary')(function* (stopped: boolean, duration_ms: number) {
		const meta = current.reply?.meta;
		yield* log({
			at: (yield* config.bindings).now,
			severity: 'info',
			event: 'agent.turn',
			attributes: {
				audience: current.audience,
				steps: current.steps,
				tool_errors: current.tool_errors,
				stopped: stopped
					? 'stopped'
					: meta?.tag === 'failed'
						? meta.code === 'spendLimit'
							? 'limit'
							: meta.code === 'stepCap'
								? 'steps'
								: 'failed'
						: meta?.tag === 'reply' && meta.asked !== true
							? 'reply'
							: 'question',
				duration_ms,
				...(current.usage.cost === undefined ? {} : { cost: current.usage.cost })
			}
		});
	});

	/**
	 * A checkpoint summary on the step's own prefix (its system and tools, the transcript, the instruction appended), so the
	 * provider's cache serves it; a transcript past the window is summarised from its newest part. An empty summary is
	 * asked for once more; answers whether the checkpoint was written, and a failed one is not tried again this turn.
	 */
	const compact = Effect.fn('Agents.compact')(function* (
		conv: ConversationRow,
		rows: readonly MessageRow[],
		keep: string[],
		origin: 'manual' | 'requested' | 'automatic',
		prefix: Pick<AiRequest, 'system' | 'tools'>,
		overflowed: boolean = false
	) {
		current.compactions++;
		current.lastInput = 0;
		const history = modelTranscript(rows, conv);
		return yield* Effect.gen(function* () {
			const response = yield* observed('compact', rows, conv, (onRequest) =>
				modelCall(
					config.ai,
					{
						model: conv.model,
						purpose: 'chat',
						...prefix,
						messages: [
							...(overflowed ? fit(history, 240_000) : history),
							{ role: 'user', content: COMPACT_FORMAT }
						]
					},
					{ ...wall, onRequest }
				)
			);
			const summary = textOf(response.content);
			if (summary.trim() === '')
				return yield* Effect.fail(new Unusable({ message: 'the compaction response was empty' }));
			const waiting = rows
				.filter((row) => row.state === 'queued' || row.state === 'pending')
				.map((row) => row.id);
			yield* systemRow(summary, {
				tag: 'compact',
				cutoff: Math.max(0, ...rows.map((row) => row.seq)),
				keep: [...keep, ...waiting],
				origin
			});
			// the transcript after a checkpoint is a new prefix: its first step reads little from the cache
			current.cached = 0;
			return true;
		}).pipe(
			Effect.retry({ times: 1, while: (error) => error instanceof Unusable }),
			Effect.catchTags({
				Unusable: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
				FacilityFailure: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
				Unavailable: (error) => Effect.logWarning(error).pipe(Effect.as(false))
			}),
			Effect.tap((written) =>
				Effect.sync(() => {
					if (!written) current.compactFailed = true;
				})
			)
		);
	});

	/**
	 * Verify the plan using the step's own prefix and transcript, then the plan and the instruction, so the provider's
	 * cache serves all but the tail. `null` when no verdict could be read.
	 */
	const verify = Effect.fn('Agents.verify')(function* (
		conv: ConversationRow,
		plan: Plan,
		rows: readonly MessageRow[],
		prefix: Pick<AiRequest, 'system' | 'tools'>
	) {
		const request: AiRequest = {
			model: conv.model,
			purpose: 'chat',
			...prefix,
			messages: [
				...modelTranscript(rows, conv),
				{
					role: 'user',
					content: [
						'Verify the plan below against the work above as an independent reviewer: completion claims are not evidence. Mark complete only when evidence shows every required outcome in the user request and plan was satisfied. A failed or untested required release or acceptance gate is a gap, even when the plan anticipated failure and the result was correctly reported. Do not relax the original requirement. List each unmet outcome in gaps. Answer JSON only, with no tool call: {"complete": boolean, "gaps": string[], "summary": string}.',
						`Plan revision ${plan.revision}:\n${plan.body}`
					].join('\n\n')
				}
			],
			output: { kind: 'json' }
		};
		const schema = Schema.Struct({
			complete: Schema.Boolean,
			gaps: Schema.Array(Schema.String),
			summary: Schema.optionalKey(Schema.String)
		});
		return yield* observed('verify', rows, conv, (onRequest) =>
			modelCall(config.ai, request, { ...wall, onRequest })
		).pipe(
			Effect.flatMap((response) =>
				response.finish === 'cut'
					? Effect.fail(new Unusable({ message: 'the verifier response was cut' }))
					: (typeof response.content === 'string'
							? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.content)
							: Schema.decodeUnknownEffect(schema)(response.content)
						).pipe(Effect.mapError((error) => new Unusable({ message: error.message })))
			),
			Effect.map((verdict) => ({
				complete: verdict.complete && verdict.gaps.length === 0,
				gaps: [...verdict.gaps],
				summary: verdict.summary ?? ''
			})),
			Effect.catchTags({
				Unusable: (error) => Effect.logWarning(error).pipe(Effect.as(null)),
				FacilityFailure: (error) => Effect.logWarning(error).pipe(Effect.as(null)),
				Unavailable: (error) => Effect.logWarning(error).pipe(Effect.as(null))
			})
		);
	});

	return {
		log,
		inApp,
		wall,
		observed,
		startTyping,
		stopTyping,
		wrote,
		write,
		systemRow,
		appendNote,
		rewrite,
		reply,
		streamer,
		fail,
		summary,
		compact,
		verify
	};
});

export type TurnIo = Effect.Success<ReturnType<typeof makeTurnIo>>;
