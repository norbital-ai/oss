import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
	decodeWireValue,
	encodeFrame,
	encodeWireValue,
	FrameReader,
	type HostFrameHeader
} from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostDbBinding,
	HostFileStorageBinding
} from '@norbital-ai/platform-utils/runtime/binding';
import { facilityProxy, hostedEnvironment } from '../../src/serve/hosted.js';
import {
	claimStdoutForFrames,
	createStdioRuntimeClient,
	STDIO_FRAME_GUARD_SOURCE,
	type StdioRuntimeChannel
} from '../../src/serve/stdio.js';

/**
 * The guest half of the host-owned runtime channel, driven over real in-process pipes.
 *
 * No microVM is involved and none is needed: what these suites exercise is the part that broke every
 * time this codebase has moved a transport — correlation of concurrent calls, bytes that JSON cannot
 * hold, chunk boundaries that fall inside a frame, and what happens to work already in flight when
 * the channel dies. The fake host below is a `PassThrough` in each direction, which is the same shape
 * as the pipe envd gives the process.
 */

type FakeHost = {
	/** The channel under test — the object `serve/hosted.ts` hands to `facilityProxy`. */
	readonly channel: StdioRuntimeChannel;
	/** The next frame the guest wrote, waiting for it if it has not been written yet. */
	nextGuestFrame(): Promise<Record<string, unknown>>;
	send(header: HostFrameHeader): void;
	/** Push raw bytes, in fragments, the way a pipe delivers them. */
	sendBytes(bytes: Uint8Array, chunkSize?: number): void;
	endChannel(): void;
	readonly fatal: Error[];
	readonly closed: number[];
};

const openHosts: PassThrough[] = [];

function fakeHost(options: { readonly maxInFlight?: number } = {}): FakeHost {
	const toGuest = new PassThrough();
	const fromGuest = new PassThrough();
	openHosts.push(toGuest, fromGuest);

	const waiting: ((header: Record<string, unknown>) => void)[] = [];
	const arrived: Record<string, unknown>[] = [];
	const reader = new FrameReader();
	fromGuest.on('data', (chunk: Uint8Array) => {
		reader.push(chunk);
		for (const frame of reader.drain()) {
			const header = frame.header as Record<string, unknown>;
			const waiter = waiting.shift();
			if (waiter) waiter(header);
			else arrived.push(header);
		}
	});

	const fatal: Error[] = [];
	const closed: number[] = [];
	const channel = createStdioRuntimeClient({
		input: toGuest,
		writeFrame: (frame) => {
			fromGuest.write(frame);
		},
		onFatal: (error) => fatal.push(error),
		onClosed: () => closed.push(1),
		...(options.maxInFlight == null ? {} : { maxInFlight: options.maxInFlight })
	});

	return {
		channel,
		nextGuestFrame() {
			const ready = arrived.shift();
			if (ready) return Promise.resolve(ready);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('The guest wrote no frame within 5s')),
					5_000
				);
				waiting.push((header) => {
					clearTimeout(timer);
					resolve(header);
				});
			});
		},
		send(header) {
			toGuest.write(encodeFrame(header));
		},
		sendBytes(bytes, chunkSize = bytes.length) {
			for (let offset = 0; offset < bytes.length; offset += chunkSize) {
				toGuest.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
			}
		},
		endChannel() {
			toGuest.end();
		},
		fatal,
		closed
	};
}

afterEach(() => {
	for (const stream of openHosts.splice(0)) stream.destroy();
});

