import { Effect, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	callMcpTool,
	MCP_PROTOCOL_VERSION
} from '../src/runtime/agents/capability-catalog.js';
import { FacilityError } from '../src/runtime/facilities/database.js';

const JsonRpcRequest = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
	method: Schema.NonEmptyString,
	params: Schema.optionalKey(Schema.Json)
});

describe('official MCP 2026 tool adapter', () => {
	it.effect('pins 2026-07-28 and preserves the official complete result', () =>
		Effect.gen(function* () {
			const methods: Array<string> = [];
			const result = yield* callMcpTool(
				{ server: 'search', url: 'https://mcp.example.test', tool: 'lookup' },
				{ q: 'payroll' },
				EffectId.make('mcp-content'),
				{
					execute: (_effectId, request) =>
						Effect.gen(function* () {
							const input = yield* Schema.decodeUnknownEffect(
								Schema.Struct({ body: JsonRpcRequest })
							)(request.input).pipe(
								Effect.mapError(
									(cause) =>
										new FacilityError({
											operation: 'connector',
											code: 'invalid_fixture_request',
											message: String(cause),
											retryable: false,
											outcome: 'known'
										})
								)
							);
							methods.push(input.body.method);
							if (input.body.method === 'server/discover') {
								return {
									output: {
										status: 200,
										headers: { 'content-type': 'application/json' },
										body: {
											jsonrpc: '2.0',
											id: input.body.id ?? null,
											result: {
												supportedVersions: [MCP_PROTOCOL_VERSION],
												capabilities: { tools: {} }
											}
										}
									}
								};
							}
							return {
								output: {
									status: 200,
									headers: { 'content-type': 'application/json' },
									body: {
										jsonrpc: '2.0',
									id: input.body.id ?? null,
									result: {
										resultType: 'complete',
										content: [{ type: 'text', text: 'Two hits' }],
											structuredContent: { hits: 2 }
										}
									}
								}
							};
						})
				}
			);
			expect(methods).toEqual(['server/discover', 'tools/call']);
			expect(result).toEqual({
				content: [{ type: 'text', text: 'Two hits' }],
				structuredContent: { hits: 2 }
			});
		})
	);
});
