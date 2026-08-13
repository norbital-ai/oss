import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import type { McpServerDefinition } from '$lib/mcp/types.js';
import { createMcpClient } from '$lib/mcp/client.js';
import { parsePublicMcpToolName, publicMcpToolName } from '$lib/mcp/names.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { AiToolSpec } from '@norbital-ai/platform-utils/runtime/binding';

const client = createMcpClient();

export type ResolvedMcpTools = {
	readonly specs: readonly AiToolSpec[];
	readonly names: ReadonlySet<string>;
};

/**
 * MCP tools this run may call, described for the model.
 *
 * Default deny: a server is offered only when the spec names it in `mcpServers`. Interactive
 * fallback names every declared server the same way it names every host tool. A server that cannot
 * be reached is omitted rather than taking the whole turn down — the model sees a smaller tool
 * list, not a failed conversation.
 */
export async function resolveMcpToolSpecs(
	spec: AgentAutomationSpec,
	taken: ReadonlySet<string>
): Promise<ResolvedMcpTools> {
	const named = spec.mcpServers ?? [];
	if (named.length === 0) return { specs: [], names: new Set() };
	const declared = getTenantWorkspace().registered.mcpServers ?? {};
	const specs: AiToolSpec[] = [];
	const names = new Set<string>();
	for (const serverName of named) {
		const definition = declared[serverName];
		if (!definition) throw new Error(`Agent references unknown MCP server: ${serverName}`);
		const allowed = new Set(definition.tools);
		let listed: readonly { name: string; description: string; inputSchema: unknown }[];
		try {
			listed = await client.listTools(definition);
		} catch (cause) {
			console.warn(
				`[pod] MCP server ${serverName} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
			);
			continue;
		}
		for (const tool of listed) {
			if (!allowed.has(tool.name)) continue;
			const publicName = publicMcpToolName(serverName, tool.name);
			if (taken.has(publicName) || names.has(publicName)) {
				throw new Error(
					`MCP tool ${publicName} collides with another tool of the same name; the agent cannot tell them apart`
				);
			}
			names.add(publicName);
			specs.push({
				name: publicName,
				description: `${definition.description} — ${tool.description}`,
				inputSchema: tool.inputSchema
			});
		}
	}
	return { specs, names };
}

export async function executeMcpTool(
	spec: AgentAutomationSpec,
	callName: string,
	input: unknown
): Promise<Record<string, unknown>> {
	const parsed = parsePublicMcpToolName(callName);
	if (!parsed) throw new Error(`Not an MCP tool: ${callName}`);
	if (!(spec.mcpServers ?? []).includes(parsed.server)) {
		throw new Error(`Agent cannot call MCP server ${parsed.server}`);
	}
	const definition = (getTenantWorkspace().registered.mcpServers ?? {})[parsed.server];
	if (!definition) throw new Error(`Unknown MCP server: ${parsed.server}`);
	if (!definition.tools.includes(parsed.tool)) {
		throw new Error(`MCP server ${parsed.server} does not allow tool ${parsed.tool}`);
	}
	const args = isRecord(input) ? input : {};
	const result = await client.callTool(definition, parsed.tool, args);
	if (result.resultType === 'input_required') {
		return { resultType: 'input_required', requests: result.requests };
	}
	if (result.isError) {
		throw new Error(textFromContent(result.content) || `MCP tool ${callName} returned an error`);
	}
	return {
		resultType: 'success',
		text: textFromContent(result.content),
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent })
	};
}

export function isResolvedMcpTool(name: string, resolved: ReadonlySet<string>): boolean {
	return resolved.has(name);
}

export function declaredMcpServerNames(): readonly string[] {
	return Object.keys(getTenantWorkspace().registered.mcpServers ?? {});
}

export function mcpServerDefinition(name: string): McpServerDefinition | undefined {
	return (getTenantWorkspace().registered.mcpServers ?? {})[name];
}

function textFromContent(content: readonly { readonly type: string; readonly text?: string }[]): string {
	return content
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
