import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import { testAiBinding } from '../support/ai-binding.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();
const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

/** A second, non-admin member — the transcript guard must not hand them someone else's session. */
const member: Identity = {
	userId: '33333333-3333-4333-8333-333333333333',
	userName: 'Field Member',
	email: 'member@it.local',
	role: 'basic'
};

describe('Pod AI and automation transcript — leftover in-guest runAgent path E2E', () => {
	let harness: PodRuntimeHarness;
	let calls = 0;
	let emptyCalls = 0;
	let refusalCalls = 0;
	let retryCalls = 0;
	const ai = testAiBinding(async (input) => {
		if (input.outputSchema) {
			return { text: JSON.stringify({ title: 'Workspace' }), stopReason: 'end' };
		}
		const firstUser = input.messages.find((message) => message.role === 'user')?.content;
		if (firstUser === 'Finish with no content.') {
			emptyCalls += 1;
			return {
				text: '',
				stopReason: 'end',
				usage: { totalTokens: 13, cost: 0.25 }
			};
		}
		if (firstUser === 'Refuse this request.') {
			refusalCalls += 1;
			return {
				text: '',
				stopReason: 'refusal',
				usage: { totalTokens: 23, cost: 0.7 }
			};
		}
		if (firstUser === 'Retry settlement, not the provider.') {
			retryCalls += 1;
			return {
				text: 'Settled once.',
				stopReason: 'end',
				usage: { totalTokens: 19, cost: 0.5 }
			};
		}
		if (firstUser === 'Keep using tools past eight turns.') {
			const completedCalls = input.messages.filter((message) => message.role === 'tool').length;
			if (completedCalls < 9) {
				return {
					text: '',
					toolCalls: [
						{
							id: `long-tool-${completedCalls + 1}`,
							name: 'describe_workspace',
							input: {}
						}
					],
					stopReason: 'tool_use',
					usage: { totalTokens: 1 }
				};
			}
			return {
				text: 'Completed after nine tool calls.',
				stopReason: 'end',
				usage: { totalTokens: 1 }
			};
		}
		calls += 1;
		if (calls === 1) {
			// `construction` authors no `src/+agent.ts`, so this is the fallback profile: skill and
			// sandbox-coordination tools are unconditional, and `write_collection` is present because
			// that profile grants write.
			expect(input.tools?.map((tool) => tool.name)).toEqual([
				'await_sandbox_agent',
				'describe_workspace',
				'list_sandbox_agents',
				'list_skills',
				'message_sandbox_agent',
				'read_collection',
				'read_sandbox_agent',
				'read_skill',
				'spawn_subagent',
				'write_collection'
			]);
			return {
				text: '',
				toolCalls: [{ id: 'tool-1', name: 'describe_workspace', input: {} }],
				stopReason: 'tool_use',
				usage: { totalTokens: 10 }
			};
		}
		expect(input.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'tool-1' });
		return {
			text: 'The workspace is ready.',
			stopReason: 'end',
			usage: { totalTokens: 7 }
		};
	});

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { ai });
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	const sessionForPrompt = async (prompt: string) =>
		(
			await harness.pool.query<{
				norbital_id: string;
				messages: Array<{ kind: string; usage: { totalTokens?: number } | null }>;
				turns: Array<{ status: string; usage_settled_at: string | null }>;
				usage_total_tokens: number;
				usage_cost_usd: number;
				usage_turns_counted: number;
			}>(
				`SELECT norbital_id,
				        messages,
				        turns,
				        usage_total_tokens,
				        usage_cost_usd,
				        usage_turns_counted
				   FROM chat_session
				  WHERE EXISTS (
				        SELECT 1
				          FROM jsonb_array_elements(messages) AS message
				         WHERE message->>'role' = 'user'
				           AND message->'parts'->0->>'content' = $1
				  )
				  ORDER BY norbital_created_at DESC
				  LIMIT 1`,
				[prompt]
			)
		).rows[0];

	it('runs the Pod-owned loop and exposes completed turns through ordinary synced rows', async () => {
		const response = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Describe this workspace.' })
			},
			admin
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { runId: string; text: string };
		expect(result.text).toBe('The workspace is ready.');
		expect(calls).toBe(2);

		// The transcript is one tenant-owned aggregate, replayable without cross-collection joins.
		const session = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM chat_session WHERE automation_run_id = $1::uuid`,
			[result.runId]
		);
		expect(session.rows).toHaveLength(1);

		const shape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'chat_session', pageSize: 100 })
			},
			admin
		);
		expect(shape.status).toBe(200);
		const transcript = (await shape.json()) as {
			rows: Array<{
				norbital_id: string;
				messages: Array<{
					seq: number;
					role: string;
					kind?: string;
					parts: Array<{
						role: string;
						content: string;
						toolCallId?: string;
						toolCalls?: Array<{ name: string }>;
					}> | null;
				}>;
			}>;
		};
		const steps = (
			transcript.rows.find((row) => row.norbital_id === session.rows[0]?.norbital_id)?.messages ??
			[]
		)
			.filter((step) => step.kind !== 'usage' && step.kind !== 'reasoning')
			.sort((left, right) => left.seq - right.seq);

		// user prompt, the assistant turn carrying its tool call, the tool result, the final answer.
		expect(steps.map((step) => step.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(steps[1]?.parts?.[0]?.toolCalls?.[0]?.name).toBe('describe_workspace');
		expect(steps[2]?.parts?.[0]?.toolCallId).toBeTruthy();
		expect(steps[3]?.parts?.[0]?.content).toBe('The workspace is ready.');

		// A transcript belongs to its session's owner. An admin short-circuits every policy deny, so the
		// isolation has to be proved with a plain member — and the member needs a session of their own,
		// or the assertion passes for the wrong reason (no sessions means denied outright, so an empty
		// result would prove nothing about filtering).
		await harness.pool.query(
			`INSERT INTO "user" (norbital_id, email, name, role, status)
			 VALUES ($1::uuid, 'member@it.local', 'Field Member', 'basic', 'active')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[member.userId]
		);
		const ownSession = await harness.pool.query<{ norbital_id: string }>(
			`INSERT INTO chat_session (user_id, title, visibility)
			 VALUES ($1::uuid, 'Member session', 'personal') RETURNING norbital_id`,
			[member.userId]
		);
		await harness.pool.query(
			`UPDATE chat_session
			    SET messages = jsonb_build_array(jsonb_build_object(
			      'norbital_id', uuidv7(),
			      'turn_id', NULL,
			      'role', 'user',
			      'seq', 1,
			      'parts', '[{"role":"user","content":"mine"}]'::jsonb,
			      'kind', 'normal'
			    ))
			  WHERE norbital_id = $1::uuid`,
			[ownSession.rows[0]!.norbital_id]
		);

		const otherShape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'chat_session', pageSize: 100 })
			},
			member
		);
		const otherRows =
			otherShape.status === 200
				? ((await otherShape.json()) as { rows: Array<{ norbital_id: string }> }).rows
				: [];
		// Their own message is visible — so the guard is filtering, not just refusing.
		expect(otherShape.status).toBe(200);
		expect(
			otherRows.filter((row) => row.norbital_id === ownSession.rows[0]?.norbital_id)
		).toHaveLength(1);
		// The automation's session belongs to the admin, and must not appear.
		expect(
			otherRows.filter((row) => row.norbital_id === session.rows[0]?.norbital_id)
		).toHaveLength(0);

		const run = await harness.pool.query<{ status: string }>(
			`SELECT status FROM automation_run WHERE norbital_id = $1::uuid`,
			[result.runId]
		);
		expect(run.rows[0]?.status).toBe('success');

		// The conversation's spend is accumulated onto the session as the turn settles. This binding
		// reports tokens but no cost, which is the case that must not read as free.
		const chatId = session.rows[0]!.norbital_id;
		const totals = async () =>
			(
				await harness.pool.query<{
					usage_total_tokens: number;
					usage_cost_usd: number;
					usage_turns_counted: number;
					usage_turns_unreported: number;
				}>(
					`SELECT usage_total_tokens, usage_cost_usd, usage_turns_counted, usage_turns_unreported
					   FROM chat_session WHERE norbital_id = $1::uuid`,
					[chatId]
				)
			).rows[0];
		const settled = await totals();
		// 10 tokens on the tool-call turn plus 7 on the answer, both on the one root turn.
		expect(settled?.usage_total_tokens).toBe(17);
		expect(settled?.usage_turns_counted).toBe(1);
		expect(settled?.usage_cost_usd).toBe(0);
		expect(settled?.usage_turns_unreported).toBe(1);

		// Deleting the messages that produced it must not move the total — that is the whole reason it
		// is a counter and not a sum.
		await harness.pool.query(
			`UPDATE chat_session SET messages = '[]'::jsonb WHERE norbital_id = $1::uuid`,
			[chatId]
		);
		const afterDeletion = await totals();
		expect(afterDeletion?.usage_total_tokens).toBe(17);
		expect(afterDeletion?.usage_turns_counted).toBe(1);

		// And settling the same turn again adds nothing: the claim on `usage_settled_at` already
		// happened, so a retried or resumed run cannot bill the conversation twice.
		const turnId = await harness.pool.query<{ norbital_id: string; usage_settled_at: string }>(
			`SELECT turn->>'norbital_id' AS norbital_id,
			        turn->>'usage_settled_at' AS usage_settled_at
			   FROM chat_session,
			        jsonb_array_elements(turns) AS turn
			  WHERE norbital_id = $1::uuid
			    AND turn->>'subagent_id' IS NULL`,
			[chatId]
		);
		expect(turnId.rows[0]?.usage_settled_at).toBeTruthy();
	});

	it('continues past the former eight-iteration ceiling until the model finishes', async () => {
		const response = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Keep using tools past eight turns.' })
			},
			admin
		);
		expect(response.status, await response.clone().text()).toBe(200);
		const result = (await response.json()) as { text: string };
		expect(result.text).toBe('Completed after nine tool calls.');
	});

	it('persists and settles usage from an empty provider completion', async () => {
		const prompt = 'Finish with no content.';
		const response = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: prompt })
			},
			admin
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(emptyCalls).toBe(1);
		const session = await sessionForPrompt(prompt);
		expect(session).toBeTruthy();
		expect(session?.messages.filter((message) => message.kind === 'usage')).toHaveLength(1);
		expect(session?.messages.find((message) => message.kind === 'usage')?.usage?.totalTokens).toBe(
			13
		);
		expect(session?.usage_total_tokens).toBe(13);
		expect(session?.usage_cost_usd).toBeCloseTo(0.25);
		expect(session?.usage_turns_counted).toBe(1);
		expect(session?.turns[0]).toMatchObject({ status: 'succeeded' });
		expect(session?.turns[0]?.usage_settled_at).toBeTruthy();
	});

	it('settles a refused provider call instead of dropping its usage', async () => {
		const prompt = 'Refuse this request.';
		const response = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: prompt })
			},
			admin
		);
		expect(response.status).toBe(500);
		expect(refusalCalls).toBe(1);
		const session = await sessionForPrompt(prompt);
		expect(session?.messages.filter((message) => message.kind === 'usage')).toHaveLength(1);
		expect(session?.usage_total_tokens).toBe(23);
		expect(session?.usage_cost_usd).toBeCloseTo(0.7);
		expect(session?.usage_turns_counted).toBe(1);
		expect(session?.turns[0]).toMatchObject({ status: 'failed' });
		expect(session?.turns[0]?.usage_settled_at).toBeTruthy();
	});

	it('retries only settlement and accounts for the provider call exactly once', async () => {
		await harness.pool.query(`
			DROP TRIGGER IF EXISTS agent_settlement_fail_once ON chat_session;
			DROP FUNCTION IF EXISTS agent_settlement_fail_once();
			DROP SEQUENCE IF EXISTS agent_settlement_fail_once_seq;
			CREATE SEQUENCE agent_settlement_fail_once_seq;
			CREATE FUNCTION agent_settlement_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.usage_turns_counted > OLD.usage_turns_counted
				   AND nextval('agent_settlement_fail_once_seq') = 1 THEN
					RAISE EXCEPTION 'transient settlement failure';
				END IF;
				RETURN NEW;
			END;
			$$;
			CREATE TRIGGER agent_settlement_fail_once
				BEFORE UPDATE ON chat_session
				FOR EACH ROW EXECUTE FUNCTION agent_settlement_fail_once();
		`);
		const prompt = 'Retry settlement, not the provider.';
		try {
			const response = await harness.request(
				{
					method: 'POST',
					path: 'agent/start',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: prompt })
				},
				admin
			);
			expect(response.status, await response.clone().text()).toBe(200);
			expect(retryCalls).toBe(1);
			const session = await sessionForPrompt(prompt);
			expect(session?.usage_total_tokens).toBe(19);
			expect(session?.usage_cost_usd).toBeCloseTo(0.5);
			expect(session?.usage_turns_counted).toBe(1);
			expect(session?.turns[0]?.usage_settled_at).toBeTruthy();
		} finally {
			await harness.pool.query(`
				DROP TRIGGER IF EXISTS agent_settlement_fail_once ON chat_session;
				DROP FUNCTION IF EXISTS agent_settlement_fail_once();
				DROP SEQUENCE IF EXISTS agent_settlement_fail_once_seq;
			`);
		}
	});
});
