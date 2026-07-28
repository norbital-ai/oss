// fallow-ignore-file unused-file -- reached only through the generated server entry, which
// re-exports startPodStdioServer as a source string in vite/index.ts (invisible to static analysis).
/**
 * The tenant runtime guest loop.
 *
 * This is the entry point of every tenant container. The container runs with `--network=none`
 * and a read-only root, so stdin/stdout is the process's only channel: it reads request frames
 * from Core, answers them out of the workspace bundle, and calls back through the same pipe for
 * anything that needs a credential. See `@norbital-ai/platform-utils/runtime/wire` for the frame
 * layout and for why binding values are escaped rather than sent raw.
 *
 * Responses are always streamed — `head`, then `chunk`s, then `end`. A server-sent-events
 * response has no end until the client disconnects, so a transport that waited for a complete
 * body would wait forever; streaming every response keeps one code path instead of a guess about
 * which bodies terminate.
 *
 * Static assets are deliberately absent. Core holds the same build output on disk and serves
 * `dist/` itself, so a page load never has to wake a container and this process only ever sees
 * `/_runtime/*` and `/_pod/bootstrap`.
 */
import {
	decodeWireValue,
	encodeFrame,
	encodeWireValue,
	FrameReader,
	type GuestFrameHeader,
	type HostFrameHeader
} from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostAiBinding,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostNotificationsBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { setDatabaseNotifications } from '$lib/server/collection/sync/db-notifications.server.js';
import { handlePodRequest } from './server.js';

type PendingBindingCall = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

/**
 * Reserve stdout for frames, and send everything else to stderr.
 *
 * The frame format is a length prefix followed by exactly that many bytes, and `FrameReader` has
 * no resynchronisation step — by construction, because a transport that could re-find the start
 * of a frame could also silently drop half of one. So a single stray byte on this stream is not
 * noise: the reader takes the next four characters as a length, waits for a frame that will never
 * arrive, and every request in flight and after it hangs until the host's request timeout fires.
 * The symptom is a request that produces no error and never returns, which reads as "slow".
 *
 * A workspace author writing `console.log` in a hook is doing something perfectly ordinary, and it
 * must not be able to wedge their tenant. Redirecting the console — rather than documenting a rule
 * nobody can enforce — makes the whole class of failure unreachable, and the output still arrives:
 * the host logs the guest's stderr.
 */
type FramePriority = 'control' | 'stream';
type QueuedFrame = {
	readonly bytes: Uint8Array;
	readonly priority: FramePriority;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
};

function claimStdout(): (bytes: Uint8Array, priority?: FramePriority) => Promise<void> {
	const stdout = process.stdout;
	const frameWrite = stdout.write.bind(stdout);
	// Everything that reaches for stdout from here on — `console.log`, a dependency's progress
	// bar, anything at all — is diverted. Only the returned handle still reaches the pipe.
	stdout.write = process.stderr.write.bind(process.stderr) as typeof stdout.write;
	const controlQueue: QueuedFrame[] = [];
	const streamQueue: QueuedFrame[] = [];
	let draining = false;
	let failure: Error | null = null;

	async function drain(): Promise<void> {
		if (draining) return;
		draining = true;
		try {
			// stupidity:allow A6 -- one writer must preserve frame order while honoring backpressure.
			for (;;) {
				const frame = controlQueue.shift() ?? streamQueue.shift();
				if (!frame) return;
				if (failure) {
					frame.reject(failure);
					continue;
				}
				try {
					await new Promise<void>((resolve, reject) => {
						frameWrite(frame.bytes, (error) => {
							if (error) reject(error);
							else resolve();
						});
					});
					frame.resolve();
				} catch (cause) {
					failure = cause instanceof Error ? cause : new Error(String(cause));
					frame.reject(failure);
				}
				// An always-ready SSE body must release the microtask queue so a new request can
				// enqueue its binding call or response head before the next stream frame is chosen.
				if (frame.priority === 'stream') await new Promise<void>((resolve) => setImmediate(resolve));
			}
		} finally {
			draining = false;
			if (controlQueue.length > 0 || streamQueue.length > 0) void drain();
		}
	}

	return (bytes, priority = 'control') => {
		if (failure) return Promise.reject(failure);
		return new Promise<void>((resolve, reject) => {
			const frame = { bytes, priority, resolve, reject };
			if (priority === 'control') controlQueue.push(frame);
			else streamQueue.push(frame);
			void drain();
		});
	};
}

/**
 * Start the stdio request loop. Called by the generated `serve.mjs` at the bundle root; never
 * on import, so the build can import this bundle to read its manifest without starting a server.
 */
