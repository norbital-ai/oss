import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { readPublicPage } from '../src/web.ts';
import { createHash } from 'node:crypto';

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
					{ status: 200, contentType: 'text/plain', body: '文'.repeat(1024 * 1024) }
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

describe('public web connector decoding', () => {
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
});
