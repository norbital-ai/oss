/**
 * The guest half of a host-owned runtime channel — the only way a hosted runtime reaches its host.
 *
 * A hosted runtime used to reach its host over HTTP: one `GET` for its deployment configuration at
 * boot, one `POST` per facility call for the rest of its life. That cannot survive a sealed sandbox.
 * Measured on a real node, an egress allow rule naming the host's private address is programmed into
 * the firewall and the traffic still does not flow, so a guest that must dial out is a guest that
 * cannot run sealed — and sealing it is the only configuration that works. That transport is gone
 * rather than deprecated: keeping it would have meant keeping a code path no deployment can use.
 *
 * So the host opens the channel instead. It starts this process with a writable stdin and speaks
 * length-prefixed frames over the process's own stdio; the guest reads requests and responses from
 * stdin and writes its requests to stdout. The direction of *requests* is unchanged, because it has
 * to be: `db.query` runs synchronously per SQL statement in the middle of serving a user, and no host
 * can push the answer to a question that has not been asked. What changes is that the guest no longer
 * opens a **connection**.
 *
 * ## stdout carries frames and nothing else
 *
 * This is the invariant the whole transport rests on, and the easiest one to break: a single
 * `console.log` anywhere in this process — in workspace code, in a dependency, in a stray debug line
 * — inserts bytes into the middle of a frame and desynchronises the channel permanently. There is no
 * sentinel to resync on, so the session dies.
 *
 * {@link claimStdoutForFrames} is how that is prevented rather than merely asked for: it takes a
 * private handle on the real stdout, then replaces `process.stdout.write` with a forwarder to
 * stderr. Frames go out through the private handle; everything else in the process — including
 * `console.log`, which writes through `process.stdout.write` — lands on stderr, where the host reads
 * it as boot diagnostics. Nothing has to remember the rule, because there is no longer a way to
 * break it from JavaScript.
 *
 * The one window that claim cannot close is module evaluation before this file runs, which is where
 * tenant workspace code gets to execute its own top-level statements. {@link STDIO_FRAME_GUARD_SOURCE}
 * is emitted into the generated `serve.mjs` ahead of the bundle import for exactly that reason, and
 * hands the private handle over through a well-known global.
 */
import {
	encodeFrame,
	encodeWireValue,
	FrameReader,
	type GuestFrameHeader,
	type HostFrameHeader
} from '@norbital-ai/platform-utils/runtime/wire';
import type { HostAppPlugin } from '@norbital-ai/platform-utils/runtime/binding';
import type { Readable } from 'node:stream';
import { parseHostPlugins } from '../host/types.js';

/**
 * Where the private stdout handle is stashed, so the guard installed by the generated entry point and
 * the claim made here are the same claim. A registered symbol rather than a property name because two
 * copies of this module in one process must find each other's handle.
 */
const STDOUT_CLAIM_KEY = 'norbital.pod.stdout-frames';

/**
 * The preamble the generated `serve.mjs` runs before it imports the workspace bundle.
 *
 * Plain JavaScript, and deliberately the smallest thing that can work: capture the real stdout,
 * publish it, and point `process.stdout.write` at stderr. Everything after this line in the process
 * — the workspace's own module-level code included — can log freely without corrupting a frame.
 * Unconditional, because there is no longer a deployment where stdout means anything else.
 */
export const STDIO_FRAME_GUARD_SOURCE = `// stdout carries RPC frames and nothing else, so no other writer may reach it.
// Installed before the bundle is imported, because workspace modules run code as they evaluate.
globalThis[Symbol.for('${STDOUT_CLAIM_KEY}')] = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);
`;

type StreamWrite = (chunk: Uint8Array | string, ...rest: unknown[]) => boolean;

/**
 * Just enough of a stream to claim it. Declared with method syntax deliberately: `process.stdout`
 * carries overloads for encodings and completion callbacks, and a property-typed signature would
 * reject the real thing while accepting a look-alike.
 */
type ClaimableStream = { write(chunk: Uint8Array | string, ...rest: unknown[]): boolean };

export type FrameStreams = {
	readonly stdout: ClaimableStream;
	readonly stderr: ClaimableStream;
	/**
	 * Where an earlier claim publishes its private stdout handle. Defaults to `globalThis`, which is
	 * where the generated entry point puts it; a test supplies its own object.
	 */
	readonly registry?: Record<symbol, unknown>;
};

