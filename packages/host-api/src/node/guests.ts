/// <reference types="node" />
// `node_guests`: a guest runner (`HostPorts.guests`, `GuestIsolatesPort`) as `node:vm` contexts in this process. Each call is one
// synchronous run under `timeout` of what is left of the session's CPU budget, its microtasks drained inside it; the
// thread's CPU around it is the session's. A multi-tenant kernel brings its own isolates (Colony: isolated-vm).
// ponytail: a vm context shares this process's heap and is no security boundary: no per-guest memory cap (`memory_mib` is
// not enforced, `memory` never fails) and the guest runs operator-trusted code only. A host serving untrusted tenants
// supplies native isolates.
import { randomUUIDv7 } from 'node:crypto';
import { types } from 'node:util';
import vm from 'node:vm';
import { Predicate, Schema } from 'effect';
import {
	type GuestProgram,
	GuestTaken,
	HOST_LIMITS,
	type HostFailure,
	type HostPorts
} from '../index.ts';
import {
	asset_hook,
	console_hook,
	digest_hook,
	GUEST_CRYPTO,
	module_script,
	random_stream,
	type GuestHooks,
	type GuestSaid,
	type ImportDeclaration
} from './guest-hooks.ts';

type GuestIsolatesPort = HostPorts['guests'];
type GuestSessionOptions = Parameters<GuestIsolatesPort['open']>[1];
type HostCallOutcome = readonly [ok: true, value: unknown] | readonly [ok: false, message: string];

type Prelude = {
	readonly start: (...args: readonly unknown[]) => unknown;
	readonly take: () => unknown;
	readonly give: (...args: readonly unknown[]) => unknown;
};

const fnSchema = <F>() => Schema.declare((value: unknown): value is F => typeof value === 'function');
const BootstrapSchema = Schema.Struct({
	copy: fnSchema<(value: unknown) => unknown>(),
	wrapBridge:
		fnSchema<
			(
				hostCall: (...args: readonly unknown[]) => HostCallOutcome
			) => (...args: readonly unknown[]) => unknown
		>(),
	arm: fnSchema<(target: (...args: readonly unknown[]) => unknown, args: readonly unknown[]) => void>(),
	disarm: fnSchema<() => void>(),
	takeResult: fnSchema<() => Readonly<{ ok: boolean; value: unknown }>>()
});
type GuestBootstrap = typeof BootstrapSchema.Type;
const decodeBootstrap = Schema.decodeUnknownSync(BootstrapSchema);
const callback = fnSchema<(...args: readonly unknown[]) => unknown>();
const decodeCallback = Schema.decodeUnknownSync(callback);
const decodePrelude = Schema.decodeUnknownSync(
	Schema.Struct({ start: callback, take: callback, give: callback })
);

/**
 * Guest-realm membrane bootstrap evaluated before any prelude or guest code runs:
 * - Captures pristine guest intrinsics so prototype tampering cannot corrupt copies or errors.
 * - Wraps every host bridge inside a guest-realm closure whose `.constructor` is the guest `Function`,
 *   deep-copying return values into guest-realm objects/typed arrays and rethrowing host failures as
 *   fresh guest-realm `Error` instances (never leaking host `Function`, `Object`, `Promise`, or `Error`).
 * - Installs a non-configurable, guest-realm turn trampoline on `globalThis` so `within` never places
 *   a host closure on `globalThis`.
 */
