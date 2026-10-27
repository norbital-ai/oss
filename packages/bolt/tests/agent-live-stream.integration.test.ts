// The agent's turn reaches the panel through the one live stream (§5.9, rules 64–66): while the model writes, its reply
// row is rewritten at most every STREAM_FLUSH_MS and each flush arrives as a `patch` of the conversation's live
// transcript (the text growing, `streaming` until the final write); a tool call is a `running` row finished in place;
// the conversation list patches `running` then `idle`. Nothing re-reads: each view has one `answer`, then patches. A stop
// keeps the partial reply, marked interrupted.
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Effect, FiberSet, Layer, Queue, Result, Schema, Stream } from 'effect';
import { Ai, type AiEvent } from '../src/engine/ports.ts';
import type { PortFailure } from '../src/engine/port.ts';
import { Port } from '../src/engine/port.ts';
import { Live } from '../src/engine/services.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { AgentConversation, AgentRow, Frame, LiveReply } from '../src/protocol/schema.ts';
import { STREAM_FLUSH_MS } from '../src/engine/agent/index.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { KitInvalid, respondSystem1, TestWorkspace } from '../src/test/index.ts';
import { sse } from './support/live-bolt.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {},
		relationships: {},
		exposures: {},
		policies: {},
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);
const sleep = (ms: number) => Effect.sleep(ms);
const ORIGIN = 'http://cell';
/** Long enough between two deltas for a flush to be written and routed. */
const GAP = STREAM_FLUSH_MS * 2;
const usage = { input: 10, output: 5 };
const until = (ok: () => boolean, n = 1_000) =>
	Effect.gen(function* () {
		for (let i = 0; i < n && !ok(); i++) yield* sleep(5);
		expect(ok()).toBe(true);
	});

type Infer = Ai['Service']['infer'];
const setup = (infer: Infer) =>
	Effect.gen(function* () {
		const ports = Layer.succeed(Ai, {
			ask: respondSystem1,
			maxChoices: undefined,
			models: ['default'],
			catalog: Port.unavailable('ai.catalog'),
			embed: () => Port.unavailable('ai.embed'),
			infer
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				ports,
				host: { publicUrl: ORIGIN },
				now: new Date(yield* Clock.currentTimeMillis).toISOString()
			})
		);
		const t = Context.get(context, TestWorkspace),
			live = Context.get(context, Live);
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
			params: []
		});
		const cookie = yield* t.session('ann');
		const request = (input: string | URL | Request, init?: RequestInit) => {
			const incoming = new Request(
				new URL(input instanceof Request ? input.url : String(input), ORIGIN),
				input instanceof Request ? input : init
			);
			incoming.headers.set('cookie', cookie);
			return t.handle(incoming);
		};
		const run = yield* FiberSet.makeRuntimePromise();
		const fetch: typeof globalThis.fetch = (input, init) => run(request(input, init));
		const api = shellApi(fetch, { base: ORIGIN });
		const started = yield* api.agent.start('Live');
		if (started.kind !== 'committed') throw new Error('start');
		const c = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
			started.output
		)).id;
		// the page's one live stream, and the panel's two views on it: the transcript and the conversation list
		const frames: (typeof Frame.Type)[] = [];
		const received = yield* Effect.acquireRelease(
			Queue.unbounded<typeof Frame.Type>(),
			Queue.shutdown
		);
		const open = yield* sse((u) => request(u));
		const source = open('/__bolt/live');
		source.onmessage = (m) => {
			const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))(m.data);
			frames.push(frame);
			Queue.offerUnsafe(received, frame);
		};
		yield* until(() => frames.some((f) => f.t === 'hello'));
		const hello = frames.find((f) => f.t === 'hello');
		if (hello?.t !== 'hello') throw new Error('no live connection');
		const reg = yield* request('/__bolt/live', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				conn: hello.conn,
				add: [
					{ view: 't', read: { m: 'transcript', a: [c] } },
					{ view: 'l', read: { m: 'conversations', a: [] } }
				]
			})
		});
		const raw = yield* Effect.tryPromise({
			try: () => reg.json(),
			catch: (error) => new KitInvalid({ message: String(error) })
		});
		expect((yield* Schema.decodeUnknownEffect(LiveReply)(raw)).errors).toEqual([]);
		yield* until(() => frames.filter((f) => f.t === 'answer').length === 2);
		/** Every row a view's patches carried, in arrival order. */
		const upserts = <A>(schema: Schema.Decoder<A>, view: string) =>
			frames.flatMap((f) =>
				f.t === 'patch' && f.view === view
					? f.ops.flatMap((o) =>
							o.op === 'upsert' ? [Schema.decodeUnknownSync(schema)(o.row)] : []
						)
					: []
			);
		const settled = () =>
			Effect.gen(function* () {
				yield* t.settled();
				yield* live.settled;
				const version = yield* live.v;
				while (!frames.some((frame) => frame.t === 'v' && frame.v >= version))
					yield* Queue.take(received);
			});
		return { t, api, c, fetch, frames, upserts, settled, close: () => source.close() };
	});

