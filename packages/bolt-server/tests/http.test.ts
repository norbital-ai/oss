import { expect, it } from 'vitest';
import { WEB_PAGE_BYTE_LIMIT, type FacilityCall } from '@norbital-ai/bolt-protocol';
import { makeManagedHttpConnectorBinding } from '../src/facilities/http.js';

const metadata = {} as FacilityCall;
const publicAddress = async () => [{ address: '1.1.1.1', family: 4 }];
const call = (
	binding: ReturnType<typeof makeManagedHttpConnectorBinding>,
	input: {
		url?: string;
		method?: 'GET' | 'POST' | 'PATCH';
		headers?: Record<string, string>;
		body?: Record<string, number>;
	} = {},
	signal = new AbortController().signal
) =>
	binding.call(
		metadata,
		{
			connector: 'http',
			operation: 'http.request',
			input: {
				method: input.method ?? 'GET',
				url: input.url ?? 'https://api.example.test/calendar/events',
				headers: input.headers ?? { 'X-Api-Key': 'private-key' },
				...(input.body === undefined ? {} : { body: input.body })
			}
		},
		signal
	);

it('pins DNS, passes managed credentials and preserves JSON, non-JSON and non-2xx responses', async () => {
	for (const [status, body, expected] of [
		[200, '{"items":[]}', { items: [] }],
		[429, '{"error":"quota"}', { error: 'quota' }],
		[503, 'provider unavailable', 'provider unavailable']
	] as const) {
		const binding = makeManagedHttpConnectorBinding({
			resolve: publicAddress,
			request: async (url, addresses, signal, headers) => {
				expect(url.origin).toBe('https://api.example.test');
				expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
				expect(signal.aborted).toBe(false);
				expect(headers).toEqual({ accept: 'application/json', 'X-Api-Key': 'private-key' });
				return { status, body, contentType: 'application/json', headers: { 'retry-after': '60' } };
			}
		});
		expect(await call(binding)).toEqual({
			_tag: 'Success',
			value: { output: { status, headers: { 'retry-after': '60' }, body: expected } }
		});
	}
});

it('follows redirects as GET and drops caller headers on a cross-origin hop', async () => {
	const seen: Array<{ url: string; headers: unknown; write: unknown }> = [];
	const binding = makeManagedHttpConnectorBinding({
		resolve: publicAddress,
		request: async (url, _addresses, _signal, headers, write) => {
			seen.push({ url: url.toString(), headers, write });
			return seen.length === 1
				? {
						status: 302,
						location: 'https://echo.example/answer',
						contentType: '',
						body: ''
					}
				: { status: 200, contentType: 'application/json', body: '{"ok":true}' };
		}
	});
	expect(await call(binding, { method: 'POST', body: { a: 1 } })).toMatchObject({
		_tag: 'Success',
		value: { output: { status: 200, body: { ok: true } } }
	});
	expect(seen).toEqual([
		{
			url: 'https://api.example.test/calendar/events',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'X-Api-Key': 'private-key'
			},
			write: { method: 'POST', body: '{"a":1}' }
		},
		{ url: 'https://echo.example/answer', headers: { accept: 'application/json' }, write: undefined }
	]);
});

it('reaches loopback names only when the host allows it', async () => {
	const request = async () => ({ status: 200, contentType: '', body: '' });
	const loopback = async () => [{ address: '127.0.0.1', family: 4 }];
	const input = { url: 'http://sap.localhost:4182/__bolt/request/api/products' };
	expect(
		(await call(makeManagedHttpConnectorBinding({ resolve: loopback, request }), input))._tag
	).toBe('Failure');
	expect(
		(
			await call(
				makeManagedHttpConnectorBinding({ resolve: loopback, request, allowLoopback: true }),
				input
			)
		)._tag
	).toBe('Success');
	expect(
		(
			await call(
				makeManagedHttpConnectorBinding({ resolve: publicAddress, request, allowLoopback: true }),
				input
			)
		)._tag
	).toBe('Failure');
});

it('refuses private or mixed DNS, custom ports, credentials and header overrides', async () => {
	let requests = 0;
	const request = async () => {
		requests++;
		return { status: 200, contentType: '', body: '' };
	};
	for (const addresses of [
		[{ address: '127.0.0.1', family: 4 }],
		[
			{ address: '1.1.1.1', family: 4 },
			{ address: '10.0.0.1', family: 4 }
		]
	]) {
		expect(
			(await call(makeManagedHttpConnectorBinding({ resolve: async () => addresses, request })))
				._tag
		).toBe('Failure');
	}
	const binding = makeManagedHttpConnectorBinding({ resolve: publicAddress, request });
	for (const input of [
		{ url: 'http://api.example.test/' },
		{ url: 'https://user:secret@api.example.test/' },
		{ url: 'https://api.example.test:8443/' },
		{ url: 'https://169.254.169.254/' },
		{ url: 'https://[::ffff:127.0.0.1]/' },
		{ headers: { Host: 'another.example' } },
		{ headers: { 'Proxy-Authorization': 'private-key' } }
	])
		expect((await call(binding, input))._tag).toBe('Failure');
	expect(requests).toBe(0);
});

it('bounds bytes, redacts transport failures and cancels while DNS is pending', async () => {
	const oversized = makeManagedHttpConnectorBinding({
		resolve: publicAddress,
		request: async () => ({
			status: 200,
			contentType: 'text/plain',
			body: 'é'.repeat(WEB_PAGE_BYTE_LIMIT)
		})
	});
	expect((await call(oversized))._tag).toBe('Failure');
	const broken = makeManagedHttpConnectorBinding({
		resolve: publicAddress,
		request: async () => {
			throw new Error('bad header private-key');
		}
	});
	const result = await call(broken);
	// A transport failure is worth retrying; a refused request (above) never is.
	expect(result).toMatchObject({ _tag: 'Failure', error: { retryable: true } });
	expect(JSON.stringify(result)).not.toContain('private-key');
	const controller = new AbortController();
	let started: () => void = () => {};
	const resolving = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pending = makeManagedHttpConnectorBinding({
		resolve: () => {
			started();
			return new Promise(() => {});
		}
	});
	const operation = call(pending, {}, controller.signal);
	await resolving;
	controller.abort();
	expect((await operation)._tag).toBe('Failure');
});
