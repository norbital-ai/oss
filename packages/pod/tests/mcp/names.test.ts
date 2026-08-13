import { describe, expect, it } from 'vitest';
import {
	isMcpServerName,
	parsePublicMcpToolName,
	publicMcpToolName
} from '../../src/mcp/names.js';

describe('MCP public tool names', () => {
	it('qualifies server and raw tool names for the model', () => {
		expect(publicMcpToolName('stripe', 'list_customers')).toBe('mcp__stripe__list_customers');
		expect(parsePublicMcpToolName('mcp__stripe__list_customers')).toEqual({
			server: 'stripe',
			tool: 'list_customers'
		});
		expect(parsePublicMcpToolName('read_collection')).toBeNull();
	});

	it('accepts only lower_snake_case server ids within the length limit', () => {
		expect(isMcpServerName('stripe')).toBe(true);
		expect(isMcpServerName('Stripe')).toBe(false);
		expect(isMcpServerName('abcdefghijklmnopqrstuvwxyz1234567')).toBe(false);
	});
});