describe('the agent turn over the live stream', () => {
	it.live(
		'each flush of a reply arrives as a transcript patch while the model is still writing; tools run then finish in place',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let step = 0;
					const seen: boolean[] = [];
					let s!: Effect.Success<ReturnType<typeof setup>>;
					const partial = (text: string) =>
						s
							.upserts(AgentRow, 't')
							.some((r) => r.role === 'assistant' && r.state === 'streaming' && r.text === text);
					s = yield* setup(() =>
						Stream.callback<AiEvent, PortFailure>((queue) =>
							Effect.gen(function* () {
								if (++step === 1) {
									yield* Queue.offer(queue, { _tag: 'Progress', reasoning: 'Looking ' });
									yield* Queue.offer(queue, { _tag: 'Delta', text: 'Let me ' });
									yield* sleep(GAP);
									seen.push(partial('Let me '));
									yield* Queue.offer(queue, { _tag: 'Delta', text: 'check.' });
									yield* sleep(GAP);
									yield* Queue.offer(queue, {
										_tag: 'Response',
										response: {
											content: 'Let me check.',
											toolCalls: [{ id: 'k1', name: 'history', input: { query: 'x' } }],
											finish: 'tool',
											reasoning: 'Looking ',
											usage
										}
									});
								} else {
									yield* Queue.offer(queue, { _tag: 'Delta', text: 'All ' });
									yield* sleep(GAP);
									seen.push(partial('All '));
									yield* Queue.offer(queue, { _tag: 'Delta', text: 'done' });
									yield* sleep(GAP);
									seen.push(partial('All done'));
									yield* Queue.offer(queue, { _tag: 'Delta', text: '.' });
									yield* Queue.offer(queue, {
										_tag: 'Response',
										response: { content: 'All done.', toolCalls: [], finish: 'stop', usage }
									});
								}
								yield* Queue.end(queue);
							})
						)
					);
					try {
						const posted = yield* s.api.agent.post(s.c, 'status?', true);
						expect(posted.kind).toBe('committed');
						yield* s.settled();
						expect(seen).toEqual([true, true, true]);

						const rows = s.upserts(AgentRow, 't');
						const [first, second] = [
							...new Set(rows.filter((r) => r.role === 'assistant').map((r) => r.id))
						];
						const of = (id: string | undefined) => rows.filter((r) => r.id === id);
						// one row per reply: streamed flushes, then the final write in place, text only ever growing
						expect(of(first).at(-1)).toMatchObject({
							state: null,
							text: 'Let me check.',
							reasoning: 'Looking '
						});
						expect(of(second).at(-1)).toMatchObject({
							state: null,
							text: 'All done.',
							tag: 'reply'
						});
						for (const id of [first, second]) {
							const texts = of(id).map((r) => r.text ?? '');
							expect(texts.every((x, i) => i === 0 || x.startsWith(texts[i - 1]!))).toBe(true);
							// the cadence bounds the writes: at most one per delta, never one per token
							expect(of(id).filter((r) => r.state === 'streaming').length).toBeLessThanOrEqual(3);
						}
						// the tool call: a running row, then that row finished with its duration
						const tool = rows.filter((r) => r.role === 'tool');
						expect(new Set(tool.map((r) => r.id)).size).toBe(1);
						expect(tool[0]!.tool).toMatchObject({ name: 'history', running: true });
						expect(tool.at(-1)!.tool?.running).toBeUndefined();
						expect(typeof tool.at(-1)!.tool?.ms).toBe('number');
						// the list: this conversation ran, then settled
						const statuses = s
							.upserts(AgentConversation, 'l')
							.filter((r) => r.id === s.c)
							.map((r) => r.status);
						expect(statuses).toContain('running');
						expect(statuses.at(-1)).toBe('idle');
						// exact routing: each view was answered once and then only patched (no re-read, no second stream)
						expect(s.frames.flatMap((f) => (f.t === 'answer' ? [f.view] : [])).sort()).toEqual([
							'l',
							't'
						]);
						expect(s.frames.some((f) => f.t === 'error')).toBe(false);
					} finally {
						s.close();
					}
				})
			)
	);

	it.live(
		'a stop mid-reply keeps what was written, finished as interrupted, and the list reads stopped',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let s!: Effect.Success<ReturnType<typeof setup>>;
					s = yield* setup(() =>
						Stream.concat(
							Stream.fromIterable<AiEvent>([{ _tag: 'Delta', text: 'Half ' }]),
							Stream.fromEffect(Effect.never)
						)
					);
					try {
						yield* s.api.agent.post(s.c, 'go', true);
						yield* until(() =>
							s.upserts(AgentRow, 't').some((r) => r.state === 'streaming' && r.text === 'Half ')
						);
						yield* s.api.agent.stop(s.c);
						yield* s.settled();
						const reply = s
							.upserts(AgentRow, 't')
							.filter((r) => r.role === 'assistant')
							.at(-1)!;
						expect(reply).toMatchObject({ state: null, tag: 'cut', text: 'Half ' });
						expect(
							s
								.upserts(AgentConversation, 'l')
								.filter((r) => r.id === s.c)
								.at(-1)?.status
						).toBe('stopped');
					} finally {
						s.close();
					}
				})
			)
	);

	it.live('the model selector reads the current catalogue', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const s = yield* setup(() =>
					Stream.fromIterable<AiEvent>([
						{ _tag: 'Response', response: { content: 'Hi.', toolCalls: [], finish: 'stop', usage } }
					])
				);
				try {
					const models = yield* s.api.agent.models();
					expect(models.default).toBe('default');
				} finally {
					s.close();
				}
			})
		)
	);
});
