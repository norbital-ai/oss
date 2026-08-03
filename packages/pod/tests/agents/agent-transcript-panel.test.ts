import { describe, expect, it } from 'vitest';
import { toPanelMessages, withPendingEcho } from '$lib/runtime/agent/transcript.js';

describe('agent panel transcript', () => {
	it('projects a stored message without a second model of it', () => {
		expect(
			toPanelMessages([
				{ norbital_id: 'm1', parts: [{ role: 'assistant', content: 'The workspace is ready.' }] }
			])
		).toEqual([{ kind: 'text', key: 'm1', role: 'assistant', content: 'The workspace is ready.' }]);
	});

	it('gives every call in a turn its own row instead of one joined name', () => {
		// The regression this replaces read "Using read_collection, read_collection…" — one bubble in
		// which neither call could be told from the other.
		const rows = toPanelMessages([
			{
				norbital_id: 'm2',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [
							{ id: 't1', name: 'read_collection', input: { collection: 'accounts', limit: 5 } },
							{ id: 't2', name: 'read_collection', input: { collection: 'payments', limit: 5 } }
						]
					}
				]
			}
		]);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.key)).toEqual(['m2:0', 'm2:1']);
		expect(rows.map((row) => (row.kind === 'tool' ? row.detail : null))).toEqual([
			'accounts',
			'payments'
		]);
		// The empty assistant row that carried them adds nothing beside the calls it made.
		expect(rows.every((row) => row.kind === 'tool')).toBe(true);
	});

	it('labels a built-in call and humanizes one it does not know', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm3',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [
							{ id: 't1', name: 'describe_workspace', input: {} },
							{ id: 't2', name: 'sandbox_deploy', input: {} }
						]
					}
				]
			}
		]);
		expect(rows.map((row) => (row.kind === 'tool' ? row.label : null))).toEqual([
			'Describe workspace',
			'Sandbox deploy'
		]);
		// No arguments to show, and no result yet, so the call reads as still running.
		expect(rows.map((row) => (row.kind === 'tool' ? row.input : null))).toEqual([null, null]);
		expect(rows.map((row) => (row.kind === 'tool' ? row.state : null))).toEqual([
			'running',
			'running'
		]);
	});

	it('shows a tool result on the call it answers rather than dropping it', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm4',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 'call-1', name: 'read_collection', input: { collection: 'sites' } }]
					}
				]
			},
			{
				norbital_id: 'm5',
				parts: [{ role: 'tool', content: '{"rows":[{"name":"Depot"}]}', toolCallId: 'call-1' }]
			}
		]);
		// The result row is folded into the call, so it never renders as an unattributed blob.
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: 'tool',
			name: 'read_collection',
			state: 'complete',
			error: null,
			children: []
		});
		expect(rows[0]?.kind === 'tool' && rows[0].output).toContain('Depot');
	});

	it('surfaces a tool the loop swallowed into the model context as failed', () => {
		// A thrown tool becomes `{ error }` and the run still succeeds, so the panel is the only place
		// the failure is visible at all.
		const rows = toPanelMessages([
			{
				norbital_id: 'm6',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 'call-2', name: 'read_collection', input: { collection: 'secrets' } }]
					}
				]
			},
			{
				norbital_id: 'm7',
				parts: [
					{
						role: 'tool',
						content: '{"error":"Agent cannot read collection secrets"}',
						toolCallId: 'call-2'
					}
				]
			}
		]);
		expect(rows[0]).toMatchObject({
			kind: 'tool',
			state: 'failed',
			error: 'Agent cannot read collection secrets',
			output: null
		});
	});

	it('caps a payload so one read cannot bury the conversation', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm8',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 'call-3', name: 'read_collection', input: { collection: 'rows' } }]
					}
				]
			},
			{
				norbital_id: 'm9',
				parts: [
					{
						role: 'tool',
						content: JSON.stringify({ rows: 'x'.repeat(9_000) }),
						toolCallId: 'call-3'
					}
				]
			}
		]);
		const output = rows[0]?.kind === 'tool' ? rows[0].output : null;
		expect(output?.length).toBe(2_001);
		expect(output?.endsWith('…')).toBe(true);
	});

	it("nests a subagent's transcript under the call that spawned it", () => {
		// The child writes into the parent's session with a turn of its own. Without the nesting its
		// rows interleave by `seq` and its task prompt reads as something the person typed.
		const rows = toPanelMessages(
			[
				{
					norbital_id: 'p1',
					turn_id: 'parent-turn',
					parts: [
						{
							role: 'assistant',
							content: '',
							toolCalls: [{ id: 'call-9', name: 'spawn_subagent', input: { task: 'Audit sites' } }]
						}
					]
				},
				{
					norbital_id: 'c1',
					turn_id: 'child-turn',
					parts: [{ role: 'user', content: 'Audit sites' }]
				},
				{
					norbital_id: 'c2',
					turn_id: 'child-turn',
					parts: [
						{
							role: 'assistant',
							content: '',
							toolCalls: [
								{ id: 'call-10', name: 'read_collection', input: { collection: 'sites' } }
							]
						}
					]
				},
				{
					norbital_id: 'c3',
					turn_id: 'child-turn',
					parts: [{ role: 'tool', content: '{"rows":[]}', toolCallId: 'call-10' }]
				},
				{
					norbital_id: 'p2',
					turn_id: 'parent-turn',
					parts: [{ role: 'assistant', content: 'Done.' }]
				}
			],
			[
				{ norbital_id: 'parent-turn', subagent_id: null },
				{ norbital_id: 'child-turn', subagent_id: 'subagent:call-9' }
			]
		);

		// Top level is the spawn call and the parent's own answer — the child's three rows are not here.
		expect(rows.map((row) => row.key)).toEqual(['p1:0', 'p2']);
		const spawn = rows[0];
		if (spawn?.kind !== 'tool') throw new Error('expected the spawn call');
		expect(spawn.label).toBe('Delegate task');
		expect(spawn.detail).toBe('Audit sites');
		// The same projection, recursively: the child's own tool call kept its result.
		expect(spawn.children.map((child) => child.kind)).toEqual(['text', 'tool']);
		const nestedCall = spawn.children[1];
		if (nestedCall?.kind !== 'tool') throw new Error('expected the nested call');
		expect(nestedCall.name).toBe('read_collection');
		expect(nestedCall.state).toBe('complete');
	});

	it('drops a row it cannot render', () => {
		expect(toPanelMessages([{ norbital_id: 'm10', parts: null }])).toEqual([]);
		expect(toPanelMessages([{ norbital_id: 'm11', parts: [] }])).toEqual([]);
		expect(toPanelMessages([{ parts: [{ role: 'user', content: 'orphan' }] }])).toEqual([]);
	});

	it('keeps streaming state for assistant paint', () => {
		expect(
			toPanelMessages([
				{
					norbital_id: 'm12',
					status: 'streaming',
					parts: [{ role: 'assistant', content: 'Partial' }]
				}
			])
		).toEqual([
			{ kind: 'text', key: 'm12', role: 'assistant', content: 'Partial', status: 'streaming' }
		]);
	});

	it('echoes a prompt until its stored row arrives, then stops', () => {
		const stored = [{ kind: 'text', key: 'm1', role: 'assistant', content: 'Hello.' }] as const;
		expect(withPendingEcho(stored, 'What is on site?')).toEqual([
			...stored,
			{ kind: 'text', key: 'pending', role: 'user', content: 'What is on site?' }
		]);

		// The moment the loop's own row replicates, the echo is gone — no timer, and never both.
		const landed = [
			...stored,
			{ kind: 'text', key: 'm2', role: 'user', content: 'What is on site?' }
		] as const;
		expect(withPendingEcho(landed, 'What is on site?')).toEqual(landed);
		expect(withPendingEcho(landed, null)).toEqual(landed);
	});
});
