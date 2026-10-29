/// <reference types="node" />
// `nodeGuests`: a guest runner (`HostPorts.guests`, `GuestIsolatesPort`) as `node:vm` contexts in this process. Each call is one
// synchronous run under `timeout` of what is left of the session's CPU budget, its microtasks drained inside it; the
// thread's CPU around it is the session's. A multi-tenant kernel brings its own isolates (Colony: isolated-vm).
// ponytail: a vm context shares this process's heap and is no security boundary: no per-guest memory cap (`memoryMiB` is
// not enforced, `memory` never fails) and the guest runs operator-trusted code only. A host serving untrusted tenants
// supplies native isolates.
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { Predicate } from 'effect';
import {
	LIMITS,
	type GuestIsolatesPort,
	type GuestProgram,
	type GuestSessionOptions,
	type GuestTaken
} from '@norbital-ai/bolt/engine';
import type { HostFailure } from '@norbital-ai/bolt/host-api';
import {
	assetHook,
	digest,
	moduleScript,
	randomStream,
	type GuestHooks,
	type ImportDeclaration
} from '@norbital-ai/bolt/guest-hooks';

type Prelude = {
	readonly start: (...args: readonly unknown[]) => void;
	readonly take: () => GuestTaken;
	readonly give: (...args: readonly unknown[]) => void;
};
// The context's own copy of what crosses in: its arrays and Uint8Arrays, so the guest's `instanceof` holds.
const COPY = new vm.Script(
	'(function copy(v) { return Array.isArray(v) ? v.map(copy) : ArrayBuffer.isView(v) ? new Uint8Array(v) : v; })',
	{ filename: 'bolt:copy' }
);
const TURN = Symbol.for('norbital.bolt.turn');
const RUN = new vm.Script('globalThis[Symbol.for("norbital.bolt.turn")]()', {
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

/** A guest context: `prelude` evaluated as an `evalClosure` body over `hooks`, whose answers cross in copied. */
const guestContext = (prelude: string, hooks: GuestHooks) => {
	const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
	const copy: (value: unknown) => unknown = COPY.runInContext(context);
	const [say, random, digestOf, asset] = hooks;
	const make = compiled(
		prelude,
		'bolt:prelude',
		() => `(function ($0, $1, $2, $3) {\n${prelude}\n})`
	);
	const api: Prelude = make.runInContext(context)(
		say,
		(n: unknown) => copy(random(n)),
		(name: unknown, bytes: unknown) => copy(digestOf(name, structuredClone(bytes))),
		(sha: unknown) => copy(asset(sha))
	);
	return { context, copy, api };
};

/** `work` as one run in `context`: its microtasks drain inside it, and past `timeout` ms it throws. */
const within = <A>(context: vm.Context, timeout: number, work: () => A): A => {
	Reflect.set(context, TURN, work);
	try {
		return RUN.runInContext(context, { timeout: Math.max(1, Math.ceil(timeout)) });
	} finally {
		Reflect.deleteProperty(context, TURN);
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

/** Console lines one turn carries; the rest are counted. */
const LINES = 200;
const failure = (code: 'cpuBudget' | 'interrupted', message: string): HostFailure => ({
	_tag: 'HostFailure',
	code,
	phase: 'guest',
	message
});
const refuseImport = (node: ImportDeclaration): string => {
	throw new Error(`guest.mjs is one module; it imports '${node.source.value}'`);
};

export type NodeGuestsOptions = {
	/** Each session's CPU budget, its module evaluation included (default `LIMITS.guestCpuMs`); past it, `cpuBudget`. */
	readonly cpuMs?: number | undefined;
	/** Every run's CPU, by session. */
	readonly meter?: ((session: string, nanos: bigint) => void) | undefined;
};
type Session = {
	readonly context: vm.Context;
	readonly copy: (value: unknown) => unknown;
	api: Prelude | undefined;
	used: bigint;
	readonly said: { readonly lines: [string, string][]; dropped: number };
};

/** A host's guest sessions: bolt-server's and `bolt dev`'s runner, and the test kit's. */
export const nodeGuests = (options: NodeGuestsOptions = {}): GuestIsolatesPort => {
	const budget = options.cpuMs ?? LIMITS.guestCpuMs,
		limit = BigInt(budget) * 1_000_000n;
	const over = failure('cpuBudget', `the invocation used its ${budget} ms of guest CPU`);
	const sessions = new Map<string, Session>();
	/**
	 * One run of the session; a failed run ends it. The vm watchdog counts wall time, so a run it stops is billed what
	 * was left of the budget, its own CPU when that is more.
	 */
	const run = <A>(id: string, signal: AbortSignal, work: (session: Session) => A): A => {
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
			const answer = within(session.context, Number(left) / 1e6, () => work(session));
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
		work?: (api: Prelude, copy: Session['copy']) => void
	) => {
		const api = (session: Session) => {
			if (session.api === undefined) throw new Error('the guest session did not open');
			return session.api;
		};
		if (work !== undefined) run(id, signal, (session) => work(api(session), session.copy));
		const taken = structuredClone(run(id, signal, (session) => api(session).take()));
		const session = sessions.get(id);
		const lines = session?.said.lines.splice(0) ?? [],
			dropped = session?.said.dropped ?? 0;
		if (session !== undefined) session.said.dropped = 0;
		return { taken, lines, dropped };
	};
	return {
		open: async (program: GuestProgram, session: GuestSessionOptions, signal: AbortSignal) => {
			const id = randomUUID(),
				said: Session['said'] = { lines: [], dropped: 0 };
			const { context, copy, api } = guestContext(session.prelude, [
				(level, line) => {
					if (said.lines.length < LINES) said.lines.push([String(level), String(line)]);
					else said.dropped++;
				},
				randomStream(session.seed),
				digest,
				assetHook(program.assets)
			]);
			const module = compiled(program.source, 'guest.mjs', () =>
				moduleScript(program.source, refuseImport)
			);
			sessions.set(id, { context, copy, api: undefined, used: 0n, said });
			run(id, signal, (opened) => {
				Reflect.set(context, '__boltGuest', module.runInContext(context));
				opened.api = api;
			});
			return id;
		},
		start: (id, start, signal) =>
			turn(id, signal, (api, copy) =>
				api.start(start.kind, copy([...start.path]), start.input, start.ctx, start.invocation)
			),
		take: (id, signal) => turn(id, signal),
		give: (id, answers, signal) =>
			turn(id, signal, (api, copy) =>
				api.give(
					copy([...answers.ids]),
					copy([...answers.texts]),
					copy(answers.bins.map((b) => [...b]))
				)
			),
		close: async (id) => {
			sessions.delete(id);
		}
	};
};