const BOOTSTRAP = new vm.Script(
	`(function () {
	'use strict';
	const _Error = Error;
	const _TypeError = TypeError;
	const _Array = Array;
	const _Uint8Array = Uint8Array;
	const _isArray = Array.isArray;
	const _isView = ArrayBuffer.isView;
	const _set = Uint8Array.prototype.set;
	const _apply = Reflect.apply;
	const _defineProperty = Object.defineProperty;
	const _create = Object.create;
	const _keys = Object.keys;
	const _symbolFor = Symbol.for;

	function copy(v) {
		if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
		if (_isArray(v)) {
			const len = v.length;
			const out = new _Array(len);
			for (let i = 0; i < len; i++) out[i] = copy(v[i]);
			return out;
		}
		if (_isView(v)) {
			const out = new _Uint8Array(v.byteLength);
			_apply(_set, out, [new _Uint8Array(v.buffer, v.byteOffset, v.byteLength)]);
			return out;
		}
		if (typeof v === 'function') return undefined;
		const out = {};
		const keys = _keys(v);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			_defineProperty(out, k, {
				value: copy(v[k]),
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
		return out;
	}

	function wrapBridge(hostCall) {
		return function () {
			const outcome = _apply(hostCall, undefined, arguments);
			if (!outcome[0]) throw new _Error(outcome[1]);
			const value = outcome[1];
			if (
				value !== null &&
				(typeof value === 'object' || typeof value === 'function') &&
				typeof value.then === 'function'
			) {
				throw new _TypeError('host bridge cannot return a Promise across the membrane');
			}
			return copy(value);
		};
	}

	let pendingFn = null;
	let pendingArgs = null;
	let pendingResult = undefined;
	let hasPendingResult = false;
	function runTurn() {
		const fn = pendingFn;
		const args = pendingArgs;
		pendingFn = null;
		pendingArgs = null;
		if (fn === null) return;
		pendingResult = _apply(fn, undefined, args);
		hasPendingResult = true;
	}
	_defineProperty(globalThis, _symbolFor('norbital.bolt.turn'), {
		value: runTurn,
		writable: false,
		enumerable: false,
		configurable: false
	});

	return {
		copy,
		wrapBridge,
		arm(fn, args) {
			pendingFn = fn;
			pendingArgs = args;
			pendingResult = undefined;
			hasPendingResult = false;
		},
		disarm() {
			pendingFn = null;
			pendingArgs = null;
		},
		takeResult() {
			const result = _create(null);
			result.ok = hasPendingResult;
			result.value = pendingResult;
			pendingResult = undefined;
			hasPendingResult = false;
			return result;
		}
	};
})()`,
	{ filename: 'bolt:bootstrap' }
);
const RUN = new vm.Script("globalThis[Symbol.for('norbital.bolt.turn')]()", {
	filename: 'bolt:turn'
});
/** One compiled script per text (programs and preludes), reused across contexts. */
const scripts = new Map<string, vm.Script>();
const compiled = (key: string, filename: string, code: () => string) => {
	let script = scripts.get(key);
	if (script === undefined) {
		script = new vm.Script(code(), { filename, lineOffset: -1 });
		scripts.set(key, script);
		// ponytail: the last 16 texts stay compiled; an LRU when hosts serve more programs at once
		if (scripts.size > 16) scripts.delete(scripts.keys().next().value ?? key);
	}
	return script;
};

/** Executes a host callback and converts any thrown host Error into a primitive message so no host Error crosses into the guest. */
const safeHostCall =
	(fn: (...args: readonly unknown[]) => unknown) =>
	(...args: readonly unknown[]): HostCallOutcome => {
		try {
			return [true, fn(...args)];
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: Predicate.hasProperty(error, 'message')
						? String(error.message)
						: String(error);
			return [false, message];
		}
	};