/** Whether a promise has settled, without awaiting it — for asserting that boot is still gated. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	const pendingMarker = Symbol('pending');
	const outcome = await Promise.race([
		promise.then(
			() => true,
			() => true
		),
		new Promise((resolve) => setImmediate(() => resolve(pendingMarker)))
	]);
	return outcome !== pendingMarker;
}

function bytesWith(length: number, edges: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index += 1) bytes[index] = index % 256;
	bytes.set(edges, 0);
	return bytes;
}

describe('boot configuration arrives as a push', () => {
	/**
	 * The whole reason the transport moved: the guest used to fetch this over HTTP before binding its
	 * port, and a sealed sandbox cannot make that call. The gate has to survive the change — a port
	 * bound before the configuration is in serves a workspace whose host surfaces are half-installed.
	 */
	it('does not resolve the configuration until the host pushes it', async () => {
		const host = fakeHost();
		const configuration = host.channel.configuration();
		expect(await settled(configuration)).toBe(false);

		host.send({
			t: 'configure',
			hostPlugins: [
				{ key: 'core-organization', label: 'Organization', entry: '/org', placement: 'settings' }
			]
		});
		expect(await configuration).toEqual([
			{
				key: 'core-organization',
				label: 'Organization',
				entry: '/org',
				placement: 'settings',
				icon: null
			}
		]);
	});

	/**
	 * A configuration the guest cannot read is not survivable: it would either bind with no host
	 * surfaces or crash somewhere in the shell for every session. The channel is fatal so the host
	 * evicts the session instead of leaving a runtime that half works.
	 */
	it('refuses a malformed plugin, naming it, and breaks the channel', async () => {
		const host = fakeHost();
		const configuration = host.channel.configuration();
		host.send({ t: 'configure', hostPlugins: [{ key: 'broken', label: 'Broken' }] });

		await expect(configuration).rejects.toThrow(/Host plugin at index 0 is missing/);
		expect(host.fatal.map((error) => error.message)).toEqual([
			expect.stringMatching(/Host plugin at index 0 is missing/)
		]);
	});

	it('treats a second configuration push as fatal rather than reconfiguring a live runtime', async () => {
		const host = fakeHost();
		host.send({ t: 'configure', hostPlugins: [] });
		expect(await host.channel.configuration()).toEqual([]);

		host.send({ t: 'configure', hostPlugins: [] });
		await expect(host.channel.call('db', 'query', ['select 1'])).rejects.toThrow(
			/second runtime configuration/
		);
		expect(host.fatal).toHaveLength(1);
	});
});

describe('concurrent facility calls', () => {
	/**
	 * A single tenant request issues many facility calls, and `ai.readStream` polls in a loop, so
	 * responses do not come back in the order the calls went out. Correlation is by id and nothing
	 * else — the failure this prevents is one call resolving with another's rows.
	 */
	it('correlates interleaved calls by id, answering each with its own result', async () => {
		const host = fakeHost();
		const first = host.channel.call('db', 'query', ['select 1']);
		const second = host.channel.call('ai', 'models', []);
		const third = host.channel.call('agentTools', 'run', ['probe', { deep: true }]);

		const requests = [
			await host.nextGuestFrame(),
			await host.nextGuestFrame(),
			await host.nextGuestFrame()
		];
		expect(requests.map((frame) => [frame.facility, frame.method])).toEqual([
			['db', 'query'],
			['ai', 'models'],
			['agentTools', 'run']
		]);
		expect(new Set(requests.map((frame) => frame.id)).size).toBe(3);
		expect(host.channel.inFlight).toBe(3);
		expect(requests[2]?.args).toEqual(['probe', { deep: true }]);

		// Answered back to front, which is the case an id-less protocol gets wrong.
		for (const frame of [...requests].reverse()) {
			host.send({ t: 'binding', id: frame.id as number, ok: true, value: `answer-${frame.id}` });
		}
		expect(await Promise.all([first, second, third])).toEqual([
			`answer-${requests[0]?.id}`,
			`answer-${requests[1]?.id}`,
			`answer-${requests[2]?.id}`
		]);
		expect(host.channel.inFlight).toBe(0);
	});

	/**
	 * The ceiling exists so a runaway loop names itself instead of exhausting the process's memory
	 * and dying with nothing to say.
	 */
	it('refuses a call once too many are already awaiting the host', async () => {
		const host = fakeHost({ maxInFlight: 2 });
		const first = host.channel.call('db', 'query', ['one']);
		const second = host.channel.call('db', 'query', ['two']);
		await expect(host.channel.call('db', 'query', ['three'])).rejects.toThrow(
			/2 calls are already awaiting the host \(limit 2\)/
		);

		const a = await host.nextGuestFrame();
		const b = await host.nextGuestFrame();
		host.send({ t: 'binding', id: a.id as number, ok: true, value: 1 });
		host.send({ t: 'binding', id: b.id as number, ok: true, value: 2 });
		expect(await Promise.all([first, second])).toEqual([1, 2]);
	});
});

