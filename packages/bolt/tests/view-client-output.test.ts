// A model view (a board's lanes, a model table, a map) reads the caller's view output, as `query` and `aggregate` do:
// a member who holds only a named output reads that one, never the `default` it does not hold.
import { Effect, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/http';
import { create_bolt } from '../src/page/bolt.ts';
import { view_client } from '../src/page/view-client.ts';

const QBody = Schema.Struct({ reads: Schema.Array(Schema.Unknown) });

it.effect('a model view reads the output the catalog gives the caller', () =>
	Effect.gen(function* () {
		const sent: HttpClientRequest.HttpClientRequest[] = [];
		const http_client = HttpClient.make((request) => {
			sent.push(request);
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json({
						answers: [{ customers: { rows: [{ id: 'c1', name: 'Acme' }], next: null, total: 1 } }]
					})
				)
			);
		});
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			http_client
		});
		const view = view_client(
			bolt,
			{
				customers: {
					directory: {
						customers: {
							model: 'customers',
							many: false,
							list_fields: ['name'],
							fields: { id: { kind: 'text' }, name: { kind: 'text' } }
						}
					}
				}
			},
			{ customers: { label: ['name'], fields: { name: { kind: 'text' } }, output: 'directory' } }
		);
		const answer = yield* view.model_query('customers', { customers: { limit: 1 } }, 'list');
		expect(answer['customers']?.rows).toEqual([{ id: 'c1', name: 'Acme' }]);
		const body = sent[0]?.body;
		if (body?._tag !== 'Uint8Array') throw new Error('expected a JSON read body');
		const reads = Schema.decodeUnknownSync(QBody)(
			JSON.parse(new TextDecoder().decode(body.body))
		).reads;
		expect(reads[0]).toMatchObject({ m: 'query', a: [{ customers: { output: 'directory' } }] });
	})
);
