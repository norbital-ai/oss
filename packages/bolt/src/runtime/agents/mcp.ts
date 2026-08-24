import { Effect, Schema } from 'effect';
import type { EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import type { McpToolRoute } from '#lib/authoring/workspace-schema.js';
import type { ConnectorInterface } from '#lib/runtime/facilities/services.js';
import {
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpResponse
} from '#lib/runtime/integrations/http.js';
import { McpToolError } from '#lib/runtime/agents/agent-errors.js';

/** Protocol version spoken by Bolt's stateless MCP client. */
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;

const McpRequestId = Schema.Union([Schema.String, Schema.Number]);
const McpArguments = Schema.Union([Schema.JsonObject, Schema.Null]);

/** Required MCP v2 request metadata, carried on every JSON-RPC request. */
export const McpRequestMeta = Schema.Struct({
	'io.modelcontextprotocol/protocolVersion': Schema.Literal(MCP_PROTOCOL_VERSION),
	'io.modelcontextprotocol/clientCapabilities': Schema.JsonObject
});
export interface McpRequestMeta extends Schema.Schema.Type<typeof McpRequestMeta> {}

/** The MCP 2026-07-28 `tools/call` request Bolt sends through its connector facility. */
export const McpCallToolRequest = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: McpRequestId,
	method: Schema.Literal('tools/call'),
	params: Schema.Struct({
		_meta: McpRequestMeta,
		name: Schema.NonEmptyString,
		arguments: Schema.JsonObject
	})
});
export interface McpCallToolRequest extends Schema.Schema.Type<typeof McpCallToolRequest> {}

const McpContentBlock = Schema.StructWithRest(Schema.Struct({ type: Schema.NonEmptyString }), [
	Schema.JsonObject
]);
const McpCompleteResult = Schema.Struct({
	resultType: Schema.Literal('complete'),
	content: Schema.Array(McpContentBlock),
	structuredContent: Schema.optionalKey(Schema.JsonObject),
	isError: Schema.optionalKey(Schema.Boolean),
	_meta: Schema.optionalKey(Schema.JsonObject)
});
const McpInputRequiredResult = Schema.StructWithRest(
	Schema.Struct({ resultType: Schema.Literal('input_required') }),
	[Schema.JsonObject]
);

/** A successful MCP v2 tools response, including elicitation when the server needs more input. */
export const McpCallToolResult = Schema.Union([McpCompleteResult, McpInputRequiredResult]);
export type McpCallToolResult = typeof McpCallToolResult.Type;

const McpCallToolSuccess = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: McpRequestId,
	result: McpCallToolResult
});
const McpCallToolFailure = Schema.Struct({
	jsonrpc: Schema.Literal('2.0'),
	id: Schema.Union([McpRequestId, Schema.Null]),
	error: Schema.Struct({
		code: Schema.Number,
		message: Schema.NonEmptyString,
		data: Schema.optionalKey(Schema.Json)
	})
});

/** Every JSON-RPC response accepted from an authored MCP v2 server. */
export const McpCallToolResponse = Schema.Union([McpCallToolSuccess, McpCallToolFailure]);
export type McpCallToolResponse = typeof McpCallToolResponse.Type;

const decodeArguments = (input: Schema.Json, route: McpToolRoute) =>
	Schema.decodeUnknownEffect(McpArguments)(input).pipe(
		Effect.mapError(
			() =>
				new McpToolError({
					server: route.server,
					tool: route.tool,
					reason: 'invalid-input',
					detail: 'MCP tool arguments must be a JSON object'
				})
		)
	);

const decodeResponse = (input: unknown, route: McpToolRoute) =>
	Schema.decodeUnknownEffect(McpCallToolResponse)(input).pipe(
		Effect.mapError(
			() =>
				new McpToolError({
					server: route.server,
					tool: route.tool,
					reason: 'invalid-response',
					detail: 'The server returned a value outside the MCP v2 tools/call schema'
				})
		)
	);

/** Executes one declared remote tool through the existing host-governed connector boundary. */
export const callMcpTool = Effect.fn('Agents.callMcpTool')(function* (
	route: McpToolRoute,
	input: Schema.Json,
	effectId: EffectIdType,
	connector: ConnectorInterface
) {
	const decodedArguments = yield* decodeArguments(input, route);
	const request = McpCallToolRequest.make({
		jsonrpc: '2.0',
		id: effectId,
		method: 'tools/call',
		params: {
			_meta: {
				'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
				'io.modelcontextprotocol/clientCapabilities': {}
			},
			name: route.tool,
			arguments: decodedArguments === null ? {} : decodedArguments
		}
	});
	const response = yield* connector.execute(effectId, {
		connector: route.server,
		operation: INTEGRATION_HTTP_OPERATION,
		input: {
			method: 'POST',
			url: route.url,
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'mcp-protocol-version': MCP_PROTOCOL_VERSION
			},
			body: request
		}
	});
	const http = yield* Schema.decodeUnknownEffect(IntegrationHttpResponse)(response.output).pipe(
		Effect.mapError(
			() =>
				new McpToolError({
					server: route.server,
					tool: route.tool,
					reason: 'invalid-response',
					detail: 'The connector did not return an HTTP response'
				})
		)
	);
	if (http.status < 200 || http.status >= 300) {
		return yield* new McpToolError({
			server: route.server,
			tool: route.tool,
			reason: 'http-status',
			detail: `MCP server returned HTTP ${http.status}`
		});
	}
	const decoded = yield* decodeResponse(http.body, route);
	if (decoded.id !== request.id) {
		return yield* new McpToolError({
			server: route.server,
			tool: route.tool,
			reason: 'invalid-response',
			detail: 'The MCP response id does not match its request'
		});
	}
	if ('error' in decoded) {
		return yield* new McpToolError({
			server: route.server,
			tool: route.tool,
			reason: 'protocol-error',
			detail: `${decoded.error.code}: ${decoded.error.message}`
		});
	}
	return decoded.result;
});
