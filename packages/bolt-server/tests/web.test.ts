import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { FacilityFailure } from '@norbital-ai/bolt/errors';
import { isPublicWebAddress, makeRequestPage, WEB_PAGE_BYTE_LIMIT } from '@norbital-ai/bolt/engine';
import { readPublicPage } from '../src/web.ts';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { ClientRequest, IncomingMessage } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Duplex } from 'node:stream';
import type { request as httpsRequest, RequestOptions } from 'node:https';
import { pdfFixture } from './helpers/pdf-fixture.ts';

/** One read as a tagged result, so a refusal and a page assert alike. */
type Options = Parameters<typeof readPublicPage>[1];
const read = (options: Options, url: string) =>
	readPublicPage(url, options).pipe(
		Effect.match({
			onSuccess: (output) => ({ _tag: 'Success' as const, value: { output } }),
			onFailure: (error) => ({ _tag: 'Failure' as const, error: { message: error.message } })
		})
	);

describe('public web connector', () => {
	it.live('extracts every PDF page with a digest of the original binary source', () =>
		Effect.gen(function* () {
			const body = pdfFixture(['RESIN-42 Melt flow 12 g/10 min', 'Density 0.92 g/cm3']);
			const binding: Options = {
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: () => Effect.succeed({ status: 200, contentType: 'application/pdf', body })
			};
			const result = yield* read(binding, 'https://supplier.example/resin.pdf');
			expect(result._tag).toBe('Success');
			if (result._tag !== 'Success') throw new Error('PDF extraction failed');
			expect(result.value.output).toMatchObject({
				url: 'https://supplier.example/resin.pdf',
				contentType: 'application/pdf',
				sha256: createHash('sha256').update(body).digest('hex'),
				pageCount: 2
			});
			expect(result.value.output).toHaveProperty(
				'body',
				expect.stringContaining('RESIN-42 Melt flow 12 g/10 min')
			);
			expect(result.value.output).toHaveProperty(
				'body',
				expect.stringContaining('Density 0.92 g/cm3')
			);
		})
	);

	it.live('refuses blank, corrupt and overlong PDFs instead of returning partial evidence', () =>
		Effect.gen(function* () {
			for (const body of [
				pdfFixture(['']),
				pdfFixture(['Valid first page', '']),
				new Uint8Array(Buffer.from('%PDF-1.7 broken')),
				pdfFixture(Array.from({ length: 201 }, () => 'text'))
			]) {
				const binding: Options = {
					resolve: async () => [{ address: '1.1.1.1', family: 4 }],
					request: () => Effect.succeed({ status: 200, contentType: 'application/pdf', body })
				};
				expect((yield* read(binding, 'https://supplier.example/data.pdf'))._tag).toBe('Failure');
			}
		})
	);

	it('refuses local, private, mapped and reserved addresses', () => {
		for (const address of [
			'127.0.0.1',
			'10.1.1.1',
			'169.254.169.254',
			'172.31.1.1',
			'192.168.1.1',
			'100.100.100.100',
			'0.0.0.0',
			'::1',
			'::ffff:127.0.0.1',
			'fd00::1',
			'fe80::1',
			'2001:db8::1',
			'2002:7f00:1::'
		])
			expect(isPublicWebAddress(address), address).toBe(false);
		for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])
			expect(isPublicWebAddress(address), address).toBe(true);
	});

	it.live('pins a checked address and returns the final URL after public redirects', () =>
		Effect.gen(function* () {
			const requests: string[] = [];
			const binding: Options = {
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: (url, addresses) =>
					Effect.sync(() => {
						expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
						requests.push(url.toString());
						return requests.length === 1
							? { status: 302, location: '/law', contentType: '', body: '' }
							: { status: 200, contentType: 'text/html', body: '<h1>New law</h1>' };
					})
			};
			expect(yield* read(binding, 'https://official.example/')).toEqual({
				_tag: 'Success',
				value: {
					output: {
						url: 'https://official.example/law',
						contentType: 'text/html',
						body: '<h1>New law</h1>',
						sha256: createHash('sha256').update('<h1>New law</h1>').digest('hex')
					}
				}
			});
			expect(requests).toHaveLength(2);
		})
	);

	it.live('refuses redirected private networks before opening another socket', () =>
		Effect.gen(function* () {
			let requests = 0;
			const binding: Options = {
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: () =>
					Effect.sync(() => {
						requests++;
						return {
							status: 302,
							location: 'https://169.254.169.254/credentials',
							contentType: '',
							body: ''
						};
					})
			};
			expect((yield* read(binding, 'https://official.example/'))._tag).toBe('Failure');
			expect(requests).toBe(1);
		})
	);

	it.live(
		'refuses mixed DNS answers, non-HTTPS, credentials, binary bodies and oversized UTF-8',
		() =>
			Effect.gen(function* () {
				let requests = 0;
				const binding: Options = {
					resolve: async () => [
						{ address: '1.1.1.1', family: 4 },
						{ address: '10.0.0.1', family: 4 }
					],
					request: () =>
						Effect.sync(() => {
							requests++;
							return { status: 200, contentType: 'text/plain', body: 'ok' };
						})
				};
				for (const url of [
					'https://example.test',
					'http://example.test',
					'https://user:pass@example.test',
					'https://example.test:8000'
				])
					expect((yield* read(binding, url))._tag).toBe('Failure');
				expect(requests).toBe(0);
				for (const response of [
					{ status: 200, contentType: 'application/pdf', body: 'pdf' },
					{ status: 500, contentType: 'text/plain', body: 'failed' },
					{ status: 200, contentType: 'text/plain', body: '文'.repeat(WEB_PAGE_BYTE_LIMIT / 2) }
				]) {
					const reader: Options = {
						resolve: async () => [{ address: '1.1.1.1', family: 4 }],
						request: () => Effect.succeed(response)
					};
					expect((yield* read(reader, 'https://example.test'))._tag).toBe('Failure');
				}
			})
	);
});