describe('payloads that JSON cannot hold', () => {
	/**
	 * File bytes and `timestamptz` values are the two types this wire escapes, and the frame carries
	 * the escaped text — so a byte that would terminate a C string, a byte that is not valid UTF-8,
	 * and a multi-byte sequence all have to survive both layers. Reached through the real
	 * `facilityProxy`, because decoding the result is its half of the contract.
	 */
	it('round-trips a large binary payload containing NUL and 0xff, in both directions', async () => {
		const host = fakeHost();
		const storage = facilityProxy<HostFileStorageBinding>('fileStorage', host.channel.call);
		const uploaded = bytesWith(512 * 1024, [0x00, 0x0a, 0xff, 0xe2, 0x82, 0xac]);
		const stored = storage.put('invoices/2026.pdf', uploaded, 'application/pdf');

		const request = await host.nextGuestFrame();
		const args = request.args as unknown[];
		expect(decodeWireValue(args[1])).toEqual(uploaded);
		host.send({ t: 'binding', id: request.id as number, ok: true, value: { ok: true } });
		expect(await stored).toEqual({ ok: true });

		const downloaded = bytesWith(512 * 1024, [0xff, 0x00, 0x00, 0xff]);
		const fetched = storage.get('invoices/2026.pdf');
		const read = await host.nextGuestFrame();
		// Delivered in small fragments, so the reader has to reassemble a frame far larger than any
		// single chunk — the failure mode a codec that trusts write boundaries would never show.
		host.sendBytes(
			encodeFrame({
				t: 'binding',
				id: read.id as number,
				ok: true,
				value: encodeWireValue(downloaded)
			}),
			1024
		);
		expect(await fetched).toEqual(downloaded);
	});

	it('round-trips a Date, which is what every timestamptz column comes back as', async () => {
		const host = fakeHost();
		const db = facilityProxy<HostDbBinding>('db', host.channel.call);
		const created = new Date('2026-08-04T10:20:30.000Z');
		const rows = db.query('select created_at from invoice', [created]);

		const request = await host.nextGuestFrame();
		expect(decodeWireValue((request.args as unknown[])[1])).toEqual([created]);
		host.send({
			t: 'binding',
			id: request.id as number,
			ok: true,
			value: encodeWireValue({ rows: [{ created_at: created }] })
		});
		expect(await rows).toEqual({ rows: [{ created_at: created }] });
	});
});

describe('failures the host reports', () => {
	/**
	 * The host answers a refused call with a message and nothing else, and the agent loop reads that
	 * message. Wrapping it would change what an agent sees.
	 */
	it('rejects with the host message verbatim', async () => {
		const host = fakeHost();
		const query = host.channel.call('db', 'query', ['delete from user']);
		const request = await host.nextGuestFrame();
		host.send({
			t: 'binding',
			id: request.id as number,
			ok: false,
			error: 'permission denied for table user'
		});
		await expect(query).rejects.toThrow(/^permission denied for table user$/);
	});

	it('names the call when the host refuses it without a reason', async () => {
		const host = fakeHost();
		const query = host.channel.call('maps', 'renderStaticMap', []);
		const request = await host.nextGuestFrame();
		host.send({ t: 'binding', id: request.id as number, ok: false, error: '' });
		await expect(query).rejects.toThrow(/maps\.renderStaticMap was refused without a reason/);
	});
});

