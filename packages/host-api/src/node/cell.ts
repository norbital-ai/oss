/// <reference types="node" />
// A release's cell on the kernel's side: HOST_API as a cell's `open` answers it (`cell_api`, every kernel's), and the
// cell bundle (`build/cell.js`) evaluated in a `node:vm` context of this process (`vm_cell`, bolt-server's). A vm
// context is no security boundary and meters nothing: it serves operator-trusted releases only; a multi-tenant kernel
// evaluates the bundle in isolates it limits and meters (Colony: isolated-vm).
import vm from 'node:vm';
import { Schema } from 'effect';
import {
	Answer,
	CELL_ABI_VERSION,
	type HostApi,
	type Kernel,
	membrane,
	type Message
} from '../index.ts';

const fn = <F>() => Schema.declare((u: unknown): u is F => typeof u === 'function');
/** HOST_API as `open` answers it; the answers of its functions are the cell's own (never trusted further). */
const CellApi = Schema.Struct({
	guest_execution: Schema.Literal('source'),
	version: Schema.Number,
	contract: Schema.String,
	cookies: Schema.Struct({ session: Schema.String, preview: Schema.String }),
	cookie_site: Schema.Tuple([Schema.String, Schema.String]),
	needs_guest: fn<HostApi['needs_guest']>(),
	verify: fn<HostApi['verify']>(),
	describe: fn<HostApi['describe']>(),
	frame_policy: fn<HostApi['frame_policy']>(),
	schema: Schema.Struct({
		slice: fn<HostApi['schema']['slice']>(),
		destructive: fn<HostApi['schema']['destructive']>(),
		carry: fn<HostApi['schema']['carry']>()
	}),
	activate: fn<HostApi['activate']>(),
	branch: fn<HostApi['branch']>(),
	links: fn<HostApi['links']>()
});
const decodeApi = Schema.decodeUnknownSync(CellApi);
/** A cell's `api`, decoded by the kernel's side of the membrane, as the `HostApi` it marshals. */
export const cell_api = (decoded: unknown): HostApi => {
	const { cookie_site, ...api } = decodeApi(decoded);
	return { ...api, cookie_site: (secure) => cookie_site[secure ? 1 : 0] };
};

// The context's own copy of what crosses in, so the cell's `instanceof` holds; what crosses out is `structuredClone`d.
const COPY = new vm.Script(
	`(function copy(v) {
	if (typeof v !== 'object' || v === null) return v;
	if (Array.isArray(v)) return v.map(copy);
	const tag = Object.prototype.toString.call(v).slice(8, -1);
	if (ArrayBuffer.isView(v)) return new (globalThis[tag] ?? Uint8Array)(v);
	if (tag === 'ArrayBuffer') return new Uint8Array(new Uint8Array(v)).buffer;
	if (tag === 'Date') return new Date(v.getTime());
	if (tag === 'RegExp') return new RegExp(v.source, v.flags);
	if (tag === 'Map') return new Map(Array.from(v, ([key, item]) => [copy(key), copy(item)]));
	if (tag === 'Set') return new Set(Array.from(v, copy));
	const out = {};
	for (const key of Object.keys(v)) out[key] = copy(v[key]);
	return out;
})`,
	{ filename: 'bolt:copy' }
);
const callback = fn<(...args: readonly unknown[]) => unknown>();
const decodeCallback = Schema.decodeUnknownSync(callback),
	decodeAnswer = Schema.decodeUnknownSync(Answer);
const BoltCell = Schema.Struct({
	abi: Schema.Unknown,
	open: fn<(kernel: Kernel) => unknown>()
});
const End = Schema.Struct({ api: Schema.Unknown, receive: callback, fire: callback });
const MAX_DELAY = 2 ** 31 - 1;

/** A cell this process runs: its HOST_API, and `close` (pending calls reject, timers stop). */
export type VmCell = { readonly api: HostApi; close(): void };

/** `source` (a release's `build/cell.js`) opened in a fresh `node:vm` context; `log` takes its console lines. */
export const vm_cell = (source: string, log: (error: boolean, line: string) => void): VmCell => {
	const context = vm.createContext({});
	const copy = decodeCallback(COPY.runInContext(context));
	new vm.Script(source, { filename: 'bolt:cell' }).runInContext(context);
	const cell = Schema.decodeUnknownSync(BoltCell)(vm.runInContext('globalThis.__bolt_cell', context));
	if (cell.abi !== CELL_ABI_VERSION)
		throw new Error(`The cell speaks ABI ${String(cell.abi)}; this kernel speaks ${CELL_ABI_VERSION}.`);
	const timers = new Map<number, NodeJS.Timeout>();
	let end: typeof End.Type | undefined;
	const side = membrane((message: Message) => {
		if (end === undefined) throw new Error('The cell is not open.');
		return structuredClone(end.receive(copy(message)));
	});
	const kernel: Kernel = {
		// the answer's array may be this realm's (the cell decodes it again); what it carries must be the cell's
		send: (message) => decodeAnswer(copy(side.receive(structuredClone(message)))),
		timer: (id, ms) => {
			clearTimeout(timers.get(id));
			timers.set(
				id,
				setTimeout(() => {
					timers.delete(id);
					end?.fire(id);
				}, Math.min(Math.max(ms, 0), MAX_DELAY))
			);
		},
		clear: (id) => {
			clearTimeout(timers.get(id));
			timers.delete(id);
		},
		random: (bytes) => crypto.getRandomValues(new Uint8Array(Math.min(Math.max(bytes, 0), 65536))),
		log: (level, line) => log(level === 'error' || level === 'warn', line)
	};
	const opened = Schema.decodeUnknownSync(End)(cell.open(kernel));
	end = opened;
	return {
		api: cell_api(side.decode(structuredClone(opened.api))),
		close: () => {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			end = undefined;
			side.close(new Error('The cell was closed.'));
		}
	};
};
