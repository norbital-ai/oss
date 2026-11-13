import { Context, Effect, Layer, ManagedRuntime, Option, Schema } from 'effect';
import type { Value } from '@norbital-ai/store/kind';
import { create_bolt, type Bolt, type BoltConfig } from '../../bolt/build/page/bolt.js';
import type { EventSourceLike } from '../../bolt/build/page/stream.js';
import { view_client } from '../../bolt/build/page/view-client.js';
import type { ReadCatalog } from '../../bolt/build/protocol/read-answer.js';
import {
	ActBody,
	LiveBody,
	QBody,
	SyncControlBody,
	WireError,
	WireRead,
	type Frame,
	type Outcome as WireOutcome
} from '../../bolt/build/protocol/schema.js';
import { admitted, committed } from './act-envelope.ts';
import type { ApprovalView, ViewBolt } from '../src/client/contract.ts';
import type { RecordCapabilities } from '../src/record/types.ts';

class Client extends Context.Service<Client, Bolt>()('ui/tests/ScriptedBolt') {}
export type ReadReply = Value | Response | Promise<Value | Response>;
export type Script = {
	answer(read: WireRead): ReadReply;
	start?(automation: string, input: Value): void;
	act?(body: ActBody, key: string): WireOutcome | Effect.Effect<WireOutcome, Error>;
	sync_control?(body: SyncControlBody, key: string): WireOutcome | Effect.Effect<WireOutcome, Error>;
	operation_outputs?: BoltConfig['operation_outputs'];
	/** The granted read outputs every model view and answer decodes against. */
	read_catalog?: ReadCatalog;
	catalog?: Parameters<typeof view_client>[2];
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
type Catalog = Parameters<typeof view_client>[2];
type Level = ReadCatalog[string][string][string];

/**
 * The read outputs a host grants for a model catalogue, as `read_catalog` builds them from the same manifest: each model's
 * `default` (and named `output`) reads its fields, relation refs, `id` and audit columns, nesting its declared layers.
 */
export function read_catalog_of(catalog: Catalog): ReadCatalog {
	const level = (model: string, exposure: Catalog[string], many: boolean): Level => {
		const fields: Level['fields'] = {
			// the host expands a custom field to JSON of its shape; the fixture knows no shapes
			...Object.fromEntries(Object.entries(exposure.fields).map(([name, kind]) => {
				if (kind.kind !== 'custom') return [name, kind];
				const { kind: _kind, of: _of, ...common } = kind;
				return [name, { kind: 'json', ...common }];
			})),
			...Object.fromEntries(Object.entries(exposure.relations ?? {}).map(([name, relation]) => {
				const [first, ...rest] = relation.targets;
				return [name, {
					kind: 'ref', to: first !== undefined && rest.length === 0 ? first : relation.targets,
					...(relation.optional === true ? { optional: true } : {})
				}] as const;
			})),
			id: { kind: 'ref', to: model },
			...(exposure.audit === false ? {} : { revision: { kind: 'int' } })
		};
		// a list reads every field but the heavy ones (json, custom, file), as the store's `default_fields`
		const list_fields = Object.entries(fields).filter(([, kind]) => !['json', 'custom', 'file'].includes(kind.kind)).map(([name]) => name);
		return { model, many, list_fields, fields };
	};
	return Object.fromEntries(Object.entries(catalog).map(([model, exposure]) => {
		const root = level(model, exposure, false);
		const layers = [
			// every one-relation nests (fixture catalogues seldom list `layers`)
			...Object.entries(exposure.relations ?? {}).map(([rel, relation]) => [rel, relation.targets[0], false] as const),
			...(exposure.many ?? []).map((rel) => [rel, exposure.children?.[rel]?.model, true] as const)
		].flatMap(([rel, target, many]) => {
			const nested = target === undefined ? undefined : catalog[target];
			return target === undefined || nested === undefined ? [] : [[`${model}.${rel}`, level(target, nested, many)] as const];
		});
		const output = { [model]: root, ...Object.fromEntries(layers) };
		return [model, { default: output, ...(exposure.output === undefined ? {} : { [exposure.output]: output }) }];
	}));
}

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
			return push({ t: 'answer', view, v: ++version, value: reply });
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
				: Response.json(value === null ? null : { value });
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
			return Response.json({ answers });
		}
		if (path.endsWith('/act')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(ActBody))(text);
			if ('callable' in body && body.callable === 'run') {
				const start = Schema.decodeUnknownSync(
					Schema.Struct({
						automation: Schema.String,
						runs: Schema.optionalKey(Schema.Array(Schema.Struct({ input: Schema.Json })))
					})
				)(body.input);
				for (const run of start.runs ?? []) script.start?.(start.automation, run.input);
			}
			const reply: WireOutcome | Effect.Effect<WireOutcome, Error> = script.act?.(body, request.headers.get('Idempotency-Key') ?? '') ?? committed(body);
			const outcome = Effect.isEffect(reply) ? await runtime.runPromise(reply) : reply;
			return Response.json({ outcome, v: 0 });
		}
		if (path.endsWith('/sync')) {
			const body = Schema.decodeUnknownSync(Schema.fromJsonString(SyncControlBody))(text);
			const reply: WireOutcome | Effect.Effect<WireOutcome, Error> = script.sync_control?.(body, request.headers.get('Idempotency-Key') ?? '') ?? admitted(body);
			const outcome = Effect.isEffect(reply) ? await runtime.runPromise(reply) : reply;
			return Response.json({ outcome, v: 0 });
		}
		throw new Error(`Unexpected fixture request ${path}`);
	};
	const read_catalog = script.read_catalog ?? read_catalog_of(script.catalog ?? {});
	const runtime = ManagedRuntime.make(
		Layer.effect(
			Client,
			create_bolt({
				actor: null,
				locale: 'en',
				base: 'https://fixture.test',
				fetch,
				open_stream: openStream,
				operation_outputs: script.operation_outputs ?? { automations: {} },
				read_catalog,
				uuid: script.uuid ?? (() => 'r1'),
				now: () => '2026-01-02T03:04:05.000Z'
			})
		)
	);
	const native = await runtime.runPromise(Client);
	const { decode: _decode, options: _options, record_capabilities: _capabilities, ...core } = native;
	const bolt: ReturnType<typeof view_client> = {
		...view_client(core, read_catalog, script.catalog ?? {}),
		clock: () => ({ today: '2026-01-02', now: '2026-01-02T03:04:05.000Z' }),
		...(script.capabilities === undefined ? {} : { record_capabilities: native.record_capabilities }),
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
