import { createServer } from 'node:http';
import { expect, it } from '@effect/vitest';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { ConfigProvider, Effect, Option } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { devConverter } from '../src/cli/dev.ts';

const configured = (settings: Readonly<Record<string, string>>) =>
	devConverter.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings))));

it.effect(
	'leaves conversion unavailable without a configured provider and refuses incomplete settings',
	() =>
		Effect.gen(function* () {
			expect(Option.isNone(yield* configured({}))).toBe(true);
			expect(yield* Effect.flip(configured({ BOLT_CONVERT_CREDENTIAL: 'test' }))).toMatchObject({
				message: expect.stringContaining('without BOLT_CONVERT_PROVIDER')
			});
			expect(yield* Effect.flip(configured({ BOLT_CONVERT_PROVIDER: 'unknown' }))).toMatchObject({
				message: expect.stringContaining('must be norbital')
			});
			expect(yield* Effect.flip(configured({ BOLT_CONVERT_PROVIDER: 'norbital' }))).toMatchObject({
				message: expect.stringContaining('needs BOLT_CONVERT_ENDPOINT')
			});
			expect(
				yield* Effect.flip(
					configured({
						BOLT_CONVERT_PROVIDER: 'norbital',
						BOLT_CONVERT_ENDPOINT: 'file:///tmp/convert',
						BOLT_CONVERT_CREDENTIAL: 'test'
					})
				)
			).toMatchObject({ message: expect.stringContaining('HTTP or HTTPS') });
		})
);

it.live('binds the native converter using the configured endpoint and credential', () =>
	Effect.gen(function* () {
		const requests: {
			url: string;
			headers: { authorization: string | undefined; 'content-type': string | undefined };
			body: string;
		}[] = [];
		const server = yield* NodeHttpServer.make(() => createServer(), { host: '127.0.0.1', port: 0 });
		yield* server.serve(
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				requests.push({
					url: request.url,
					headers: {
						authorization: request.headers['authorization'],
						'content-type': request.headers['content-type']
					},
					body: yield* request.text
				});
				return HttpServerResponse.text('event: result\ndata: {"bytes":"JVBERi0="}\n\n', {
					contentType: 'text/event-stream'
				});
			})
		);
		if (server.address._tag !== 'TcpAddress')
			return yield* Effect.die('The converter fixture has no TCP address.');
		const endpoint = `http://127.0.0.1:${server.address.port}/`;
		const converter = yield* configured({
			BOLT_CONVERT_PROVIDER: 'norbital',
			BOLT_CONVERT_ENDPOINT: endpoint,
			BOLT_CONVERT_CREDENTIAL: 'test'
		});
		if (Option.isNone(converter))
			return yield* Effect.die('The configured converter is unavailable.');
		const result = yield* converter.value.convert({ html: '<p>Agreement</p>' }, 'pdf', {
			page: 'A4'
		});
		expect(new TextDecoder().decode(result)).toBe('%PDF-');
		expect(requests).toEqual([
			{
				url: '/v1/convert',
				headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
				body: JSON.stringify({ from: 'html', source: '<p>Agreement</p>', to: 'pdf', page: 'A4' })
			}
		]);
	}).pipe(Effect.provide(NodeHttpServer.layerHttpServices))
);
