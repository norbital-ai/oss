import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AiChatInput } from '@norbital-ai/platform-utils/runtime/binding';
import { generateConversationTitle } from '../../src/server/agent/conversation-title.server.js';

describe('AI conversation titles', () => {
	it('uses structured model output for a concise first-message title', async () => {
		const chat = vi.fn(async (_input: AiChatInput) => ({
			text: JSON.stringify({ title: 'Diagnose payroll import failures' }),
			stopReason: 'end' as const
		}));
		await expect(
			generateConversationTitle({ chat }, 'Why did the payroll import fail for August?')
		).resolves.toBe('Diagnose payroll import failures');
		expect(chat).toHaveBeenCalledOnce();
		expect(chat.mock.calls[0]![0].outputSchema).toBeDefined();
	});

	it('accepts a plain-text provider response without repeatedly billing retries', async () => {
		const chat = vi.fn(async (_input: AiChatInput) => ({
			text: '“Review CRM quote permissions.”',
			stopReason: 'end' as const
		}));
		await expect(
			generateConversationTitle({ chat }, 'Can you review who can approve CRM quotes?')
		).resolves.toBe('Review CRM quote permissions');
	});

	it('does not generate titles from inside the agent loop', () => {
		const source = readFileSync(
			new URL('../../src/server/agent/agent-loop.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('runPendingConversationTitle');
		expect(source).not.toContain('conversation-title.server');
	});
});
