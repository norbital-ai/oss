import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FacilityCall } from '@norbital-ai/bolt-protocol';
import {
	makeWebConnectorBinding,
	makeRequestPage,
	isPublicWebAddress
} from '../src/facilities/web.js';
import { WEB_PAGE_BYTE_LIMIT } from '@norbital-ai/bolt-protocol';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { request as httpsRequest } from 'node:https';
import { pdfFixture } from './helpers/pdf-fixture.js';

const metadata = {} as FacilityCall;
const signal = new AbortController().signal;
const read = (binding: ReturnType<typeof makeWebConnectorBinding>, url: string) =>
	binding.call(metadata, { connector: 'web', operation: 'web.read', input: { url } }, signal);

describe('public web connector', () => {
	it('extracts every PDF page with a digest of the original binary source', async () => {
		const body = pdfFixture(['RESIN-42 Melt flow 12 g/10 min', 'Density 0.92 g/cm3']);
		const binding = makeWebConnectorBinding({
			resolve: async () => [{ address: '1.1.1.1', family: 4 }],
			request: async () => ({ status: 200, contentType: 'application/pdf', body })
		});
		const result = await read(binding, 'https://supplier.example/resin.pdf');
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
	});

	it('refuses blank, corrupt and overlong PDFs instead of returning partial evidence', async () => {
		for (const body of [
			pdfFixture(['']),
			pdfFixture(['Valid first page', '']),
			new Uint8Array(Buffer.from('%PDF-1.7 broken')),
			pdfFixture(Array.from({ length: 201 }, () => 'text'))
		]) {
			const binding = makeWebConnectorBinding({
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: async () => ({ status: 200, contentType: 'application/pdf', body })
			});
			expect((await read(binding, 'https://supplier.example/data.pdf'))._tag).toBe('Failure');
		}
	});

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

	it('pins a checked address and returns the final URL after public redirects', async () => {
		const requests: string[] = [];
		const binding = makeWebConnectorBinding({
			resolve: async () => [{ address: '1.1.1.1', family: 4 }],
			request: async (url, addresses) => {
				expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
				requests.push(url.toString());
				return requests.length === 1
					? { status: 302, location: '/law', contentType: '', body: '' }
					: { status: 200, contentType: 'text/html', body: '<h1>New law</h1>' };
			}
		});
		expect(await read(binding, 'https://official.example/')).toEqual({
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
	});

	it('refuses redirected private networks before opening another socket', async () => {
		let requests = 0;
		const binding = makeWebConnectorBinding({
			resolve: async () => [{ address: '1.1.1.1', family: 4 }],
			request: async () => {
				requests++;
				return {
					status: 302,
					location: 'https://169.254.169.254/credentials',
					contentType: '',
					body: ''
				};
			}
		});
		expect((await read(binding, 'https://official.example/'))._tag).toBe('Failure');
		expect(requests).toBe(1);
	});

	it('refuses mixed DNS answers, non-HTTPS, credentials, binary bodies and oversized UTF-8', async () => {
		let requests = 0;
		const binding = makeWebConnectorBinding({
			resolve: async () => [
				{ address: '1.1.1.1', family: 4 },
				{ address: '10.0.0.1', family: 4 }
			],
			request: async () => {
				requests++;
				return { status: 200, contentType: 'text/plain', body: 'ok' };
			}
		});
		for (const url of [
			'https://example.test',
			'http://example.test',
			'https://user:pass@example.test',
			'https://example.test:8000'
		])
			expect((await read(binding, url))._tag).toBe('Failure');
		expect(requests).toBe(0);
		for (const response of [
			{ status: 200, contentType: 'application/pdf', body: 'pdf' },
			{ status: 500, contentType: 'text/plain', body: 'failed' },
			{ status: 200, contentType: 'text/plain', body: '文'.repeat(WEB_PAGE_BYTE_LIMIT / 2) }
		]) {
			const reader = makeWebConnectorBinding({
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: async () => response
			});
			expect((await read(reader, 'https://example.test'))._tag).toBe('Failure');
		}
	});
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
): FakeRequest =>
	((_url: unknown, options: Record<string, unknown>, onResponse: (response: unknown) => void) => {
		const req = Object.assign(new EventEmitter(), { end: () => undefined });
		let returned = false;
		const lookup = options['lookup'] as (
			hostname: string,
			options: unknown,
			callback: (error: null, address: string, family: number) => void
		) => void;
		lookup('example.test', {}, (_error, address, family) => {
			attempts.push({ address, family, deferred: returned });
			if (failing(address)) {
				req.emit('error', unroutable(address));
				return;
			}
			setImmediate(() =>
				onResponse(
					Object.assign(Readable.from([Buffer.from(body)]), {
						statusCode: 200,
						headers: { 'content-type': 'text/html', ...headers }
					})
				)
			);
		});
		returned = true;
		return req;
	}) as unknown as FakeRequest;

describe('public web connector address selection', () => {
	it.each([false, true])(
		'decodes unsolicited gzip within the byte limit (oversized: %s)',
		async (oversized) => {
			const body = oversized
				? 'x'.repeat(WEB_PAGE_BYTE_LIMIT + 1)
				: '<h1>Thuế thu nhập cá nhân</h1>';
			const binding = makeWebConnectorBinding({
				resolve: async () => [{ address: '1.1.1.1', family: 4 }],
				request: makeRequestPage(
					makeFakeRequest([], gzipSync(body), () => false, {
						'content-encoding': 'gzip',
						'content-type': 'text/html; charset=utf-8'
					})
				)
			});
			const result = await read(binding, 'https://official.example/');
			if (oversized) expect(result._tag).toBe('Failure');
			else expect(result).toMatchObject({ _tag: 'Success', value: { output: { body } } });
		}
	);

	it.each([
		{ contentType: 'text/html; charset=windows-1252', prefix: '' },
		{
			contentType: 'text/html',
			prefix: '<meta http-equiv="content-type" content="text/html; charset=windows-1252">'
		}
	])('decodes the declared character encoding in $contentType', async ({ contentType, prefix }) => {
		const body = Buffer.concat([
			Buffer.from(prefix + '<p>Employer'),
			Buffer.from([0x92]),
			Buffer.from('s contribution</p>')
		]);
		const binding = makeWebConnectorBinding({
			resolve: async () => [{ address: '1.1.1.1', family: 4 }],
			request: async () => ({ status: 200, contentType, body })
		});
		expect(await read(binding, 'https://official.example/')).toMatchObject({
			_tag: 'Success',
			value: { output: { body: prefix + '<p>Employer’s contribution</p>' } }
		});
	});

	const processEvents: Array<string> = [];
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

	it('answers the lookup on a later macrotask and prefers IPv4 when both families resolve', async () => {
		const attempts: Array<Attempt> = [];
		const binding = makeWebConnectorBinding({
			resolve: async () => [
				{ address: '2606:4700:4700::1111', family: 6 },
				{ address: '1.1.1.1', family: 4 }
			],
			request: makeRequestPage(makeFakeRequest(attempts))
		});
		const result = await read(binding, 'https://example.test/');
		expect(result._tag).toBe('Success');
		expect(attempts).toEqual([{ address: '1.1.1.1', family: 4, deferred: true }]);
		expect(processEvents).toEqual([]);
	});

	it('moves to the next address after a connect-phase failure and succeeds there', async () => {
		const attempts: Array<Attempt> = [];
		const binding = makeWebConnectorBinding({
			resolve: async () => [
				{ address: '2606:4700:4700::1111', family: 6 },
				{ address: '1.0.0.1', family: 4 },
				{ address: '1.1.1.1', family: 4 }
			],
			request: makeRequestPage(
				makeFakeRequest(attempts, '<h1>reached</h1>', (address) => address !== '1.1.1.1')
			)
		});
		const result = await read(binding, 'https://example.test/');
		expect(result._tag).toBe('Success');
		expect(attempts.map((attempt) => attempt.address)).toEqual(['1.0.0.1', '1.1.1.1']);
		expect(attempts.every((attempt) => attempt.deferred)).toBe(true);
		expect(processEvents).toEqual([]);
	});

	it('returns web.read_failed naming the last cause when every address fails to connect', async () => {
		const attempts: Array<Attempt> = [];
		const binding = makeWebConnectorBinding({
			resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
			request: makeRequestPage(makeFakeRequest(attempts))
		});
		const result = await read(binding, 'https://example.test/');
		expect(result).toMatchObject({
			_tag: 'Failure',
			error: {
				code: 'web.read_failed',
				message: expect.stringContaining('last 2606:4700:4700::1111: connect ENETUNREACH')
			}
		});
		expect(attempts).toEqual([{ address: '2606:4700:4700::1111', family: 6, deferred: true }]);
		expect(processEvents).toEqual([]);
	});

	/**
	 * The real `https.request` against real sockets: a peer that accepts and destroys at once,
	 * and a port nobody listens on. Both are answered as a rejected promise; neither reaches the
	 * process. The listener-less peer needs no certificate because the client never gets that far.
	 */
	it('rejects cleanly on a listener-less peer that destroys the socket on connect, and on refusal', async () => {
		const server = createServer((socket) => socket.destroy());
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const url = new URL(`https://localhost:${address.port}/`);
		const requestPage = makeRequestPage();
		const signal = AbortSignal.timeout(5_000);
		try {
			await expect(
				requestPage(url, [{ address: '127.0.0.1', family: 4 }], signal)
			).rejects.toBeInstanceOf(Error);
		} finally {
			server.close();
			await once(server, 'close');
		}
		await expect(
			requestPage(
				url,
				[
					{ address: '127.0.0.1', family: 4 },
					{ address: '127.0.0.1', family: 4 }
				],
				signal
			)
		).rejects.toThrow(
			/could not be reached on any address; last 127\.0\.0\.1: connect ECONNREFUSED/
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(processEvents).toEqual([]);
	});
});
