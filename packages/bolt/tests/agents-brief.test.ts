import { describe, expect, it } from 'vitest';
import { ENVOY_BRIEF, NORBIUS_BRIEF, clockLine } from '../src/runtime/agents/agents.js';

type Row = Parameters<typeof clockLine>[0][number];

const humanInput = (timeZone?: string): Row =>
	({
		id: 'm1',
		conversation_id: 'c1',
		sequence: 1,
		author: { kind: 'human', id: 'u1' },
		message: { role: 'user', content: 'today' },
		annotation: { tag: 'input', ...(timeZone === undefined ? {} : { timeZone }) }
	}) as unknown as Row;

describe('the agent brief', () => {
	it('speaks to the person, keeps its method to itself, and owns records and attachments rules', () => {
		// The rule that replaced "one short line on what you are doing or found": a line is for the
		// person, and the agent's own plan to read or check something stays in reasoning.
		expect(NORBIUS_BRIEF).toContain('Every line you write is for the person');
		expect(NORBIUS_BRIEF).toContain('stays in your reasoning');
		expect(NORBIUS_BRIEF).not.toContain('Before each tool call');
		expect(NORBIUS_BRIEF).toContain('Do not learn behaviour by sampling rows or trying writes');
		expect(NORBIUS_BRIEF).toContain(
			'Know what one shows (read_attachment) before you describe it or file it'
		);
		expect(NORBIUS_BRIEF).toContain('delete or replace one only when they say so');
		// Tool mechanics live on the tools, not here.
		expect(NORBIUS_BRIEF).not.toContain('storage_key');
		expect(ENVOY_BRIEF).toContain('what cannot be done');
	});

	it("states the person's own day, not the server's", () => {
		// 19:04 UTC on 24 Sep is already the 25th in Singapore — the day a job was misfiled on.
		const at = Date.parse('2026-09-24T19:04:00.000Z');
		expect(clockLine([humanInput('Asia/Singapore')], at)).toBe(
			'Their clock: Friday, 25 September 2026 at 03:04 (Asia/Singapore). "Today" and every date they say are in this zone.'
		);
		expect(clockLine([humanInput()], at)).toContain('Their timezone is not stated');
		expect(clockLine([humanInput('Not/AZone')], at)).toContain('Their timezone is not stated');
	});
});