type Attempt = Readonly<{ address: string; family: number; deferred: boolean }>;
type FakeRequest = typeof httpsRequest;

const unroutable = (address: string) =>
	Object.assign(new Error(`connect ENETUNREACH ${address}:443`), {
		code: 'ENETUNREACH',
		syscall: 'connect',
		address
	});

/**
 * `https.request` as the incident saw it. The pinned `lookup` is called synchronously from inside
 * `request`, exactly as `net.connect` calls it, and an address that cannot be routed fails inside
 * that callback with `error` emitted at once. With a synchronous callback that emission lands
 * before `request` has returned, so before any listener exists: that is the process-level
 * uncaught exception from the 03:00 tick. A callback that answers on a later macrotask lands after
 * the listener the facility attached.
 */
const makeFakeRequest = (
	attempts: Array<Attempt>,
	body: string | Uint8Array = '<h1>reached</h1>',
	failing: (address: string) => boolean = (address) => address.includes(':'),
	headers: Readonly<Record<string, string>> = {}
): FakeRequest => {
	class StubRequest extends ClientRequest {
		override end(..._args: unknown[]): this {
			return this;
		}
	}
	function request(
		options: RequestOptions | string | URL,
		callback?: (response: IncomingMessage) => void
	): ClientRequest;
	function request(
		url: string | URL,
		options: RequestOptions,
		callback?: (response: IncomingMessage) => void
	): ClientRequest;
	function request(
		url: RequestOptions | string | URL,
		optionsOrCallback?: RequestOptions | ((response: IncomingMessage) => void),
		callback?: (response: IncomingMessage) => void
	): ClientRequest {
		const options =
			typeof optionsOrCallback === 'object'
				? optionsOrCallback
				: typeof url === 'object' && !(url instanceof URL)
					? url
					: {};
		const onResponse = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
		// The fixture drives lookup and responses itself. A sink transport accepts ClientRequest's
		// headers without an unconnected native Socket emitting an unrelated close/write error.
		const socket = new Duplex({
			read() {},
			write(_chunk, _encoding, done) {
				done();
			}
		});
		const req = new StubRequest({
			host: 'example.test',
			agent: false,
			createConnection: () => socket
		});
		let returned = false;
		const lookup = options.lookup;
		if (lookup === undefined) throw new Error('request has no pinned lookup');
		lookup('example.test', {}, (_error, address, family) => {
			if (typeof address !== 'string' || family === undefined)
				throw new Error('lookup did not answer one address');
			attempts.push({ address, family, deferred: returned });
			if (failing(address)) {
				req.emit('error', unroutable(address));
				return;
			}
			setImmediate(() => {
				const response = new IncomingMessage(new Socket());
				response.statusCode = 200;
				response.headers = { 'content-type': 'text/html', ...headers };
				response.push(Buffer.from(body));
				response.push(null);
				onResponse?.(response);
			});
		});
		returned = true;
		return req;
	}
	return request;
};

