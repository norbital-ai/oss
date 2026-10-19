import { Context, Effect, Layer, ManagedRuntime, Queue, Schema, Stream } from 'effect';
import { encodeWire } from '@norbital-ai/std/wire';
import type { Value } from '@norbital-ai/std/kind';
import { createBolt, type Bolt } from '../../bolt/build/page/bolt.js';
import {
	ActBody,
	QBody,
	WireRead,
	type Outcome as WireOutcome
} from '../../bolt/build/protocol/schema.js';
import type { ApprovalView, Q, ViewBolt } from '../src/client/contract.ts';
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
	changes?(read: WireRead, emit: () => void): () => void;
	t?: ViewBolt['t'];
	runs?: ViewBolt['runs'];
	uuid?: () => string;
};

/** Script decoded wire requests; the real browser client owns read revival and native action failures. */
export async function scriptedBolt(script: Script) {
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
		if (path.endsWith('/q')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(QBody))(text);
			const answers: Value[] = [];
			for (const read of body.reads) {
				const answer = await script.answer(read);
				if (answer instanceof Response) return answer;
				answers.push(answer);
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
			const answer = script.act?.(body, request.headers.get('Idempotency-Key') ?? '') ?? {
				kind: 'committed',
				output: null,
				records: []
			};
			const outcome = Effect.isEffect(answer) ? await runtime.runPromise(answer) : answer;
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
				uuid: script.uuid ?? (() => 'r1'),
				now: () => '2026-01-02T03:04:05.000Z'
			})
		)
	);
	const native = await runtime.runPromise(Client);
	const {
		decode: _decode,
		options: _options,
		recordCapabilities: _capabilities,
		approvals: _approvals,
		...core
	} = native;
	const bolt: ViewBolt = {
		...core,
		approvals: {
			process: native.approvals.process,
			...(script.approval === undefined
				? {}
				: { get: native.approvals.get, list: native.approvals.list })
		},
		...(script.capabilities === undefined ? {} : { recordCapabilities: native.recordCapabilities }),
		live: <A>(read: Q<A>) =>
			Stream.callback<void>((queue) =>
				Effect.gen(function* () {
					const emit = () => {
						Queue.offerUnsafe(queue, undefined);
					};
					const release = script.changes?.(Schema.decodeUnknownSync(WireRead)(read.read), emit);
					if (release !== undefined) yield* Effect.addFinalizer(() => Effect.sync(release));
					emit();
				})
			).pipe(Stream.mapEffect(() => read)),
		...(script.t === undefined ? {} : { t: script.t }),
		...(script.runs === undefined ? {} : { runs: script.runs })
	};
	return { bolt, client: native, runtime, dispose: () => runtime.dispose() };
}
