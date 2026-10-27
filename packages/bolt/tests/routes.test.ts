import { Effect, Schema, SchemaTransformation } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { describe, expect, it } from '@effect/vitest';
import { BoltRoutes, requestBody } from '../src/protocol/http.ts';
import { ORDER } from '../src/protocol/host.ts';

describe('host route contract', () => {
	it.effect('keeps hooks, shell, integrations, files and Bolt in the admission order', () =>
		Effect.sync(() => {
			expect(ORDER).toEqual(['hooks', 'shell', 'integrations', 'files', 'bolt']);
			expect(Object.keys(BoltRoutes)).toEqual([
				'POST /__bolt/q',
				'POST /__bolt/act',
				'GET /__bolt/live',
				'GET /__bolt/notices',
				'POST /__bolt/live',
				'POST /__bolt/push',
				'GET /__bolt/agent/models',
				'GET /__bolt/agent',
				'GET /__bolt/approval',
				'GET /__bolt/record-capabilities',
				'GET /__bolt/openapi.json'
			]);
		})
	);
	it.effect('decodes a request once when admission and its route both consume it', () =>
		Effect.gen(function* () {
			let decodes = 0;
			const Input = Schema.Struct({ value: Schema.Number }).pipe(
				Schema.decodeTo(
					Schema.Struct({ value: Schema.Number }),
					SchemaTransformation.transform({
						decode: (value: { readonly value: number }) => {
							decodes++;
							return value;
						},
						encode: (value: { readonly value: number }) => value
					})
				)
			);
			const request = HttpServerRequest.fromWeb(
				new Request('https://workspace.test/__bolt/q', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{"value":7}'
				})
			);
			expect(yield* requestBody(request, Input)).toEqual({ value: 7 });
			expect(yield* requestBody(request, Input)).toEqual({ value: 7 });
			expect(decodes).toBe(1);
		})
	);
});
