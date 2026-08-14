import { describe, expect, it } from 'vitest';
import { serializeGoalVerdict, serializeVerifierScheduled } from '$lib/shared/agent/goal-verdict.js';
import { wrapPlanSummary } from '$lib/shared/agent/intent.js';
import {
	toPanelMessages,
	toPanelUsage,
	toSessionTotals,
	withPendingEcho
} from '$lib/ui/agent/transcript.js';

describe('conversation usage', () => {
	it('reports what the provider reported and nothing it did not', () => {
		const usage = toPanelUsage(
			[
				{ usage: { input_tokens: 500, output_tokens: 100, cost: 0.002 } },
				{ usage: { input_tokens: 900, output_tokens: 50, cost: 0.003 } },
				{ parts: [{ role: 'user', content: 'no usage on this row' }] }
			],
			1_000_000
		);
		// The newest request's input is the live window occupancy, not the sum of every request.
		expect(usage.contextTokens).toBe(900);
		expect(usage.contextLength).toBe(1_000_000);
		expect(usage.totalTokens).toBe(1_550);
		expect(usage.costUsd).toBeCloseTo(0.005, 10);
	});

	it('reads the durable session counter, and says nothing before a turn has settled', () => {
		expect(toSessionTotals(undefined)).toBeNull();
		// Zero settled turns is "not measured yet", not "spent nothing".
		expect(toSessionTotals({ usage_cost_usd: 0, usage_turns_counted: 0 })).toBeNull();
		expect(
			toSessionTotals({
				usage_cost_usd: 0.00001526,
				usage_total_tokens: 99,
				usage_turns_counted: 3,
				usage_turns_unreported: 1
			})
		).toEqual({
			costUsd: 0.00001526,
			totalTokens: 99,
			turnsCounted: 3,
			turnsUnreported: 1
		});
	});

	it('leaves cost null when the host reported none, rather than calling it zero', () => {
		const usage = toPanelUsage([{ usage: { total_tokens: 40 } }]);
		expect(usage.costUsd).toBeNull();
		expect(usage.contextLength).toBeNull();
		expect(usage.totalTokens).toBe(40);
	});
});

