import { describe, expect, it } from 'vitest';
import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';
import {
	COMPACTION_CONTEXT_RATIO,
	COMPACTION_RETAIN_RATIO,
	TOOL_RESULT_PRUNE_MARKER,
	TOOL_RESULT_PRUNE_THRESHOLD,
	pruneToolResultContent,
	pruneToolResultsInWindow,
	shouldAutomaticallyCompact,
	splitRetainedTail
} from '$lib/shared/agent/context-window.js';

describe('tool-result prune', () => {
	it('leaves short results intact', () => {
		expect(pruneToolResultContent('ok')).toBe('ok');
	});

	it('keeps a head, marker, and tail on oversized results', () => {
		const content = 'H'.repeat(5000) + 'M'.repeat(4000) + 'T'.repeat(2000);
		const pruned = pruneToolResultContent(content);
		expect(pruned.startsWith('H'.repeat(4096))).toBe(true);
		expect(pruned.includes(TOOL_RESULT_PRUNE_MARKER)).toBe(true);
		expect(pruned.endsWith('T'.repeat(1024))).toBe(true);
		expect(pruned.length).toBeLessThan(content.length);
		expect(content.length).toBeGreaterThan(TOOL_RESULT_PRUNE_THRESHOLD);
	});

	it('rewrites only tool messages in a window', () => {
		const huge = 'x'.repeat(TOOL_RESULT_PRUNE_THRESHOLD + 10);
		const messages: AiMessage[] = [
			{ role: 'user', content: huge },
			{ role: 'tool', content: huge, toolCallId: 'c1' }
		];
		const pruned = pruneToolResultsInWindow(messages);
		expect(pruned[0]?.content).toBe(huge);
		expect(
			typeof pruned[1]?.content === 'string' && pruned[1].content.includes(TOOL_RESULT_PRUNE_MARKER)
		).toBe(true);
	});
});

describe('compaction pressure', () => {
	it('fires at 80% of the selected model context', () => {
		expect(COMPACTION_CONTEXT_RATIO).toBe(0.8);
		expect(COMPACTION_RETAIN_RATIO).toBe(0.16);
		expect(
			shouldAutomaticallyCompact({
				messages: [{ role: 'user', content: 'small prompt' }],
				tools: [],
				systemPrompt: '',
				contextLength: 1_000_000
			})
		).toBe(false);
		expect(
			shouldAutomaticallyCompact({
				messages: [{ role: 'user', content: 'x'.repeat(3_900_000) }],
				tools: [],
				systemPrompt: '',
				contextLength: 1_000_000
			})
		).toBe(true);
	});
});

describe('retained tail', () => {
	it('does not cut between an assistant tool-call and its result', () => {
		const messages: AiMessage[] = [
			{ role: 'user', content: 'x'.repeat(4_000) },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'c1', name: 'read_collection', input: {} }]
			},
			{ role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
			{ role: 'assistant', content: 'done' }
		];
		const { head, tail } = splitRetainedTail(messages, 80);
		expect(head[0]?.role).toBe('user');
		expect(tail.some((message) => message.role === 'tool')).toBe(true);
		expect(
			tail.some((message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
		).toBe(true);
	});
});