/**
 * Take stdout away from the rest of the process and return the only writer that still reaches it.
 *
 * Idempotent, and it composes with the guard in the generated entry point: if a handle has already
 * been published, that one is used and stdout is redirected again harmlessly. Calling this twice
 * therefore yields two writers onto the same real stream rather than a writer onto stderr.
 */
export function claimStdoutForFrames(streams: FrameStreams): (frame: Uint8Array) => void {
	const key = Symbol.for(STDOUT_CLAIM_KEY);
	// stupidity:allow R1a -- globalThis has no index signature; the key is a registered symbol.
	const registry = streams.registry ?? (globalThis as unknown as Record<symbol, unknown>);
	const published = registry[key];
	const claimed: StreamWrite =
		typeof published === 'function'
			? (published as StreamWrite)
			: streams.stdout.write.bind(streams.stdout);
	registry[key] = claimed;
	const stdout = streams.stdout;
	stdout.write = (chunk, ...rest) => streams.stderr.write(chunk, ...rest);
	return (frame) => {
		claimed(frame);
	};
}

/**
 * The most facility calls that may be outstanding at once.
 *
 * A request that issues twenty queries is ordinary; twenty thousand is a runaway loop, and without a
 * ceiling its pending map grows until the process dies of memory exhaustion with no indication of
 * which workspace code did it. Refusing the call names the cause instead.
 */
const DEFAULT_MAX_IN_FLIGHT = 256;

type PendingCall = {
	readonly facility: string;
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
};

export type StdioRuntimeChannel = {
	/** Deployment configuration, awaited once before the runtime serves anything. */
	configuration(): Promise<readonly HostAppPlugin[]>;
	/** Invoke one host facility method. Returns the still-escaped result. */
	call(facility: string, method: string, args: readonly unknown[]): Promise<unknown>;
	/**
	 * Tell the host the runtime is serving: configuration installed, port bound. The host waits for
	 * this rather than for the process to exist, because a process that started and a runtime that can
	 * answer are different things.
	 */
	readyForTraffic(): void;
	/** How many calls are waiting for a response. Exposed so the ceiling above is observable. */
	readonly inFlight: number;
};

export type StdioRuntimeChannelOptions = {
	/** Frames from the host. `process.stdin` in a sandbox; a pipe in a test. */
	readonly input: Readable;
	/** Frames to the host — the writer {@link claimStdoutForFrames} returned. */
	readonly writeFrame: (frame: Uint8Array) => void;
	/**
	 * The channel cannot continue: a frame did not parse, or the host said something this protocol
	 * does not contain. There is no resynchronisation from here — the caller's only correct response
	 * is to end the process so the host evicts the session and the next request cold-boots.
	 */
	readonly onFatal: (error: Error) => void;
	/** The host closed stdin. An orderly shutdown, not a failure. */
	readonly onClosed?: () => void;
	readonly maxInFlight?: number;
};

/**
 * The guest's client for a host-owned stdio channel.
 *
 * Everything downstream of it — `facilityProxy`, all six facility bindings, the poll loop behind
 * `ai.readStream` — deals only in `call`, so none of it knows what carries a call. Two properties are
 * worth naming because they are inherent to the direction of travel:
 *
 * - `configuration()` waits for a frame the host pushes rather than making a request. That is what
 *   gates the boot: the port is not bound until the configuration is in, but the guest is not the
 *   party that asks for it.
 * - A call has no deadline. `ai.readStream` waits for the next event of a model response, so a
 *   client-side timeout would abort precisely the calls that were behaving.
 */
