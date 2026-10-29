// The membrane (compute model §14): HOST_API's Promise boundary carried across an isolate instead of a module graph.
// Both sides run this codec over their own globals. Each side keeps a table of what it handed over — functions,
// signals, streams — and mirrors what the other side handed it; a mirror the garbage collector takes is released on
// the other side. Values cross as structured clones (JSON, `Uint8Array`, `Map`, `undefined`) plus these wire forms:
//   { $fn: id }                 a function: calling the mirror is a `call` message
//   { $signal: id }             an AbortSignal: its abort is an `abort` message
//   { $stream: id }             a ReadableStream: read chunk by chunk (`pull` → `write` | `end` | `error`)
//   { $request: … }, { $response: … }   method or status, url, headers as pairs, body bytes or a `$stream`
//   { $handle: id, fields }     an object holding functions (a port, an ActiveWorkspace): it keeps its identity
//   { $back: id }               a mirror handed back: the other side's own function, object or signal again
//   { $error: fields }          an Error's name, message and own fields (an encoded `HostApiFailure` is already data)
//   { $obj: fields }            a data object that has one of these keys itself
// No Node here: in a cell this runs over the cell's globals.
import { Schema } from 'effect';
import { BODY_BYTES, isObject } from './cell-globals.ts';

/** The kernel refuses a cell whose number differs from its own. */
export const CELL_ABI_VERSION = 1;

const Id = Schema.Number;
/** Every message between the two sides; each one the kernel sends into a cell is one entry. */
export const Message = Schema.Union([
	Schema.Tuple([Schema.Literal('call'), Id, Schema.Array(Schema.Unknown), Id]),
	Schema.Tuple([Schema.Literals(['resolve', 'reject', 'abort', 'error']), Id, Schema.Unknown]),
	Schema.Tuple([Schema.Literal('write'), Id, Schema.Uint8Array]),
	Schema.Tuple([Schema.Literals(['pull', 'end']), Id]),
	Schema.Tuple([Schema.Literal('release'), Schema.Array(Id)])
]);
export type Message = typeof Message.Type;
/** A call's answer when its function answered at once; none means a `resolve` or `reject` message follows. */
export const Answer = Schema.UndefinedOr(
	Schema.Tuple([Schema.Literals(['ok', 'fail']), Schema.Unknown])
);
export type Answer = typeof Answer.Type;

const decodeMessage = Schema.decodeUnknownSync(Message),
	decodeAnswer = Schema.decodeUnknownSync(Answer);
const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const Body = Schema.Union([Schema.Null, Schema.Uint8Array, Schema.Struct({ $stream: Id })]);
const Signal = Schema.Struct({
	$signal: Id,
	aborted: Schema.optional(Schema.Boolean),
	reason: Schema.optional(Schema.Unknown)
});
const decodeFn = Schema.decodeUnknownSync(Schema.Struct({ $fn: Id })),
	decodeBack = Schema.decodeUnknownSync(Schema.Struct({ $back: Id })),
	decodeHandle = Schema.decodeUnknownSync(
		Schema.Struct({ $handle: Id, fields: Schema.Record(Schema.String, Schema.Unknown) })
	),
	decodeSignal = Schema.decodeUnknownSync(Signal),
	decodeStream = Schema.decodeUnknownSync(Schema.Struct({ $stream: Id })),
	decodeRequest = Schema.decodeUnknownSync(
		Schema.Struct({
			$request: Schema.Struct({
				method: Schema.String,
				url: Schema.String,
				headers: Pairs,
				body: Body,
				signal: Signal
			})
		})
	),
	decodeResponse = Schema.decodeUnknownSync(
		Schema.Struct({
			$response: Schema.Struct({
				status: Schema.Number,
				statusText: Schema.String,
				headers: Pairs,
				body: Body
			})
		})
	),
	decodeError = Schema.decodeUnknownSync(
		Schema.Struct({ $error: Schema.Record(Schema.String, Schema.Unknown) })
	);