export function startPodStdioServer(): void {
	const writeFrame = claimStdout();
	const pending = new Map<number, PendingBindingCall>();
	const inflight = new Map<number, AbortController>();
	const notificationListeners = new Set<(channel: string, payload: string) => void>();
	const reader = new FrameReader();
	let nextCallId = 1;

	function write(
		header: GuestFrameHeader,
		body?: Uint8Array | null,
		priority?: FramePriority
	): Promise<void> {
		return writeFrame(encodeFrame(header, body), priority);
	}

	function call(facility: string, method: string, args: readonly unknown[]): Promise<unknown> {
		const id = nextCallId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			void write({ t: 'binding', id, facility, method, args: args.map(encodeWireValue) }).catch(
				(cause) => {
					pending.delete(id);
					reject(cause);
				}
			);
		});
	}

	/**
	 * Every facility is the same shape — forward the call, decode the result — so the bindings
	 * are projections of one proxy rather than five hand-written adapters.
	 */
	function facility<T>(name: string): T {
		// stupidity:allow R3a -- Proxy needs an object target; every exposed property is trapped below.
		return new Proxy({} as Record<string, unknown>, {
			get(_target, method: string) {
				return (...args: unknown[]) => call(name, method, args).then(decodeWireValue);
			}
		}) as T;
	}

	const bindings: RuntimeFacilityBindings = {
		db: facility<HostDbBinding>('db'),
		fileStorage: facility<HostFileStorageBinding>('fileStorage'),
		ai: facility<HostAiBinding>('ai'),
		notifications: facility<HostNotificationsBinding>('notifications'),
		maps: facility<HostMapsBinding>('maps')
	};

	// Core owns the LISTEN connection (one per tenant database, shared by every container on it)
	// and pushes each notification here as a frame. The sync stream waits on this instead of
	// asking the database whether anything changed.
	setDatabaseNotifications({
		subscribe(listener) {
			notificationListeners.add(listener);
			return () => notificationListeners.delete(listener);
		}
	});

	async function respond(header: Extract<HostFrameHeader, { t: 'request' }>, body: Uint8Array) {
		const abort = new AbortController();
		inflight.set(header.id, abort);
		try {
			const request = new Request(`http://tenant.local${header.path}`, {
				method: header.method,
				headers: header.headers,
				// A Uint8Array over a plain ArrayBuffer is a valid BodyInit; TS only narrows the
				// generic form, so name it as the buffer view fetch actually accepts.
				body:
					header.method === 'GET' || header.method === 'HEAD'
						? undefined
						: (body as unknown as BodyInit), // stupidity: boundary-cast -- non-data Fetch boundary; the bytes remain unchanged.
				signal: abort.signal
			});
			const response = await handlePodRequest(request, bindings);
			const isEventStream = response.headers.get('content-type')?.includes('text/event-stream');
			await write({
				t: 'head',
				id: header.id,
				status: response.status,
				headers: Object.fromEntries(response.headers)
			});
			if (response.body) {
				const bodyReader = response.body.getReader();
				// stupidity:allow A6 -- streamed responses must preserve chunk order until EOF.
				for (;;) {
					const { done, value } = await bodyReader.read();
					if (done) break;
					if (abort.signal.aborted) {
						await bodyReader.cancel().catch(() => {});
						break;
					}
					if (value?.length)
						await write(
							{ t: 'chunk', id: header.id },
							value,
							isEventStream ? 'stream' : 'control'
						);
				}
			}
			await write({ t: 'end', id: header.id });
		} catch (caught) {
			if (!abort.signal.aborted) {
				await write({
					t: 'error',
					id: header.id,
					error: caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
				}).catch((writeError) => {
					console.error('[tenant-runtime] failed to write response error frame', writeError);
				});
			}
		} finally {
			inflight.delete(header.id);
		}
	}

	process.stdin.on('data', (chunk: Uint8Array) => {
		reader.push(chunk);
		for (const frame of reader.drain()) {
			const header = frame.header as HostFrameHeader;
			switch (header.t) {
				case 'request':
					void respond(header, frame.body);
					break;
				case 'cancel':
					// The client hung up. Aborting the request signal is what ends an otherwise
					// endless response, so a closed tab does not leave work running in here.
					inflight.get(header.id)?.abort();
					inflight.delete(header.id);
					break;
				case 'notify':
					for (const listener of notificationListeners) listener(header.channel, header.payload);
					break;
				case 'binding': {
					const call = pending.get(header.id);
					if (!call) break;
					pending.delete(header.id);
					if (header.ok) call.resolve(header.value);
					else call.reject(new Error(header.error));
					break;
				}
			}
		}
	});

	// Core closing the pipe is the shutdown signal; there is nothing else that could close it.
	process.stdin.on('end', () => process.exit(0));
	void write({ t: 'ready' }).catch((error) => {
		console.error('[tenant-runtime] failed to announce readiness', error);
		process.exit(1);
	});
}