describe('agent panel transcript', () => {
	it('projects reasoning as its own supplementary part instead of answer text', () => {
		expect(
			toPanelMessages([
				{
					norbital_id: 'reason-1',
					kind: 'reasoning',
					parts: [{ role: 'assistant', content: 'Check the available skills first.' }]
				},
				{
					norbital_id: 'answer-1',
					kind: 'normal',
					parts: [{ role: 'assistant', content: 'Two skills are available.' }]
				}
			])
		).toEqual([
			{
				kind: 'reasoning',
				key: 'reason-1',
				content: 'Check the available skills first.'
			},
			{
				kind: 'text',
				key: 'answer-1',
				role: 'assistant',
				content: 'Two skills are available.'
			}
		]);
	});

	it('converges a streaming row when its owning turn is already terminal', () => {
		expect(
			toPanelMessages(
				[
					{
						norbital_id: 'm-terminal',
						turn_id: 'turn-terminal',
						status: 'streaming',
						parts: [{ role: 'assistant', content: 'Finished.' }]
					}
				],
				[{ norbital_id: 'turn-terminal', status: 'succeeded' }]
			)
		).toEqual([
			{
				kind: 'text',
				key: 'm-terminal',
				role: 'assistant',
				content: 'Finished.',
				status: 'complete'
			}
		]);
	});

	it('projects a stored message without a second model of it', () => {
		expect(
			toPanelMessages([
				{ norbital_id: 'm1', parts: [{ role: 'assistant', content: 'The workspace is ready.' }] }
			])
		).toEqual([{ kind: 'text', key: 'm1', role: 'assistant', content: 'The workspace is ready.' }]);
	});

	it('projects a goal verdict row as PanelGoal, not system text', () => {
		const rows = toPanelMessages([
			{ norbital_id: 'u', parts: [{ role: 'user', content: 'Create the site' }] },
			{ norbital_id: 'a', parts: [{ role: 'assistant', content: 'Created.' }] },
			{
				norbital_id: 'g',
				kind: 'goal',
				parts: [
					{
						role: 'system',
						content: serializeGoalVerdict({
							achieved: false,
							summary: 'No site record exists.',
							gaps: ['write_collection never ran']
						})
					}
				]
			}
		]);
		expect(rows.map((row) => row.kind)).toEqual(['text', 'text', 'goal']);
		const verdict = rows[2];
		if (verdict?.kind !== 'goal') throw new Error('expected a goal row');
		expect(verdict).toMatchObject({
			kind: 'goal',
			key: 'g',
			achieved: false,
			summary: 'No site record exists.',
			gaps: ['write_collection never ran']
		});
	});

	it('projects scheduled verifier JSON as a verifier row, not a goal', () => {
		const prompt = 'Was the site actually written?';
		const rows = toPanelMessages([
			{
				norbital_id: 'v',
				kind: 'goal',
				parts: [{ role: 'system', content: serializeVerifierScheduled(prompt) }]
			}
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'verifier', prompt });
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

	it('humanizes an MCP tool name and uses the plug icon', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm-mcp',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 't1', name: 'mcp__stripe__list_customers', input: {} }]
					}
				]
			}
		]);
		expect(rows[0]).toMatchObject({
			kind: 'tool',
			labelKey: null,
			label: 'Stripe · List Customers',
			icon: 'lucide:plug',
			elicitation: null,
			state: 'running'
		});
	});

	it('marks a sandbox agent tool as the sandbox family', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm-sandbox',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 't1', name: 'list_sandbox_agents', input: {} }]
					}
				]
			}
		]);
		expect(rows[0]).toMatchObject({
			kind: 'tool',
			name: 'list_sandbox_agents',
			family: 'sandbox'
		});
	});

	it('labels list_skills and read_skill from the catalog', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm-skills',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [
							{ id: 't1', name: 'list_skills', input: {} },
							{ id: 't2', name: 'read_skill', input: { name: 'authoring-tenant-workspace' } }
						]
					}
				]
			}
		]);
		expect(rows.map((row) => (row.kind === 'tool' ? row.labelKey : null))).toEqual([
			'pod.agent.tool.listSkills',
			'pod.agent.tool.readSkill'
		]);
		expect(rows.map((row) => (row.kind === 'tool' ? row.icon : null))).toEqual([
			'lucide:library',
			'lucide:book-marked'
		]);
	});

	it('surfaces input_required tool results as needs_input with elicitation', () => {
		const rows = toPanelMessages([
			{
				norbital_id: 'm-elicit',
				parts: [
					{
						role: 'assistant',
						content: '',
						toolCalls: [{ id: 'call-elicit', name: 'mcp__stripe__create_invoice', input: {} }]
					}
				]
			},
			{
				norbital_id: 'm-elicit-result',
				parts: [
					{
						role: 'tool',
						content: JSON.stringify({
							resultType: 'input_required',
							requests: [{ id: 'r1', message: 'Which customer?', mode: 'form' }]
						}),
						toolCallId: 'call-elicit'
					}
				]
			}
		]);
		expect(rows[0]).toMatchObject({
			kind: 'tool',
			name: 'mcp__stripe__create_invoice',
			state: 'needs_input',
			elicitation: [{ id: 'r1', message: 'Which customer?', mode: 'form' }],
			error: null
		});
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
		// Built-ins carry a catalog key the panel translates; unknown tools carry a humanized label.
		expect(rows.map((row) => (row.kind === 'tool' ? row.labelKey : null))).toEqual([
			'pod.agent.tool.describeWorkspace',
			null
		]);
		expect(rows.map((row) => (row.kind === 'tool' ? row.label : null))).toEqual([
			null,
			'Sandbox Deploy'
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
		expect(spawn.labelKey).toBe('pod.agent.tool.delegateTask');
		expect(spawn.label).toBeNull();
		expect(spawn.detail).toBe('Audit sites');
		// The same projection, recursively: the child's own tool call kept its result.
		expect(spawn.children.map((child) => child.kind)).toEqual(['text', 'tool']);
		const nestedCall = spawn.children[1];
		if (nestedCall?.kind !== 'tool') throw new Error('expected the nested call');
		expect(nestedCall.name).toBe('read_collection');
		expect(nestedCall.state).toBe('complete');
	});

	it('folds everything before a checkpoint into it, keeping a path back to the original', () => {
		const rows = toPanelMessages([
			{ norbital_id: 'a', parts: [{ role: 'user', content: 'First question' }] },
			{ norbital_id: 'b', parts: [{ role: 'assistant', content: 'First answer' }] },
			{ norbital_id: 'c', kind: 'summary', parts: [{ role: 'system', content: 'They asked X.' }] },
			{ norbital_id: 'd', parts: [{ role: 'user', content: 'Second question' }] }
		]);

		// The checkpoint is the head of the visible transcript; the prefix lives inside it.
		expect(rows.map((row) => row.kind)).toEqual(['checkpoint', 'text']);
		const checkpoint = rows[0];
		if (checkpoint?.kind !== 'checkpoint') throw new Error('expected a checkpoint');
		expect(checkpoint.fold).toBe('compact');
		expect(checkpoint.summary).toBe('They asked X.');
		expect(checkpoint.before.map((row) => row.key)).toEqual(['a', 'b']);
	});

	it('projects a plan-folded summary as a plan checkpoint with the tags stripped', () => {
		const recap = 'Migrate sites first, then payments.';
		const rows = toPanelMessages([
			{ norbital_id: 'a', parts: [{ role: 'user', content: 'How should we migrate?' }] },
			{
				norbital_id: 'c',
				kind: 'summary',
				parts: [{ role: 'system', content: wrapPlanSummary(recap) }]
			}
		]);

		expect(rows).toHaveLength(1);
		const checkpoint = rows[0];
		if (checkpoint?.kind !== 'checkpoint') throw new Error('expected a checkpoint');
		expect(checkpoint.fold).toBe('plan');
		expect(checkpoint.summary).toBe(recap);
		expect(checkpoint.summary).not.toContain('<plan-summary>');
		expect(checkpoint.before.map((row) => row.key)).toEqual(['a']);
	});

	it('nests an earlier checkpoint inside a later one instead of chaining recaps', () => {
		const rows = toPanelMessages([
			{ norbital_id: 'a', parts: [{ role: 'user', content: 'Oldest' }] },
			{ norbital_id: 'c1', kind: 'summary', parts: [{ role: 'system', content: 'First recap' }] },
			{ norbital_id: 'b', parts: [{ role: 'user', content: 'Middle' }] },
			{ norbital_id: 'c2', kind: 'summary', parts: [{ role: 'system', content: 'Second recap' }] }
		]);

		expect(rows).toHaveLength(1);
		const newest = rows[0];
		if (newest?.kind !== 'checkpoint') throw new Error('expected the newest checkpoint');
		expect(newest.fold).toBe('compact');
		expect(newest.summary).toBe('Second recap');
		// Its prefix holds the older checkpoint, which in turn still holds the original message — so the
		// oldest turn is reachable rather than lost behind a summary of a summary.
		const older = newest.before[0];
		if (older?.kind !== 'checkpoint')
			throw new Error('expected the older checkpoint nested inside');
		expect(older.fold).toBe('compact');
		expect(older.summary).toBe('First recap');
		expect(older.before.map((row) => row.key)).toEqual(['a']);
	});

	it('does not echo a prompt that landed before a checkpoint swallowed it', () => {
		const stored = toPanelMessages([
			{ norbital_id: 'a', parts: [{ role: 'user', content: 'What is on site?' }] },
			{ norbital_id: 'c', kind: 'summary', parts: [{ role: 'system', content: 'Recap.' }] }
		]);
		// The prompt is inside the checkpoint rather than at the top level; echoing it would show the
		// reader their own message twice.
		expect(withPendingEcho(stored, 'What is on site?')).toEqual(stored);
	});

	it('drops a row it cannot render', () => {
		expect(toPanelMessages([{ norbital_id: 'm10', parts: null }])).toEqual([]);
		expect(toPanelMessages([{ norbital_id: 'm11', parts: [] }])).toEqual([]);
		expect(toPanelMessages([{ parts: [{ role: 'user', content: 'orphan' }] }])).toEqual([]);
	});

	it('keeps accounting-only provider completions out of the visual transcript', () => {
		expect(
			toPanelMessages([
				{
					norbital_id: 'usage-only',
					kind: 'usage',
					usage: { totalTokens: 13 },
					parts: [{ role: 'assistant', content: '' }]
				}
			])
		).toEqual([]);
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
