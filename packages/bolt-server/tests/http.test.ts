import { expect, it } from 'vitest';
import { WEB_PAGE_BYTE_LIMIT, type FacilityCall } from '@norbital-ai/bolt-protocol';
import { makeManagedHttpConnectorBinding } from '../src/facilities/http.js';

const metadata = {} as FacilityCall;
const publicAddress = async () => [{ address: '1.1.1.1', family: 4 }];
const call = (
	binding: ReturnType<typeof makeManagedHttpConnectorBinding>,
	input: { url?: string; method?: 'GET' | 'POST'; headers?: Record<string, string> } = {},
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
				headers: input.headers ?? { 'X-Api-Key': 'private-key' }
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

it('never forwards authentication through provider redirects', async () => {
	let requests = 0;
	const binding = makeManagedHttpConnectorBinding({
		resolve: publicAddress,
		request: async () => {
			requests++;
			return {
				status: 302,
				location: 'https://attacker.example/collect',
				headers: { location: 'https://attacker.example/collect' },
				contentType: '',
				body: ''
			};
		}
	});
	expect(await call(binding)).toMatchObject({
		_tag: 'Success',
		value: { output: { status: 302 } }
	});
	expect(requests).toBe(1);
});

it('refuses private or mixed DNS, custom ports, credentials, header overrides and writes', async () => {
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
		{ headers: { 'Proxy-Authorization': 'private-key' } },
		{ method: 'POST' as const }
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
	expect(result._tag).toBe('Failure');
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
