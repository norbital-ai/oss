// The membrane codec (compute model §14): two sides wired as a kernel and its cell are — the cell's sends answer at
// once, the kernel's arrive later as entries — with every message structured-cloned as it crosses an isolate.
import { describe, expect, it } from '@effect/vitest';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { Effect } from 'effect';
import { membrane, type Membrane, type Message } from '../src/protocol/membrane.ts';

setFlagsFromString('--expose-gc');
const gc: unknown = runInNewContext('gc');
const collect = () => (typeof gc === 'function' ? gc() : expect.unreachable('gc is exposed'));

const pair = () => {
	const sides: { kernel?: Membrane; cell?: Membrane } = {};
	const cell = () => sides.cell ?? expect.unreachable('the cell side is wired');
	const kernel = () => sides.kernel ?? expect.unreachable('the kernel side is wired');
	// the kernel's message is an entry: later, and a call's immediate answer settles the kernel's pending call
	sides.kernel = membrane((message: Message) => {
		queueMicrotask(() => {
			const answer = cell().receive(structuredClone(message));
			if (message[0] === 'call' && answer !== undefined)
				kernel().receive([
					answer[0] === 'ok' ? 'resolve' : 'reject',
					message[3],
					structuredClone(answer[1])
				]);
		});
		return undefined;
	});
	// the cell's message is a synchronous system call
	sides.cell = membrane((message: Message) =>
		structuredClone(kernel().receive(structuredClone(message)))
	);
	/** A kernel value as the cell receives it, and back. */
	const toCell = (value: unknown) => cell().decode(structuredClone(kernel().encode(value)));
	const toKernel = (value: unknown) => kernel().decode(structuredClone(cell().encode(value)));
	return { kernel: kernel(), cell: cell(), toCell, toKernel };
};
const live = (name: string, body: () => Promise<void>) => it.live(name, () => Effect.promise(body));

