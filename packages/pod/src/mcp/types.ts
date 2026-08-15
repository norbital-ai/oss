/**
 * Workspace-authored MCP server and the 2026-07-28 wire shapes Pod understands.
 *
 * Tools are the only capability offered to the model in this slice. Resources and prompts use the
 * same client and load like skills — names first, bodies on demand — once a workspace asks for them.
 * Elicitation uses Multi Round-Trip Requests: the server returns `input_required`, the client
 * retries with `inputResponses`. There is no protocol session and no held-open stream.
 */

export type McpServerDefinition = {
	/** What this server is for. Carried into the manifest. */
	readonly description: string;
	/** Streamable HTTP endpoint speaking MCP 2026-07-28. */
	readonly url: string;
	/**
	 * Tool names this workspace may call, using the server's own names.
	 *
	 * Required and non-empty. Dumping a server's full catalog into every turn is how GitHub-class
	 * MCP servers blow the context window; naming tools here is the same opt-in as `hostTools`.
	 */
	readonly tools: readonly string[];
	/** Extra request headers. Do not put secrets in source. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
};

export type { AiToolSpec as McpToolDefinition } from '@norbital-ai/platform-utils/runtime/binding';

export type McpTextContent = {
	readonly type: 'text';
	readonly text: string;
};

export type McpContentBlock =
	McpTextContent | { readonly type: string; readonly [key: string]: unknown };

export type McpToolSuccess = {
	readonly resultType: 'success';
	readonly content: readonly McpContentBlock[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
};

export type McpElicitationRequest = {
	readonly id: string;
	readonly message: string;
	readonly mode?: 'form' | 'url';
	readonly schema?: unknown;
	readonly url?: string;
};

export type McpInputRequired = {
	readonly resultType: 'input_required';
	readonly requests: readonly McpElicitationRequest[];
};

export type McpToolResult = McpToolSuccess | McpInputRequired;

export type McpJsonRpcSuccess = {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly result: unknown;
};

export type McpJsonRpcError = {
	readonly jsonrpc: '2.0';
	readonly id: number | string | null;
	readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
};

export type McpJsonRpcResponse = McpJsonRpcSuccess | McpJsonRpcError;
