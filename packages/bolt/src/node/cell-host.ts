/// <reference types="node" />
// The kernel side of a cell (compute model §14): `build/cell.js` evaluated in its own isolate, its HOST_API reached
// through the membrane. Every execution in the cell is an entry this host starts, one at a time per cell, under a CPU
// slot and an ivm timeout of what is left of its unit's budget; the isolate's `cpuTime` is read after each entry and
// all of it since the last read is metered to that entry's unit. A unit is named by `run`; a system call, a timer or
// a stream's chunk the cell starts inherits the unit of the entry that made it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import ivm from 'isolated-vm';
import { Array as EffectArray, Schema } from 'effect';
import type { HostApi, HostApiFailure } from '../protocol/host-api.ts';
import type { CellEnd, Kernel } from '../protocol/cell.ts';
import { Answer, CELL_ABI_VERSION, membrane, type Message } from '../protocol/membrane.ts';

export type CellOptions = {
	/** The cell's heap limit (128). */
	readonly memoryMiB: number;
	/** A CPU slot for one entry; the answer releases it. */
	readonly slot: (unit: string) => Promise<() => void>;
	/** Every entry's CPU, in nanoseconds of the isolate's `cpuTime`. */
	readonly meter: (unit: string, cpuNanos: bigint) => void;
	/** What is left of the unit's CPU budget: the entry's ivm timeout. */
	readonly entryTimeoutMs: (unit: string) => number;
};
export type Cell = {
	/** The cell's HOST_API, every method marshalled. */
	readonly api: HostApi;
	/** Names the unit of every entry `work` starts. */
	run<A>(unit: string, work: () => Promise<A>): Promise<A>;
	/** The isolate's heap and external memory, as of its last entry. */
	heapBytes(): number;
	/** The isolate's own CPU counter: the host reads it; nothing inside the cell can. */
	cpuNanos(): bigint;
	/** From a system call the cell made: the rest of its entry, and what it starts, runs as `unit` (a loop's next step). */
	step(unit: string): void;
	/**
	 * Settles once the cell must take no new work: it died (its memory, a dispose), or a unit overran mid-entry, which
	 * ends only that entry; the cell's other work in flight finishes on it.
	 */
	readonly retired: Promise<HostApiFailure>;
	dispose(): void;
};

/** The unit of the bundle's evaluation and `open`. */
const BOOT = 'boot';
/** One unit of work, shared by everything its async chain starts: a step re-points all of it at once. */
type Unit = { id: string };
const units = new AsyncLocalStorage<Unit>();
/** The unit of the entry whose system call the host is serving now (a guest port's slot and meter follow it). */
export const currentUnit = (): string | undefined => units.getStore()?.id;
const failure = (code: string, message: string): HostApiFailure => ({
	_tag: 'HostFailure',
	code,
	phase: 'admission',
	message
});
const fn = <F>() => Schema.declare((u: unknown): u is F => typeof u === 'function');
/** HOST_API as `open` answers it; the answers of its functions are the cell's own (tenant-billed, never trusted further). */
const CellApi = Schema.Struct({
	guestExecution: Schema.Literal('source'),
	version: Schema.Number,
	contract: Schema.String,
	cookies: Schema.Struct({ session: Schema.String, preview: Schema.String }),
	cookieSite: Schema.Tuple([Schema.String, Schema.String]),
	needsGuest: fn<HostApi['needsGuest']>(),
	verify: fn<HostApi['verify']>(),
	framePolicy: fn<HostApi['framePolicy']>(),
	authority: fn<HostApi['authority']>(),
	schema: Schema.Struct({
		slice: fn<HostApi['schema']['slice']>(),
		destructive: fn<HostApi['schema']['destructive']>()
	}),
	activate: fn<HostApi['activate']>(),
	branch: fn<HostApi['branch']>(),
	links: fn<HostApi['links']>()
});
const decodeApi = Schema.decodeUnknownSync(CellApi),
	decodeAnswer = Schema.decodeUnknownSync(Answer);
type KernelCallbacks = { readonly [K in keyof Kernel]: ivm.Callback<Kernel[K]> };
type BoltCell = {
	readonly abi: unknown;
	readonly open: (kernel: KernelCallbacks) => CellEnd;
};
const LOG_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);
/** Node's own timer ceiling. */
const MAX_DELAY = 2 ** 31 - 1;

