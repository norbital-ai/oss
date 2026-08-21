import { describe, expect, it } from 'vitest';
import {
	ToolNotAllowed,
	resolveTool,
	mcpToolName,
	parseMcpToolName
} from '../../src/runtime/agents/agents.js';

describe('Agents tools and MCP owners', () => {
	it('enforces the authored tool allowlist', () =>
		expect(resolveTool([], 'web', 'missing')).toBeInstanceOf(ToolNotAllowed));
	it('round trips neutral MCP tool names', () =>
		expect(parseMcpToolName(mcpToolName('crm', 'search'))).toEqual({
			server: 'crm',
			tool: 'search'
		}));
});
