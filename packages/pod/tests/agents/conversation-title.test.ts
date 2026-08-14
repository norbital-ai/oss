import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	conversationTitleFromProviderText,
	generateConversationTitle
} from '../../src/server/agent/conversation-title.server.js';

describe('AI conversation titles', () => {
	it('uses structured model output for a concise first-message title', () => {
		expect(
			conversationTitleFromProviderText(
				JSON.stringify({ title: 'Diagnose payroll import failures' })
			)
		).toBe('Diagnose payroll import failures');
	});

	it('accepts a plain-text provider response without repeatedly billing retries', () => {
		expect(conversationTitleFromProviderText('“Review CRM quote permissions.”')).toBe(
			'Review CRM quote permissions'
		);
	});

	it('refuses to call the model without a durable receipt replay store', () => {
		expect(() =>
			generateConversationTitle('Why did the payroll import fail for August?')
		).toThrow(/requires a durable step/);
	});

	it('does not generate titles from inside the agent loop', () => {
		const source = readFileSync(
			new URL('../../src/server/agent/agent-loop.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('runPendingConversationTitle');
		expect(source).not.toContain('conversation-title.server');
	});

	it('does not hold the guest admit on a provider chat', () => {
		const source = readFileSync(
			new URL('../../src/server/agent/conversation-title.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('ai.chat');
		expect(source).not.toContain("requireRuntimeFacility('ai')");
		expect(source).toContain('replayAutomationAi');
	});
});
