import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from 'effect';
import { encodeWire } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import { createBolt, type Bolt } from '../../bolt/build/page/bolt.js';
import type { EventSourceLike } from '../../bolt/build/page/stream.js';
import {
	ActBody,
	LiveBody,
	QBody,
	WireError,
	WireRead,
	type Frame,
	type Outcome as WireOutcome
} from '../../bolt/build/protocol/schema.js';
import type { ApprovalView, ViewBolt } from '../src/client/contract.ts';
import type { RecordCapabilities } from '../src/record/types.ts';

class Client extends Context.Service<Client, Bolt>()('ui/tests/ScriptedBolt') {}
export type ReadReply = Value | Response | Promise<Value | Response>;
export type Script = {
	answer(read: WireRead): ReadReply;
	start?(automation: string, input: Value): void;
	act?(body: ActBody, key: string): WireOutcome | Effect.Effect<WireOutcome, Error>;
	capabilities?(
		params: URLSearchParams
	): RecordCapabilities | null | Response | Promise<RecordCapabilities | null | Response>;
	approval?(
		params: URLSearchParams
	):
		| ApprovalView
		| null
		| readonly ApprovalView[]
		| Response
		| Promise<ApprovalView | null | readonly ApprovalView[] | Response>;
	/** A live read's changes: `emit` answers the read again; the returned function ends the subscription. */
	changes?(read: WireRead, emit: () => void): () => void;
	t?: ViewBolt['t'];
	runs?: ViewBolt['runs'];
	uuid?: () => string;
};
const decodeError = Schema.decodeUnknownOption(WireError);

/**
 * Script decoded wire requests; the real browser client owns reads (once over `/q`, live over `/live` and its stream),
 * read revival and native action failures. The live side speaks the host's frames: `hello` on connect, then an `answer`
 * per registered view, again whenever `changes` emits.
 */
export async function scriptedBolt(script: Script) {
	const sources = new Set<EventSourceLike>();
	const views = new Map<string, () => void>();
	let version = 0;
	const push = (frame: Frame) => {
		for (const source of sources)
			source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
	};
	const answer = async (view: string, read: WireRead) => {
		const reply = await script.answer(read);
		if (!(reply instanceof Response))
			return push({ t: 'answer', view, v: ++version, value: encodeWire(reply) });
		const failure = Option.getOrUndefined(decodeError(await reply.json().catch(() => null)));
		push({
			t: 'error',
			view,
			code: failure?.error.code ?? 'internal',
			message: failure?.error.message ?? reply.statusText
		});
	};
	const openStream = (): EventSourceLike => {
		const source: EventSourceLike = {
			onmessage: null,
			onerror: null,
			close: () => {
				sources.delete(source);
				if (sources.size !== 0) return;
				for (const release of views.values()) release();
				views.clear();
			}
		};
		sources.add(source);
		setTimeout(() => push({ t: 'hello', conn: 'c1', v: version }), 0);
		return source;
	};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url),
			path = url.pathname;
		if (path.endsWith('/record-capabilities')) {
			const value = (await script.capabilities?.(url.searchParams)) ?? null;
			return value instanceof Response ? value : Response.json(value === null ? null : { value });
		}
		if (path.endsWith('/approval')) {
			const value =
				(await script.approval?.(url.searchParams)) ?? (url.searchParams.has('id') ? null : []);
			return value instanceof Response
				? value
				: Response.json(value === null ? null : { value: encodeWire(value) });
		}
		const text = await request.text();
		if (path.endsWith('/live')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(LiveBody))(text);
			for (const view of body.drop ?? []) {
				views.get(view)?.();
				views.delete(view);
			}
			for (const { view, read } of body.add ?? []) {
				views.get(view)?.();
				views.set(view, script.changes?.(read, () => void answer(view, read)) ?? (() => {}));
				void answer(view, read);
			}
			return Response.json({ errors: [] });
		}
		if (path.endsWith('/q')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(QBody))(text);
			const answers: Value[] = [];
			for (const read of body.reads) {
				const reply = await script.answer(read);
				if (reply instanceof Response) return reply;
				answers.push(reply);
			}
			return Response.json({ answers: answers.map(encodeWire) });
		}
		if (path.endsWith('/act')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(ActBody))(text);
			if (body.callable === 'start') {
				const start = Schema.decodeUnknownSync(
					Schema.Struct({
						automation: Schema.String,
						runs: Schema.Array(Schema.Struct({ input: Schema.Json }))
					})
				)(body.input);
				for (const run of start.runs) script.start?.(start.automation, run.input);
			}
			const reply = script.act?.(body, request.headers.get('Idempotency-Key') ?? '') ?? {
				kind: 'committed',
				output: null,
				records: []
			};
			const outcome = Effect.isEffect(reply) ? await runtime.runPromise(reply) : reply;
			return Response.json({ outcome, v: 0 });
		}
		throw new Error(`Unexpected fixture request ${path}`);
	};
	const runtime = ManagedRuntime.make(
		Layer.effect(
			Client,
			createBolt({
				actor: null,
				locale: 'en',
				base: 'https://fixture.test',
				fetch,
				openStream,
				uuid: script.uuid ?? (() => 'r1'),
				now: () => '2026-01-02T03:04:05.000Z'
			})
		)
	);
	const native = await runtime.runPromise(Client);
	const { decode: _decode, options: _options, recordCapabilities: _capabilities, ...core } = native;
	const bolt: ViewBolt = {
		...core,
		clock: () => ({ today: '2026-01-02', now: '2026-01-02T03:04:05.000Z' }),
		...(script.capabilities === undefined ? {} : { recordCapabilities: native.recordCapabilities }),
		...(script.t === undefined ? {} : { t: script.t }),
		...(script.runs === undefined ? {} : { runs: script.runs })
	};
	const dispose = async () => {
		for (const release of views.values()) release();
		views.clear();
		await runtime.dispose();
	};
	return { bolt, client: native, runtime, dispose };
}