export const bootCell = async (source: string, options: CellOptions): Promise<Cell> => {
	const isolate = new ivm.Isolate({ memoryLimit: options.memoryMiB });
	let billed = 0n,
		current: Unit | undefined,
		checkpoint = 0,
		last: Unit = { id: BOOT },
		heap = 0,
		heapAt = 0,
		death: HostApiFailure | undefined;
	const timers = new Map<number, () => void>();
	let tail: Promise<unknown> = Promise.resolve();
	/** The cell's answers and chunks of the running entry, with the unit they belong to. */
	const answers: Array<readonly [Unit, unknown]> = [];
	const { promise: retired, resolve: retire } = Promise.withResolvers<HostApiFailure>();
	/** The kernel's calls into the cell still waiting for an answer, by call id: an overrun answers its unit's. */
	const asked = new Map<number, Unit>();
	const answeredCall = (message: unknown) => {
		if (EffectArray.isArray(message) && (message[0] === 'resolve' || message[0] === 'reject'))
			asked.delete(Number(message[1]));
	};

	const die = (why: HostApiFailure) => {
		if (death !== undefined) return;
		death = why;
		retire(why);
		for (const cancel of timers.values()) cancel();
		timers.clear();
		side.close(why);
		if (!isolate.isDisposed) isolate.dispose();
	};
	/**
	 * A memory death ends the cell. An overrun ends only its entry, but that JavaScript stopped mid-entry, so the cell
	 * is retired: no new work reaches it, and what it holds in flight finishes (or fails) on it.
	 */
	const fatal = (error: unknown, unit: Unit) => {
		if (isolate.isDisposed)
			die(failure('memory', `The workspace engine used its ${options.memoryMiB} MiB of memory.`));
		else if (error instanceof Error && /timed out/i.test(error.message)) {
			const overran = failure(
				'cpuBudget',
				`The workspace engine used the CPU budget of ${unit.id}.`
			);
			retire(overran);
			// the unit's work in the cell stopped mid-entry: what the kernel asked it will never be answered from there
			for (const [call, owner] of asked)
				if (owner === unit) {
					asked.delete(call);
					side.receive(['reject', call, side.encode(overran)]);
				}
			return overran;
		}
		return death ?? error;
	};
	const meter = ({ id: unit }: Unit, began: number) => {
		let now: bigint;
		try {
			now = isolate.cpuTime;
		} catch {
			// a disposed isolate has no counter: its last entry is billed its wall time
			options.meter(unit, BigInt(Math.round((performance.now() - began) * 1e6)));
			return;
		}
		options.meter(unit, now - billed);
		billed = now;
	};
	const entry = async <A>(unit: Unit, work: (timeout: number) => Promise<A>): Promise<A> => {
		if (death !== undefined) throw death;
		const release = await options.slot(unit.id);
		const began = performance.now();
		current = last = unit;
		checkpoint = began;
		try {
			const answer = await work(Math.max(1, Math.floor(options.entryTimeoutMs(unit.id))));
			if (Date.now() - heapAt > 1000) {
				const stats = await isolate.getHeapStatistics();
				heap = stats.used_heap_size + stats.externally_allocated_size;
				heapAt = Date.now();
			}
			return answer;
		} catch (error) {
			throw fatal(error, unit);
		} finally {
			current = undefined;
			meter(unit, checkpoint);
			release();
			// what the cell answered during the entry reaches its caller now, its CPU already read
			for (const [from, message] of answers.splice(0))
				try {
					answeredCall(message);
					units.run(from, () => side.receive(message));
				} catch (error) {
					report(error);
				}
		}
	};
	/** Entries into one cell run one at a time, in the order they were asked for. */
	const enter = <A>(unit: Unit, work: (timeout: number) => Promise<A>): Promise<A> => {
		const next = tail.then(() => entry(unit, work));
		tail = next.catch(() => undefined);
		return next;
	};
	const report = (error: unknown) => {
		if (error !== death) console.error('[bolt cell]', error);
	};

	const context = await isolate.createContext();
	let receive: ivm.Reference<CellEnd['receive']> | undefined,
		fire: ivm.Reference<CellEnd['fire']> | undefined;
	// the kernel's half of the membrane: a message to the cell is an entry, billed to the unit asking for it
	const side = membrane((message: Message) => {
		const unit = units.getStore() ?? current ?? last;
		const answered = enter(unit, (timeout) => {
			if (receive === undefined) return Promise.reject(new Error('The cell is not open.'));
			return receive.apply(undefined, [message], {
				arguments: { copy: true },
				result: { copy: true },
				timeout
			});
		});
		if (message[0] !== 'call') answered.catch(report);
		else {
			const call = message[3];
			asked.set(call, unit);
			answered.then(
				(answer) => {
					const settled = decodeAnswer(answer);
					if (settled === undefined || !asked.delete(call)) return;
					side.receive([settled[0] === 'ok' ? 'resolve' : 'reject', call, settled[1]]);
				},
				(error: unknown) => {
					report(error);
					if (asked.delete(call)) side.receive(['reject', call, side.encode(error)]);
				}
			);
		}
		return undefined;
	});
	const kernel: KernelCallbacks = {
		// the cell is blocked while this runs, inside the entry that sent it: the work it starts keeps that unit
		// a call is served now (its answer may be immediate); an answer or a stream chunk waits for the end of the entry
		send: new ivm.Callback((message: unknown) => {
			const from = current ?? last;
			if (EffectArray.isArray(message) && message[0] !== 'call') answers.push([from, message]);
			else return units.run(from, () => side.receive(message));
		}),
		timer: new ivm.Callback((id: unknown, ms: unknown) => {
			if (typeof id !== 'number' || typeof ms !== 'number' || death !== undefined) return;
			const unit = current ?? last;
			const ring = () => {
				timers.delete(id);
				enter(unit, (timeout) => {
					if (fire === undefined) return Promise.reject(new Error('The cell is not open.'));
					return fire.apply(undefined, [id], { timeout });
				}).catch(report);
			};
			timers.get(id)?.();
			if (ms <= 0) {
				const handle = setImmediate(ring);
				timers.set(id, () => clearImmediate(handle));
			} else {
				const handle = setTimeout(ring, Math.min(ms, MAX_DELAY));
				timers.set(id, () => clearTimeout(handle));
			}
		}),
		clear: new ivm.Callback((id: unknown) => {
			if (typeof id !== 'number') return;
			timers.get(id)?.();
			timers.delete(id);
		}),
		random: new ivm.Callback((bytes: unknown) =>
			crypto.getRandomValues(
				new Uint8Array(
					typeof bytes === 'number' && Number.isInteger(bytes)
						? Math.min(Math.max(bytes, 0), 65536)
						: 0
				)
			)
		),
		log: new ivm.Callback(
			(level: unknown, line: unknown) => {
				const say = typeof level === 'string' && LOG_LEVELS.has(level) ? level : 'log';
				if (say === 'error' || say === 'warn') console.error(String(line));
				else console.log(String(line));
			},
			{ ignored: true }
		)
	};

	try {
		await enter(last, async (timeout) => {
			const script = await isolate.compileScript(source, { filename: 'bolt:cell' });
			await script.run(context, { timeout });
		});
		const cell: ivm.Reference<BoltCell> = await context.global.get('__bolt_cell', {
			reference: true
		});
		const abi = await cell.get('abi', { copy: true });
		if (abi !== CELL_ABI_VERSION)
			throw new Error(
				`The cell speaks ABI ${String(abi)}; this kernel speaks ${CELL_ABI_VERSION}.`
			);
		const open = await cell.get('open', { reference: true });
		const end = await enter(last, (timeout) =>
			open.apply(undefined, [kernel], {
				arguments: { copy: true },
				result: { reference: true },
				timeout
			})
		);
		receive = await end.get('receive', { reference: true });
		fire = await end.get('fire', { reference: true });
		const { cookieSite, ...api } = decodeApi(side.decode(await end.get('api', { copy: true })));
		return {
			api: { ...api, cookieSite: (secure) => cookieSite[secure ? 1 : 0] },
			run: (unit, work) => units.run({ id: unit }, work),
			heapBytes: () => heap,
			cpuNanos: () => (isolate.isDisposed ? billed : isolate.cpuTime),
			retired,
			step: (unit) => {
				const owned = units.getStore() ?? current;
				if (owned === undefined || owned.id === unit) return;
				if (owned === current) {
					meter(owned, checkpoint);
					checkpoint = performance.now();
				}
				owned.id = unit;
			},
			dispose: () => die(failure('interrupted', 'The workspace engine was stopped.'))
		};
	} catch (error) {
		die(failure('interrupted', 'The workspace engine did not boot.'));
		throw error;
	}
};