describe('a channel that cannot be trusted is not repaired', () => {
	/**
	 * Once the stream is out of phase there is no sentinel to resync on, so a reader that skipped
	 * bytes and carried on would eventually deliver a frame assembled from the middle of two others —
	 * a facility result that is plausible and wrong. Fatal is the only safe reading of a bad frame.
	 */
	it('fails every outstanding call, and every later one, on a corrupt frame', async () => {
		const host = fakeHost();
		const configuration = host.channel.configuration();
		const query = host.channel.call('db', 'query', ['select 1']);
		await host.nextGuestFrame();

		host.sendBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00]));

		await expect(query).rejects.toThrow(/db\.query failed/);
		await expect(configuration).rejects.toThrow(/not a frame this reader can assemble/);
		await expect(host.channel.call('db', 'query', ['select 2'])).rejects.toThrow(
			/db\.query failed/
		);
		expect(host.fatal).toHaveLength(1);
		expect(host.closed).toEqual([]);
	});

	it('fails on a frame kind this protocol does not contain', async () => {
		const host = fakeHost();
		const query = host.channel.call('ai', 'readStream', ['stream-1']);
		await host.nextGuestFrame();
		host.sendBytes(encodeFrame({ t: 'ai-chunk', id: 1, text: 'hello' }));

		await expect(query).rejects.toThrow(/unknown kind/);
		expect(host.fatal).toHaveLength(1);
	});

	/**
	 * A response with no id could not be matched to anything, so ignoring it would leave the call
	 * that is waiting for it waiting forever — a hung tenant request rather than a broken channel.
	 */
	it('fails on a binding response that carries no id to correlate', async () => {
		const host = fakeHost();
		const query = host.channel.call('db', 'query', ['select 1']);
		await host.nextGuestFrame();
		host.sendBytes(encodeFrame({ t: 'binding', ok: true, value: null }));

		await expect(query).rejects.toThrow(/no integer id/);
		expect(host.fatal).toHaveLength(1);
	});

	it('ignores a response to a call that is no longer waiting', async () => {
		const host = fakeHost();
		host.send({ t: 'binding', id: 4242, ok: true, value: 'nobody asked' });
		host.send({ t: 'configure', hostPlugins: [] });
		expect(await host.channel.configuration()).toEqual([]);
		expect(host.fatal).toEqual([]);
	});

	/** The host closing stdin is how a runtime is told to stop. Orderly, not a failure. */
	it('treats the host closing the channel as a shutdown, failing what was in flight', async () => {
		const host = fakeHost();
		const query = host.channel.call('db', 'query', ['select 1']);
		await host.nextGuestFrame();
		host.endChannel();

		await expect(query).rejects.toThrow(/closed the runtime channel/);
		expect(host.closed).toEqual([1]);
		expect(host.fatal).toEqual([]);
	});
});

describe('readiness', () => {
	/**
	 * The host waits for this frame rather than for the process to exist, because a process that
	 * started and a runtime that can answer are different things — `serve/hosted.ts` writes it only
	 * after the configuration is installed and the port is bound.
	 */
	it('announces readiness on the channel', async () => {
		const host = fakeHost();
		host.channel.readyForTraffic();
		expect(await host.nextGuestFrame()).toEqual({ t: 'ready' });
	});
});

