import { describe, expect, it } from '@effect/vitest';
import { batchCalls } from '../src/engine/agent/turn-calls.ts';
import type { ToolCall } from '../src/engine/agent/schema.ts';

const call = (id: string, name: string, input: ToolCall['input'] = {}): ToolCall => ({
	id,
	name,
	input
});

describe('agent tool-call batching', () => {
	it('groups consecutive pure reads and disjoint-path writes while keeping conflicting paths and mutations serial', () => {
		const batches = batchCalls([
			call('1', 'workspace_read', { path: 'a.ts' }),
			call('2', 'skill', { name: 'bolt-primer' }),
			call('3', 'workspace_lang', { op: 'type', type: 'string' }),
			call('4', 'workspace_write', { path: 'src/a.ts', content: 'a' }),
			call('5', 'workspace_write', { path: 'src/b.ts', content: 'b' }),
			call('6', 'workspace_edit', { path: 'src/a.ts', oldString: 'a', newString: 'c' }),
			call('7', 'workspace_diagnose', {}),
			call('8', 'workspace_write', { path: 'src/d.ts', content: 'd' }),
			call('9', 'workspace_commit', { message: 'msg' })
		]);
		expect(batches.map((b) => b.map((c) => c.id))).toEqual([
			['1', '2', '3'],
			['4', '5'],
			['6'],
			['7'],
			['8'],
			['9']
		]);
	});

	it('isolates invalid-JSON calls into single-item batches', () => {
		const batches = batchCalls([
			call('1', 'workspace_read', { path: 'a.ts' }),
			{ id: '2', name: 'workspace_read', input: {}, invalid: 'bad json' },
			call('3', 'workspace_read', { path: 'b.ts' })
		]);
		expect(batches.map((b) => b.map((c) => c.id))).toEqual([['1'], ['2'], ['3']]);
	});
});