const MARKERS = [
	'$fn',
	'$signal',
	'$stream',
	'$request',
	'$response',
	'$handle',
	'$back',
	'$error',
	'$obj'
];

type Exported =
	| { readonly kind: 'fn'; readonly fn: Function; readonly self: unknown }
	| { readonly kind: 'object'; readonly value: object }
	| { readonly kind: 'signal'; readonly signal: AbortSignal; readonly stop: () => void }
	| {
			readonly kind: 'stream';
			readonly stream: ReadableStream<unknown>;
			reader: ReadableStreamDefaultReader<unknown> | undefined;
	  };
type Incoming = {
	controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	pulled: (() => void) | undefined;
};
type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
};

export type Membrane = {
	/** A value in its wire form; what it hands over is this side's until the other side releases it. */
	readonly encode: (value: unknown) => unknown;
	/** A wire value with mirrors for what the other side handed over. */
	readonly decode: (value: unknown) => unknown;
	/** One message from the other side; a call answers at once when its function did. */
	readonly receive: (message: unknown) => Answer;
	/** The other side is gone: pending calls reject with `failure`, incoming streams error, nothing is handed over. */
	readonly close: (failure: unknown) => void;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	isObject(value) && typeof Reflect.get(value, 'then') === 'function';
const utf8 = new TextEncoder();
const chunkBytes = (chunk: unknown): Uint8Array =>
	chunk instanceof Uint8Array
		? chunk
		: ArrayBuffer.isView(chunk)
			? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
			: typeof chunk === 'string'
				? utf8.encode(chunk)
				: new Uint8Array(0);
const ignore = () => undefined;
const headersOf = (pairs: typeof Pairs.Type) => {
	const headers = new Headers();
	for (const [name, value] of pairs) headers.append(name, value);
	return headers;
};

/** One side of the membrane; `send` delivers a message to the other side and returns its answer, if it gave one. */
export const membrane = (send: (message: Message) => unknown): Membrane => {
	const exported = new Map<number, Exported>(),
		pending = new Map<number, Pending>(),
		signals = new Map<number, WeakRef<AbortController>>(),
		streams = new Map<number, WeakRef<Incoming>>(),
		// a mirror with a pull out: only the other side's answer can settle the read waiting on it, so the collector
		// must not take the stream, its reader and that read as one unreachable cycle
		reading = new Map<number, Incoming>();
	// a mirrored signal keeps its controller, a decoded request its signal
	const kept = new WeakMap<object, object>();
	// each mirror's id on the other side, so handing it back hands back the original
	const origin = new WeakMap<object, number>();
	let ids = 0,
		calls = 0,
		closed: { readonly failure: unknown } | undefined;
	// what the collector took since the last microtask leaves as one message
	let unused: number[] = [];
	const released = new FinalizationRegistry<number>((id) => {
		signals.delete(id);
		streams.delete(id);
		if (closed !== undefined) return;
		if (unused.push(id) === 1)
			queueMicrotask(() => {
				const ids = unused;
				unused = [];
				if (closed === undefined) send(['release', ids]);
			});
	});

	const exportFn = (fn: Function, self: unknown) => {
		const id = ++ids;
		exported.set(id, { kind: 'fn', fn, self });
		return { $fn: id };
	};
	const exportStream = (stream: ReadableStream<unknown>) => {
		const id = ++ids;
		exported.set(id, { kind: 'stream', stream, reader: undefined });
		return { $stream: id };
	};
	const exportSignal = (signal: AbortSignal) => {
		const id = ++ids;
		if (signal.aborted) return { $signal: id, aborted: true, reason: encode(signal.reason) };
		const abort = () => {
			exported.delete(id);
			send(['abort', id, encode(signal.reason)]);
		};
		signal.addEventListener('abort', abort, { once: true });
		exported.set(id, {
			kind: 'signal',
			signal,
			stop: () => signal.removeEventListener('abort', abort)
		});
		return { $signal: id };
	};
	const body = (message: Request | Response) => {
		const bytes: unknown = Reflect.get(message, BODY_BYTES);
		return bytes instanceof Uint8Array
			? bytes
			: message.body === null
				? null
				: exportStream(message.body);
	};
	/** Own fields, functions bound to their object; a class instance's methods come along. */
	const fields = (value: object, into: Record<string, unknown>) => {
		for (const key of Object.keys(value)) {
			const field: unknown = Reflect.get(value, key);
			into[key] =
				typeof field === 'function' && !origin.has(field) ? exportFn(field, value) : encode(field);
		}
		for (
			let proto: unknown = Object.getPrototypeOf(value);
			isObject(proto) && proto !== Object.prototype;
			proto = Object.getPrototypeOf(proto)
		)
			for (const key of Object.getOwnPropertyNames(proto)) {
				const method: unknown = Object.getOwnPropertyDescriptor(proto, key)?.value;
				if (key !== 'constructor' && typeof method === 'function' && !(key in into))
					into[key] = exportFn(method, value);
			}
		return into;
	};
	const encode = (value: unknown): unknown => {
		if (typeof value === 'symbol') return undefined;
		if (typeof value !== 'function' && !isObject(value)) return value;
		const back = origin.get(value);
		// an aborted mirror's original is gone from the other side's table: it crosses aborted instead
		if (back !== undefined && !(value instanceof AbortSignal && value.aborted))
			return { $back: back };
		if (typeof value === 'function') return exportFn(value, undefined);
		if (
			ArrayBuffer.isView(value) ||
			value instanceof ArrayBuffer ||
			value instanceof Date ||
			value instanceof RegExp
		)
			return value;
		if (Array.isArray(value)) return value.map(encode);
		if (value instanceof Map) {
			const entries: ReadonlyMap<unknown, unknown> = value;
			return new Map(Array.from(entries, ([key, item]) => [encode(key), encode(item)]));
		}
		if (value instanceof Set) {
			const entries: ReadonlySet<unknown> = value;
			return new Set(Array.from(entries, encode));
		}
		if (value instanceof AbortSignal) return exportSignal(value);
		if (value instanceof ReadableStream) return exportStream(value);
		if (value instanceof Request)
			return {
				$request: {
					method: value.method,
					url: value.url,
					headers: [...value.headers],
					body: body(value),
					signal: exportSignal(value.signal)
				}
			};
		if (value instanceof Response)
			return {
				$response: {
					status: value.status,
					statusText: value.statusText,
					headers: [...value.headers],
					body: body(value)
				}
			};
		if (value instanceof Error) {
			const own: Record<string, unknown> = {};
			for (const key of Object.keys(value)) own[key] = encode(Reflect.get(value, key));
			return { $error: { ...own, name: value.name, message: value.message } };
		}
		const data = fields(value, {});
		if (
			Object.values(data).some(
				(field) => isObject(field) && (Object.hasOwn(field, '$fn') || Object.hasOwn(field, '$back'))
			)
		) {
			const id = ++ids;
			exported.set(id, { kind: 'object', value });
			return { $handle: id, fields: data };
		}
		return MARKERS.some((key) => Object.hasOwn(data, key)) ? { $obj: data } : data;
	};

	const mirrorFn = (id: number) => {
		const mirror = (...args: readonly unknown[]): unknown => {
			if (closed !== undefined) return Promise.reject(closed.failure);
			const call = ++calls;
			const answer = decodeAnswer(send(['call', id, args.map(encode), call]));
			if (answer === undefined) {
				const later = new Promise((resolve, reject) => pending.set(call, { resolve, reject }));
				// a call nobody awaits (a fire-and-forget callback) must not take its process down when the side closes
				later.catch(ignore);
				return later;
			}
			if (answer[0] === 'ok') return decode(answer[1]);
			throw decode(answer[1]);
		};
		origin.set(mirror, id);
		released.register(mirror, id);
		return mirror;
	};
	const mirrorSignal = (value: unknown): AbortSignal => {
		const { $signal: id, aborted, reason } = decodeSignal(value);
		if (aborted === true) return AbortSignal.abort(decode(reason));
		const controller = new AbortController();
		kept.set(controller.signal, controller);
		origin.set(controller.signal, id);
		signals.set(id, new WeakRef(controller));
		released.register(controller.signal, id);
		return controller.signal;
	};
	const mirrorStream = (id: number): ReadableStream<Uint8Array> => {
		const state: Incoming = { controller: undefined, pulled: undefined };
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					state.controller = controller;
				},
				pull: () =>
					new Promise<void>((resolve) => {
						state.pulled = resolve;
						reading.set(id, state);
						send(['pull', id]);
					}),
				cancel: () => {
					reading.delete(id);
					released.unregister(state);
					if (streams.delete(id)) send(['release', [id]]);
				}
			},
			{ highWaterMark: 0 }
		);
		streams.set(id, new WeakRef(state));
		released.register(stream, id, state);
		return stream;
	};
	const mirrorBody = (wire: typeof Body.Type) =>
		wire === null
			? null
			: wire instanceof Uint8Array
				? wire.buffer instanceof ArrayBuffer
					? new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength)
					: new Uint8Array(wire)
				: mirrorStream(wire.$stream);
	const literal = (value: object) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) out[key] = decode(Reflect.get(value, key));
		return out;
	};
	const decode = (value: unknown): unknown => {
		if (!isObject(value)) return value;
		if (
			ArrayBuffer.isView(value) ||
			value instanceof ArrayBuffer ||
			value instanceof Date ||
			value instanceof RegExp
		)
			return value;
		if (Array.isArray(value)) return value.map(decode);
		if (value instanceof Map) {
			const entries: ReadonlyMap<unknown, unknown> = value;
			return new Map(Array.from(entries, ([key, item]) => [decode(key), decode(item)]));
		}
		if (value instanceof Set) {
			const entries: ReadonlySet<unknown> = value;
			return new Set(Array.from(entries, decode));
		}
		const data: unknown = Reflect.get(value, '$obj');
		if (Object.hasOwn(value, '$obj')) return isObject(data) ? literal(data) : {};
		if (Object.hasOwn(value, '$fn')) return mirrorFn(decodeFn(value).$fn);
		if (Object.hasOwn(value, '$back')) {
			const own = exported.get(decodeBack(value).$back);
			return own?.kind === 'fn'
				? own.self === undefined
					? own.fn
					: own.fn.bind(own.self)
				: own?.kind === 'object'
					? own.value
					: own?.kind === 'signal'
						? own.signal
						: undefined;
		}
		if (Object.hasOwn(value, '$handle')) {
			const { $handle: id, fields: wire } = decodeHandle(value);
			const handle = literal(wire);
			origin.set(handle, id);
			released.register(handle, id);
			return handle;
		}
		if (Object.hasOwn(value, '$signal')) return mirrorSignal(value);
		if (Object.hasOwn(value, '$stream')) return mirrorStream(decodeStream(value).$stream);
		if (Object.hasOwn(value, '$request')) {
			const wire = decodeRequest(value).$request;
			const signal = mirrorSignal(wire.signal),
				bytes = mirrorBody(wire.body);
			const init: RequestInit = { method: wire.method, headers: headersOf(wire.headers), signal };
			// a streamed request body is half duplex (Node's `fetch` requires saying so)
			if (bytes !== null) Object.assign(init, { body: bytes, duplex: 'half' });
			const request = new Request(wire.url, init);
			kept.set(request, signal);
			return request;
		}
		if (Object.hasOwn(value, '$response')) {
			const wire = decodeResponse(value).$response;
			return new Response(mirrorBody(wire.body), {
				status: wire.status,
				statusText: wire.statusText,
				headers: headersOf(wire.headers)
			});
		}
		if (Object.hasOwn(value, '$error')) {
			const { name, message, ...own } = decodeError(value).$error;
			const error = new Error(typeof message === 'string' ? message : '');
			if (typeof name === 'string') error.name = name;
			for (const [key, field] of Object.entries(own)) Reflect.set(error, key, decode(field));
			return error;
		}
		return literal(value);
	};

	const call = (id: number, args: readonly unknown[], callId: number): Answer => {
		const target = exported.get(id);
		if (target?.kind !== 'fn')
			return ['fail', encode(new Error('the function was released by the other side'))];
		let result: unknown;
		try {
			result = Reflect.apply(target.fn, target.self, args.map(decode));
		} catch (error) {
			return ['fail', encode(error)];
		}
		if (!isThenable(result)) return ['ok', encode(result)];
		Promise.resolve(result)
			.then(
				(value) => send(['resolve', callId, encode(value)]),
				(error: unknown) => send(['reject', callId, encode(error)])
			)
			.catch((error: unknown) => send(['reject', callId, encode(error)]));
		return undefined;
	};
	const settle = (callId: number, value: unknown, ok: boolean) => {
		const waiting = pending.get(callId);
		if (waiting === undefined) return;
		pending.delete(callId);
		try {
			if (ok) waiting.resolve(decode(value));
			else waiting.reject(decode(value));
		} catch (error) {
			waiting.reject(error);
		}
	};
	const pull = (id: number) => {
		const out = exported.get(id);
		if (out?.kind !== 'stream') return;
		const reader = (out.reader ??= out.stream.getReader());
		reader.read().then(
			(chunk) => {
				if (!chunk.done) send(['write', id, chunkBytes(chunk.value)]);
				else if (exported.delete(id)) send(['end', id]);
			},
			(error: unknown) => {
				if (exported.delete(id)) send(['error', id, encode(error)]);
			}
		);
	};
	/** The stream's next chunk, its end, or its failure; the read waiting on it continues. */
	const incoming = (
		id: number,
		apply: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
		last: boolean
	) => {
		const state = streams.get(id)?.deref();
		reading.delete(id);
		if (state === undefined) return;
		if (last) {
			streams.delete(id);
			released.unregister(state);
		}
		if (state.controller !== undefined) apply(state.controller);
		state.pulled?.();
		state.pulled = undefined;
	};
	const release = (id: number) => {
		const out = exported.get(id);
		exported.delete(id);
		if (out?.kind === 'signal') out.stop();
		if (out?.kind === 'stream') (out.reader ?? out.stream).cancel().catch(ignore);
	};

	return {
		encode,
		decode,
		receive: (input) => {
			const message = decodeMessage(input);
			switch (message[0]) {
				case 'call':
					return call(message[1], message[2], message[3]);
				case 'resolve':
				case 'reject':
					settle(message[1], message[2], message[0] === 'resolve');
					return undefined;
				case 'abort': {
					const controller = signals.get(message[1])?.deref();
					signals.delete(message[1]);
					controller?.abort(decode(message[2]));
					return undefined;
				}
				case 'error':
					incoming(message[1], (controller) => controller.error(decode(message[2])), true);
					return undefined;
				case 'write':
					incoming(message[1], (controller) => controller.enqueue(message[2]), false);
					return undefined;
				case 'end':
					incoming(message[1], (controller) => controller.close(), true);
					return undefined;
				case 'pull':
					pull(message[1]);
					return undefined;
				case 'release':
					for (const id of message[1]) release(id);
					return undefined;
			}
		},
		close: (failure) => {
			if (closed !== undefined) return;
			closed = { failure };
			for (const waiting of pending.values()) waiting.reject(failure);
			pending.clear();
			for (const state of streams.values()) state.deref()?.controller?.error(failure);
			streams.clear();
			reading.clear();
			for (const id of [...exported.keys()]) release(id);
		}
	};
};