describe('stdout belongs to the frames', () => {
	/**
	 * One `console.log` in the middle of a frame desynchronises the channel permanently, and the code
	 * that logs it may be a dependency nobody here controls. So stdout is taken away rather than
	 * merely reserved: after the claim, the only writer that still reaches it is the frame writer.
	 */
	it('sends frames to the real stream and everything else to stderr', () => {
		const out: (Uint8Array | string)[] = [];
		const err: (Uint8Array | string)[] = [];
		const stdout = { write: (chunk: Uint8Array | string) => (out.push(chunk), true) };
		const stderr = { write: (chunk: Uint8Array | string) => (err.push(chunk), true) };
		const registry: Record<symbol, unknown> = {};

		const writeFrame = claimStdoutForFrames({ stdout, stderr, registry });
		writeFrame(encodeFrame({ t: 'ready' }));
		// Everything a later caller does — `console.log` writes through exactly this method.
		stdout.write('a stray log line\n');
		stdout.write(new Uint8Array([1, 2, 3]));

		expect(out).toEqual([encodeFrame({ t: 'ready' })]);
		expect(err).toEqual(['a stray log line\n', new Uint8Array([1, 2, 3])]);
	});

	/**
	 * The generated entry point claims stdout before the bundle is imported, and hands the handle
	 * over through the registry. Claiming again must use that handle, not the already-redirected
	 * `write` — doing so would send every frame to stderr and the host would see no runtime at all.
	 */
	it('honours a claim an earlier guard already made', () => {
		const early: Uint8Array[] = [];
		const err: (Uint8Array | string)[] = [];
		const registry: Record<symbol, unknown> = {
			[Symbol.for('norbital.pod.stdout-frames')]: (chunk: Uint8Array) => (early.push(chunk), true)
		};
		const stdout = {
			write: () => {
				throw new Error('the redirected stdout must not be used for frames');
			}
		};
		const stderr = { write: (chunk: Uint8Array | string) => (err.push(chunk), true) };

		const writeFrame = claimStdoutForFrames({ stdout, stderr, registry });
		writeFrame(encodeFrame({ t: 'ready' }));
		expect(early).toEqual([encodeFrame({ t: 'ready' })]);
	});

	/**
	 * The window `claimStdoutForFrames` cannot close is module evaluation: workspace code runs its own
	 * top-level statements as the bundle is imported, before any function in it has been called. So
	 * the guard is emitted into the generated `serve.mjs` ahead of that import, and this runs the real
	 * emitted source in a real Node process to prove it.
	 */
	it('keeps module-evaluation logging off stdout in a real process', async () => {
		const result = await runGuardedChild(`${STDIO_FRAME_GUARD_SOURCE}
console.log('noise from a workspace module');
process.stdout.write('and a direct write\\n');
globalThis[Symbol.for('norbital.pod.stdout-frames')](new Uint8Array([0, 1, 255, 10]));
`);
		expect([...result.stdout]).toEqual([0, 1, 255, 10]);
		expect(result.stderr).toContain('noise from a workspace module');
		expect(result.stderr).toContain('and a direct write');
	});
});

function runGuardedChild(source: string): Promise<{ stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			const stderr = Buffer.concat(err).toString('utf8');
			if (code !== 0) reject(new Error(`Guard probe exited ${code}: ${stderr}`));
			else resolve({ stdout: Buffer.concat(out), stderr });
		});
	});
}

describe('the hosted environment a guest needs', () => {
	/**
	 * The channel the host opened *is* the capability, so there is no address to configure and no
	 * secret to leak into the guest. Both are asserted absent rather than merely unused: a host that
	 * kept setting them must not find them quietly honoured, because the only thing they could still
	 * select is a transport that no longer exists.
	 */
	it('needs the host token and nothing that points at a host', () => {
		expect(
			hostedEnvironment({
				POD_HOST_TOKEN: 'token',
				POD_RUNTIME_PORT: '4000',
				NORBITAL_CORE_URL: 'http://core.local:3000',
				NORBITAL_BINDING_SECRET: 'secret'
			})
		).toEqual({ port: 4000, hostToken: 'token' });
	});

	it('defaults the port a host proxy routes to', () => {
		expect(hostedEnvironment({ POD_HOST_TOKEN: 'token' })).toEqual({
			port: 3000,
			hostToken: 'token'
		});
	});

	it('refuses to boot without the token that gates every inbound request', () => {
		expect(() => hostedEnvironment({})).toThrow(/POD_HOST_TOKEN/);
	});

	it('refuses a port that is not a port', () => {
		expect(() => hostedEnvironment({ POD_HOST_TOKEN: 'token', POD_RUNTIME_PORT: '70000' })).toThrow(
			/POD_RUNTIME_PORT must be an integer from 1 to 65535/
		);
	});
});
