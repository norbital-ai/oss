import { describe, expect, it } from 'vitest';
import {
	COMPACTION_CONTEXT_RATIO,
	parseCompactDirective,
	shouldAutomaticallyCompact
} from '$lib/server/agent/agent-loop.server.js';

describe('compact directive', () => {
	it('matches the whole message, so a sentence starting with the word is still a sentence', () => {
		expect(parseCompactDirective('/compact')).toEqual({});
		expect(parseCompactDirective('  /compact  ')).toEqual({});
		expect(parseCompactDirective('/compact keep the site identifiers')).toEqual({
			instructions: 'keep the site identifiers'
		});
		// Not directives — the first is a word, the rest are prose the reader meant for the agent.
		expect(parseCompactDirective('/compacting the schema')).toBeNull();
		expect(parseCompactDirective('can you /compact this')).toBeNull();
		expect(parseCompactDirective('compact the report')).toBeNull();
	});
});

describe('automatic context compaction', () => {
	it('uses 80% of the selected model context instead of a fixed prompt size', () => {
		expect(COMPACTION_CONTEXT_RATIO).toBe(0.8);
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

	it('counts system and tool definitions, and does not guess when model metadata is absent', () => {
		const input = {
			messages: [{ role: 'user' as const, content: 'hello' }],
			tools: [
				{
					name: 'large_tool',
					description: 'x'.repeat(4_000),
					inputSchema: { type: 'object' }
				}
			],
			systemPrompt: 'system',
			contextLength: 1_000
		};
		expect(shouldAutomaticallyCompact(input)).toBe(true);
		expect(shouldAutomaticallyCompact({ ...input, contextLength: null })).toBe(false);
	});
});

describe('durable turn settlement', () => {
	it('fails the open turn when the provider window cannot be loaded', async () => {
		const { readFile } = await import('node:fs/promises');
		const source = await readFile(
			new URL('../../src/server/agent/agent-loop.server.ts', import.meta.url),
			'utf8'
		);
		const windowAt = source.indexOf('messages = await loadDurableTurnWindow');
		const emptyAt = source.indexOf("throw new Error('Agent run requires an input message')");
		const failAt = source.indexOf('return failDurableRun({', emptyAt);
		expect(emptyAt).toBeGreaterThan(windowAt);
		expect(failAt).toBeGreaterThan(emptyAt);
		expect(failAt - emptyAt).toBeLessThan(400);
	});
});
