import { describe, expect, it } from 'vitest';
import type { FacilityCall } from '@norbital-ai/bolt-protocol';
import { makeWebConnectorBinding, isPublicWebAddress } from '../src/facilities/web.js';
import { WEB_PAGE_BYTE_LIMIT } from '@norbital-ai/bolt-protocol';

const metadata = {} as FacilityCall;
const signal = new AbortController().signal;
const read = (binding: ReturnType<typeof makeWebConnectorBinding>, url: string) =>
	binding.call(metadata, { connector: 'web', operation: 'web.read', input: { url } }, signal);

describe('public web connector', () => {
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
			request: async (url, address) => {
				expect(address).toEqual({ address: '1.1.1.1', family: 4 });
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
					body: '<h1>New law</h1>'
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