/** A guest context: `prelude` evaluated as an `evalClosure` body over realm-isolated `hooks`, whose answers cross in copied. */
const guestContext = (prelude: string, hooks: GuestHooks) => {
	const context = vm.createContext(Object.create(null), { microtaskMode: 'afterEvaluate' });
	const bootstrap = decodeBootstrap(BOOTSTRAP.runInContext(context));
	const [say, random, digestOf, asset] = hooks;
	const make = compiled(
		prelude,
		'bolt:prelude',
		() => `(function ($0, $1, $2, $3) {\n${prelude}\n})`
	);
	const factory = decodeCallback(make.runInContext(context));
	const api: Prelude = decodePrelude(
		factory(
			bootstrap.wrapBridge(safeHostCall((level: unknown, line: unknown) => say(level, line))),
			bootstrap.wrapBridge(safeHostCall((n: unknown) => random(n))),
			bootstrap.wrapBridge(
				safeHostCall((name: unknown, bytes: unknown) => {
					if (typeof name !== 'string' || !types.isUint8Array(bytes))
						throw new Error('digest supports SHA-1, SHA-256, SHA-384, SHA-512');
					if (bytes.byteLength > GUEST_CRYPTO.maxDigestBytes)
						throw new Error(`digest takes at most ${GUEST_CRYPTO.maxDigestBytes} bytes per call`);
					const hostBytes = new Uint8Array(bytes.byteLength);
					hostBytes.set(bytes);
					return digestOf(name, hostBytes);
				})
			),
			bootstrap.wrapBridge(safeHostCall((sha: unknown) => asset(sha)))
		)
	);
	return { context, bootstrap, api };
};

/** Invokes a guest-realm callback as one run in `context`: its microtasks drain inside it, and past `timeout` ms it throws. */
const withinCall = (
	context: vm.Context,
	bootstrap: GuestBootstrap,
	timeout: number,
	target: (...args: readonly unknown[]) => unknown,
	args: readonly unknown[]
): unknown => {
	bootstrap.arm(target, args);
	try {
		RUN.runInContext(context, { timeout: Math.max(1, Math.ceil(timeout)) });
		const { ok, value } = bootstrap.takeResult();
		if (!ok) throw new Error('the guest slice did not complete');
		return value;
	} finally {
		bootstrap.disarm();
	}
};
const timedOut = (error: unknown) =>
	Predicate.hasProperty(error, 'code') && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
/** A context's throw as a host Error (its own `Error` is another realm's). */
const hostError = (error: unknown) =>
	error instanceof Error
		? error
		: new Error(Predicate.hasProperty(error, 'message') ? String(error.message) : String(error));
/** This thread's CPU since `from`, in nanoseconds. */
const cpuSince = (from: NodeJS.CpuUsage) => {
	const used = process.threadCpuUsage(from);
	return BigInt(used.user + used.system) * 1000n;
};

const failure = (code: 'cpu_budget' | 'interrupted', message: string): HostFailure => ({
	_tag: 'HostFailure',
	code,
	phase: 'guest',
	message
});
const refuseImport = (node: ImportDeclaration): string => {
	throw new Error(`guest.mjs is one module; it imports '${node.source.value}'`);
};

/** `node_guests`'s options: each session's CPU budget, a CPU meter and a crossing meter. */
export type NodeGuestsOptions = {
	/** Each session's CPU budget, its module evaluation included (default `HOST_LIMITS.guestCpuMs`); past it, `cpu_budget`. */
	readonly cpu_ms?: number | undefined;
	/** Every run's CPU, by session. */
	readonly meter?: ((session: string, nanos: bigint) => void) | undefined;
	/** Every wave of `ctx` calls a session sends the host (one round trip), by session: how many calls it carries. */
	readonly crossed?: ((session: string, calls: number) => void) | undefined;
};
type Session = {
	readonly context: vm.Context;
	readonly bootstrap: GuestBootstrap;
	api: Prelude | undefined;
	used: bigint;
	readonly said: GuestSaid;
};

/**
 * A host's guest sessions as `node:vm` contexts in this process: bolt-server's and `bolt dev`'s runner, and the test
 * kit's. Each call runs under a timeout of what is left of the session's CPU budget. A vm context shares the host's heap
 * and is no security boundary: it caps no guest memory and runs operator-trusted code only; a multi-tenant host brings
 * native isolates.
 */