describe('public web connector address selection', () => {
	it.live.each([false, true])(
		'decodes unsolicited gzip within the byte limit (oversized: %s)',
		(oversized) =>
			Effect.gen(function* () {
				const body = oversized
					? 'x'.repeat(WEB_PAGE_BYTE_LIMIT + 1)
					: '<h1>Thuế thu nhập cá nhân</h1>';
				const binding: Options = {
					resolve: async () => [{ address: '1.1.1.1', family: 4 }],
					request: makeRequestPage(
						makeFakeRequest([], gzipSync(body), () => false, {
							'content-encoding': 'gzip',
							'content-type': 'text/html; charset=utf-8'
						})
					)
				};
				const result = yield* read(binding, 'https://official.example/');
				if (oversized) expect(result._tag).toBe('Failure');
				else expect(result).toMatchObject({ _tag: 'Success', value: { output: { body } } });
			})
	);

	it.live.each([
		{ contentType: 'text/html; charset=windows-1252', prefix: '' },
		{
			contentType: 'text/html',
			prefix: '<meta http-equiv="content-type" content="text/html; charset=windows-1252">'
		}
	])('decodes the declared character encoding in $contentType', ({ contentType, prefix }) =>
		Effect.gen(function* () {
			const body = Buffer.concat([
				Buffer.from(prefix + '<p>Employer'),
				Buffer.from([0x92]),
				Buffer.from('s contribution</p>')
			]);
			const binding: Options = {
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: () => Effect.succeed({ status: 200, contentType, body })
			};
			expect(yield* read(binding, 'https://official.example/')).toMatchObject({
				_tag: 'Success',
				value: { output: { body: prefix + '<p>Employer’s contribution</p>' } }
			});
		})
	);

	const processEvents: Array<string> = [];
	it.live('reads application/csv datasets without losing multilingual cells', () =>
		Effect.gen(function* () {
			const body = '投保等級,月投保金額（元）\r\n1,29500\r\n';
			const binding: Options = {
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: () =>
					Effect.succeed({
						status: 200,
						contentType: 'application/csv',
						body: Buffer.from('\uFEFF' + body)
					})
			};
			expect(yield* read(binding, 'https://official.example/dataset')).toMatchObject({
				_tag: 'Success',
				value: { output: { body } }
			});
		})
	);

	const record = (cause: unknown) =>
		processEvents.push(cause instanceof Error ? cause.message : String(cause));
	beforeEach(() => {
		processEvents.length = 0;
		process.on('uncaughtException', record);
		process.on('unhandledRejection', record);
	});
	afterEach(() => {
		process.off('uncaughtException', record);
		process.off('unhandledRejection', record);
	});

	it.live(
		'answers the lookup on a later macrotask and prefers IPv4 when both families resolve',
		() =>
			Effect.gen(function* () {
				const attempts: Array<Attempt> = [];
				const binding: Options = {
					resolve: async () => [
						{ address: '2606:4700:4700::1111', family: 6 },
						{ address: '1.1.1.1', family: 4 }
					],
					request: makeRequestPage(makeFakeRequest(attempts))
				};
				const result = yield* read(binding, 'https://example.test/');
				expect(result._tag, JSON.stringify(result)).toBe('Success');
				expect(attempts).toEqual([{ address: '1.1.1.1', family: 4, deferred: true }]);
				expect(processEvents).toEqual([]);
			})
	);

	it.live('moves to the next address after a connect-phase failure and succeeds there', () =>
		Effect.gen(function* () {
			const attempts: Array<Attempt> = [];
			const binding: Options = {
				resolve: async () => [
					{ address: '2606:4700:4700::1111', family: 6 },
					{ address: '1.0.0.1', family: 4 },
					{ address: '1.1.1.1', family: 4 }
				],
				request: makeRequestPage(
					makeFakeRequest(attempts, '<h1>reached</h1>', (address) => address !== '1.1.1.1')
				)
			};
			const result = yield* read(binding, 'https://example.test/');
			expect(result._tag, JSON.stringify(result)).toBe('Success');
			expect(attempts.map((attempt) => attempt.address)).toEqual(['1.0.0.1', '1.1.1.1']);
			expect(attempts.every((attempt) => attempt.deferred)).toBe(true);
			expect(processEvents).toEqual([]);
		})
	);

	it.live('fails naming the last cause when every address fails to connect', () =>
		Effect.gen(function* () {
			const attempts: Array<Attempt> = [];
			const binding: Options = {
				resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
				request: makeRequestPage(makeFakeRequest(attempts))
			};
			const result = yield* read(binding, 'https://example.test/');
			expect(result).toMatchObject({
				_tag: 'Failure',
				error: {
					message: expect.stringContaining('last 2606:4700:4700::1111: connect ENETUNREACH')
				}
			});
			expect(attempts).toEqual([{ address: '2606:4700:4700::1111', family: 6, deferred: true }]);
			expect(processEvents).toEqual([]);
		})
	);

	/**
	 * The real `https.request` against real sockets: a peer that accepts and destroys at once,
	 * and a port nobody listens on. Both are answered as a rejected promise; neither reaches the
	 * process. The listener-less peer needs no certificate because the client never gets that far.
	 */
	it.live(
		'rejects cleanly on a listener-less peer that destroys the socket on connect, and on refusal',
		() =>
			Effect.gen(function* () {
				const server = yield* Effect.acquireRelease(
					Effect.sync(() => createServer((socket) => socket.destroy())),
					(server) =>
						Effect.promise(
							() =>
								new Promise<void>((resolve) => {
									server.close(() => resolve());
								})
						)
				);
				server.listen(0, '127.0.0.1');
				yield* Effect.tryPromise({
					try: () => once(server, 'listening'),
					catch: (error) => new FacilityFailure({ kind: 'upstream', message: String(error) })
				});
				const address = server.address();
				if (address === null || typeof address === 'string') throw new Error('no port');
				const url = new URL(`https://localhost:${address.port}/`);
				const requestPage = makeRequestPage();
				expect(
					yield* Effect.flip(
						requestPage(url, [{ address: '127.0.0.1', family: 4 }]).pipe(
							Effect.timeout('5 seconds')
						)
					)
				).toBeInstanceOf(Error);
				yield* Effect.promise(
					() =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						})
				);
				expect(
					yield* Effect.flip(
						requestPage(url, [
							{ address: '127.0.0.1', family: 4 },
							{ address: '127.0.0.1', family: 4 }
						]).pipe(Effect.timeout('5 seconds'))
					)
				).toMatchObject({
					message: expect.stringMatching(
						/could not be reached on any address; last 127\.0\.0\.1: connect ECONNREFUSED/
					)
				});
				yield* Effect.promise(
					() =>
						new Promise<void>((resolve) => {
							setImmediate(resolve);
						})
				);
				expect(processEvents).toEqual([]);
			})
	);
});