export function createStdioRuntimeClient(options: StdioRuntimeChannelOptions): StdioRuntimeChannel {
	const reader = new FrameReader();
	const pending = new Map<number, PendingCall>();
	const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
	let nextCallId = 1;
	let broken: Error | null = null;
	let configured = false;

	let publishConfiguration: (plugins: readonly HostAppPlugin[]) => void = () => {};
	let refuseConfiguration: (error: Error) => void = () => {};
	const configuration = new Promise<readonly HostAppPlugin[]>((resolve, reject) => {
		publishConfiguration = resolve;
		refuseConfiguration = reject;
	});
	// A boot that fails before anything awaits the configuration must not also surface as an
	// unhandled rejection: the real error is the one the caller is about to be given.
	void configuration.catch(() => {});

	/** Settle everything outstanding. The channel never recovers, so this runs at most once. */
	function breakChannel(error: Error, fatal: boolean): void {
		if (broken) return;
		broken = error;
		refuseConfiguration(error);
		const outstanding = [...pending.values()];
		pending.clear();
		for (const call of outstanding) {
			call.reject(
				new Error(`Host binding call ${call.facility}.${call.method} failed: ${error.message}`)
			);
		}
		if (fatal) options.onFatal(error);
		else options.onClosed?.();
	}

	function accept(header: HostFrameHeader): void {
		switch (header.t) {
			case 'configure': {
				// A second push would mean the host has changed its mind about a runtime that is already
				// serving, and this protocol has no way to apply that to sessions already rendered.
				if (configured) throw new Error('Host pushed a second runtime configuration frame');
				configured = true;
				publishConfiguration(parseHostPlugins(header.hostPlugins));
				return;
			}
			case 'binding': {
				const call = pending.get(header.id);
				// A response to a call that is already settled — the channel broke under it — is stale,
				// not a protocol error.
				if (!call) return;
				pending.delete(header.id);
				if (header.ok) call.resolve(header.value);
				else {
					// The message and nothing around it: the agent loop reads it and shows it to a user.
					call.reject(
						new Error(
							header.error ||
								`Host binding call ${call.facility}.${call.method} was refused without a reason`
						)
					);
				}
				return;
			}
			default: {
				const unhandled: never = header;
				throw new Error(
					`Host sent a runtime frame this transport does not contain: ${JSON.stringify(unhandled)}`
				);
			}
		}
	}

	options.input.on('data', (chunk: Uint8Array) => {
		if (broken) return;
		reader.push(chunk);
		try {
			for (const frame of reader.drain()) accept(hostFrame(frame.header));
		} catch (caught) {
			breakChannel(caught instanceof Error ? caught : new Error(String(caught)), true);
		}
	});
	options.input.on('error', (error: Error) => breakChannel(error, true));
	options.input.on('end', () =>
		breakChannel(new Error('The host closed the runtime channel'), false)
	);

	return {
		configuration: () => configuration,
		async call(facility, method, args) {
			if (broken) {
				throw new Error(`Host binding call ${facility}.${method} failed: ${broken.message}`);
			}
			if (pending.size >= maxInFlight) {
				throw new Error(
					`Host binding call ${facility}.${method} refused: ${pending.size} calls are already awaiting the host (limit ${maxInFlight})`
				);
			}
			const id = nextCallId++;
			const frame = encodeFrame({
				t: 'binding',
				id,
				facility,
				method,
				args: args.map(encodeWireValue)
			} satisfies GuestFrameHeader);
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { facility, method, resolve, reject });
				try {
					options.writeFrame(frame);
				} catch (caught) {
					pending.delete(id);
					reject(
						new Error(
							`Host binding call ${facility}.${method} failed: ${caught instanceof Error ? caught.message : String(caught)}`
						)
					);
				}
			});
		},
		readyForTraffic() {
			options.writeFrame(encodeFrame({ t: 'ready' } satisfies GuestFrameHeader));
		},
		get inFlight() {
			return pending.size;
		}
	};
}

/**
 * Read a host frame out of a decoded header, refusing anything this protocol does not describe.
 *
 * The JSON parsed, which says the framing held; it does not say the host sent something meaningful.
 * A `binding` response with no `id` would otherwise leave the call that is waiting for it waiting
 * forever, which presents as a hung tenant request rather than as a broken channel.
 */
function hostFrame(header: unknown): HostFrameHeader {
	const frame =
		typeof header === 'object' && header != null && !Array.isArray(header)
			? (header as Record<string, unknown>)
			: null;
	if (!frame) throw new Error('Host runtime frame header was not a JSON object');
	if (frame.t === 'configure') return { t: 'configure', hostPlugins: asArray(frame.hostPlugins) };
	if (frame.t === 'binding') {
		if (typeof frame.id !== 'number' || !Number.isInteger(frame.id)) {
			throw new Error('Host binding frame carried no integer id to correlate it with a call');
		}
		if (frame.ok === true) return { t: 'binding', id: frame.id, ok: true, value: frame.value };
		if (frame.ok === false) {
			return {
				t: 'binding',
				id: frame.id,
				ok: false,
				error: typeof frame.error === 'string' ? frame.error : ''
			};
		}
		throw new Error(`Host binding frame ${frame.id} declared neither success nor failure`);
	}
	throw new Error(`Host runtime frame named an unknown kind: ${JSON.stringify(frame.t)}`);
}

function asArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new Error('Host configure frame did not carry a hostPlugins array');
	}
	return value;
}