export const node_guests = (options: NodeGuestsOptions = {}): GuestIsolatesPort => {
	const budget = options.cpu_ms ?? HOST_LIMITS.guestCpuMs,
		limit = BigInt(budget) * 1_000_000n;
	const over = failure('cpu_budget', `the invocation used its ${budget} ms of guest CPU`);
	const sessions = new Map<string, Session>();
	/**
	 * One run of the session; a failed run ends it. The vm watchdog counts wall time, so a run it stops is billed what
	 * was left of the budget, its own CPU when that is more.
	 */
	const run = <A>(id: string, signal: AbortSignal, work: (session: Session, timeoutMs: number) => A): A => {
		const session = sessions.get(id);
		if (session === undefined) throw new Error('the guest session is closed');
		const left = limit - session.used,
			from = process.threadCpuUsage();
		const bill = (nanos: bigint) => {
			session.used += nanos;
			options.meter?.(id, nanos);
		};
		try {
			if (signal.aborted) throw failure('interrupted', 'the guest call was aborted');
			const answer = work(session, Number(left) / 1e6);
			bill(cpuSince(from));
			if (session.used >= limit) throw over;
			return answer;
		} catch (error) {
			sessions.delete(id);
			if (error === over) throw over;
			const used = cpuSince(from);
			bill(timedOut(error) && used < left ? left : used);
			throw timedOut(error)
				? over
				: Predicate.isTagged(error, 'HostFailure')
					? error
					: hostError(error);
		}
	};
	/** A turn: its runs, then `take()` and what `$0` said since the last turn. */
	const turn = async (
		id: string,
		signal: AbortSignal,
		invocation?: (
			api: Prelude,
			copy: GuestBootstrap['copy']
		) => readonly [target: (...args: readonly unknown[]) => unknown, args: readonly unknown[]]
	) => {
		const api = (session: Session) => {
			if (session.api === undefined) throw new Error('the guest session did not open');
			return session.api;
		};
		if (invocation !== undefined)
			run(id, signal, (session, timeoutMs) => {
				const [target, args] = invocation(api(session), session.bootstrap.copy);
				return withinCall(session.context, session.bootstrap, timeoutMs, target, args);
			});
		try {
			const taken = await Schema.decodeUnknownPromise(GuestTaken)(
				structuredClone(
					run(id, signal, (session, timeoutMs) =>
						withinCall(session.context, session.bootstrap, timeoutMs, api(session).take, [])
					)
				)
			);
			if (taken[1].length > 0) options.crossed?.(id, taken[1].length);
			const session = sessions.get(id);
			const lines = session?.said.lines.splice(0) ?? [],
				dropped = session?.said.dropped ?? 0;
			if (session !== undefined) {
				session.said.dropped = 0;
				session.said.chars = 0;
			}
			return { taken, lines, dropped };
		} catch (error) {
			// A malformed guest answer ends its session just as a failed native slice does.
			sessions.delete(id);
			throw error;
		}
	};
	return {
		open: async (program: GuestProgram, session: GuestSessionOptions, signal: AbortSignal) => {
			const id = randomUUIDv7(),
				said: GuestSaid = { lines: [], chars: 0, dropped: 0 };
			const { context, bootstrap, api } = guestContext(session.prelude, [
				console_hook(said),
				random_stream(session.seed),
				digest_hook(),
				asset_hook(program.assets)
			]);
			const module = compiled(program.source, 'guest.mjs', () =>
				module_script(program.source, refuseImport)
			);
			sessions.set(id, { context, bootstrap, api: undefined, used: 0n, said });
			run(id, signal, (opened, timeoutMs) => {
				const exported = module.runInContext(opened.context, {
					timeout: Math.max(1, Math.ceil(timeoutMs))
				});
				Reflect.set(opened.context, '__boltGuest', exported);
				opened.api = api;
			});
			return id;
		},
		start: (id, start, signal) =>
			turn(id, signal, (api, copy) => [
				api.start,
				[start.kind, copy([...start.path]), start.input, start.ctx, start.invocation]
			]),
		take: (id, signal) => turn(id, signal),
		give: (id, answers, signal) =>
			turn(id, signal, (api, copy) => [
				api.give,
				[
					copy([...answers.ids]),
					copy([...answers.texts]),
					copy(answers.bins.map((b) => [...b]))
				]
			]),
		close: async (id) => {
			sessions.delete(id);
		}
	};
};