describe('the membrane', () => {
	live('carries data as it is, a data object with a marker key included', async () => {
		const { toKernel } = pair();
		const value = {
			text: 'ünïcode',
			n: 1.5,
			none: null,
			missing: undefined,
			bytes: new Uint8Array([1, 2, 3]),
			map: new Map<string, unknown>([['a', [1, { b: true }]]]),
			marked: { $fn: 3, $obj: 'x' },
			list: [{ $stream: 1 }]
		};
		expect(toKernel(value)).toEqual(value);
	});

	live('calls a function on the other side, answering at once when it does', async () => {
		const { toCell, toKernel } = pair();
		const add = toCell((a: number, b: number) => a + b);
		if (typeof add !== 'function') return expect.unreachable('a function crosses as a function');
		expect(add(1, 2)).toBe(3);
		const later = toCell(async (text: string) => text.toUpperCase());
		if (typeof later !== 'function') return expect.unreachable('a function crosses as a function');
		await expect(later('cell')).resolves.toBe('CELL');
		const fromCell = toKernel(() => 'answered');
		if (typeof fromCell !== 'function')
			return expect.unreachable('a function crosses as a function');
		await expect(fromCell()).resolves.toBe('answered');
	});

	live('crosses an error with its own fields, and an encoded failure as data', async () => {
		const { toCell, toKernel } = pair();
		const throws = toCell(() => {
			throw Object.assign(new Error('duplicate key'), { sqlstate: '23505' });
		});
		if (typeof throws !== 'function') return expect.unreachable('a function crosses as a function');
		const thrown: unknown = (() => {
			try {
				return throws();
			} catch (error) {
				return error;
			}
		})();
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).toMatchObject({ message: 'duplicate key', sqlstate: '23505' });
		const failure = {
			_tag: 'HostFailure',
			code: 'notFound',
			phase: 'admission',
			message: 'no artifact'
		};
		const rejects = toKernel(() => Promise.reject(failure));
		if (typeof rejects !== 'function')
			return expect.unreachable('a function crosses as a function');
		const error: unknown = await rejects().then(
			() => null,
			(e: unknown) => e
		);
		expect(error).toEqual(failure);
		expect(error).not.toBeInstanceOf(Error);
	});

	live(
		'hands back the original function, object and signal, never a mirror of a mirror',
		async () => {
			const { toCell, toKernel } = pair();
			const port = { read: () => 'rows' };
			const mirror = toKernel(port);
			expect(mirror).not.toBe(port);
			expect(toCell(mirror)).toBe(port);
			const controller = new AbortController();
			expect(toKernel(toCell(controller.signal))).toBe(controller.signal);
		}
	);

	live('aborts the mirror of a signal with its reason', async () => {
		const { toCell } = pair();
		const controller = new AbortController();
		const signal = toCell(controller.signal);
		if (!(signal instanceof AbortSignal)) return expect.unreachable('a signal crosses as a signal');
		const aborted = new Promise((resolve) =>
			signal.addEventListener('abort', () => resolve(signal.reason))
		);
		controller.abort(new Error('the client went away'));
		await expect(aborted).resolves.toMatchObject({ message: 'the client went away' });
		const gone = toCell(AbortSignal.abort('gone'));
		if (!(gone instanceof AbortSignal)) return expect.unreachable('a signal crosses as a signal');
		expect([gone.aborted, gone.reason]).toEqual([true, 'gone']);
	});

	live(
		'streams a request body chunk by chunk and keeps its method, headers and signal',
		async () => {
			const { toCell } = pair();
			const controller = new AbortController();
			const request = toCell(
				new Request('https://acme.example/acme/__bolt/q?x=1', {
					method: 'POST',
					headers: { 'content-type': 'application/json', cookie: 'a=b' },
					body: JSON.stringify({ reads: [] }),
					signal: controller.signal
				})
			);
			if (!(request instanceof Request))
				return expect.unreachable('a request crosses as a request');
			expect(request.method).toBe('POST');
			expect(request.url).toBe('https://acme.example/acme/__bolt/q?x=1');
			expect(request.headers.get('cookie')).toBe('a=b');
			await expect(request.json()).resolves.toEqual({ reads: [] });
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(request.signal.aborted).toBe(true);
		}
	);

	live(
		'keeps a mirrored body whose read waits on the other side through a collection',
		async () => {
			const { toKernel } = pair();
			let chunk: ((value: string) => void) | undefined;
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					controller.enqueue(
						new TextEncoder().encode(await new Promise<string>((resolve) => (chunk = resolve)))
					);
					controller.close();
				}
			});
			// only the read's promise is held: the mirror, its reader and the read are otherwise unreachable
			// a streamed body is half duplex, which the DOM's RequestInit does not name
			const init = { method: 'POST', body, duplex: 'half' };
			const text = (() => {
				const request = toKernel(new Request('https://acme.example/hooks/x', init));
				if (!(request instanceof Request)) return expect.unreachable('a request crosses');
				return request.text();
			})();
			await new Promise((resolve) => setTimeout(resolve, 10));
			for (let at = 0; at < 3; at++) {
				collect();
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			chunk?.('kept');
			await expect(text).resolves.toBe('kept');
		}
	);

	live('streams a response body and cancels its source when the reader stops', async () => {
		const { toKernel } = pair();
		let canceled = false;
		const encoder = new TextEncoder();
		let n = 0;
		const body = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				controller.enqueue(encoder.encode(`data: ${n++}\n\n`));
			},
			cancel: () => {
				canceled = true;
			}
		});
		const response = toKernel(
			new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
		);
		if (!(response instanceof Response) || response.body === null)
			return expect.unreachable('a response crosses with its body');
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const reader = response.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe('data: 0\n\n');
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(canceled).toBe(true);
		const whole = toKernel(new Response('whole'));
		if (!(whole instanceof Response)) return expect.unreachable('a response crosses as a response');
		await expect(whole.text()).resolves.toBe('whole');
	});

	live('rejects every pending call when the other side is gone', async () => {
		const { kernel, toKernel } = pair();
		const never = toKernel(() => new Promise(() => undefined));
		if (typeof never !== 'function') return expect.unreachable('a function crosses as a function');
		const pending: Promise<unknown> = never();
		const failure = { _tag: 'HostFailure', code: 'cpuBudget', phase: 'admission', message: 'gone' };
		kernel.close(failure);
		await expect(pending).rejects.toEqual(failure);
		await expect(never()).rejects.toEqual(failure);
	});

	live(
		'a call nobody awaits raises no unhandled rejection when the other side is gone',
		async () => {
			const { kernel, toKernel } = pair();
			const never = toKernel(() => new Promise(() => undefined));
			if (typeof never !== 'function')
				return expect.unreachable('a function crosses as a function');
			const escaped: unknown[] = [];
			const listen = (reason: unknown) => escaped.push(reason);
			process.on('unhandledRejection', listen);
			void never();
			kernel.close({ _tag: 'HostFailure', code: 'memory', phase: 'admission', message: 'gone' });
			await new Promise((resolve) => setTimeout(resolve, 20));
			process.off('unhandledRejection', listen);
			expect(escaped).toEqual([]);
		}
	);
});
