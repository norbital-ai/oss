import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import { testAiBinding } from '../support/ai-binding.js';
import {
	bootPodRuntime,
	completeInteractiveAgentTurn,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();
const member: Identity = {
	userId: '44444444-4444-4444-8444-444444444444',
	userName: 'Chat Member',
	email: 'chat@it.local',
	role: 'basic'
};

/**
 * The interactive counterpart to an agent automation.
 *
 * A conversation is a run with no automation name, so it exercises the same loop, writes the same
 * transcript, and replicates through ordinary sync — the point of the port is that there is not a
 * second agent implementation for the chat case.
 */
describe('Pod agent chat — agent/start durable path E2E', () => {
	let harness: PodRuntimeHarness;
	const seen: string[][] = [];
	const ai = testAiBinding(async (input) => {
		seen.push(input.messages.map((message) => `${message.role}:${message.content}`));
		return {
			text: `reply ${seen.length}`,
			stopReason: 'end',
			usage: { totalTokens: 3 }
		};
	});

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { ai });
		await harness.pool.query(
			`INSERT INTO "user" (norbital_id, email, name, role, status)
			 VALUES ($1::uuid, $2, $3, 'basic', 'active')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[member.userId, member.email, member.userName]
		);
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	async function chat(body: { readonly message: string; readonly runId?: string }) {
		const result = await completeInteractiveAgentTurn(harness, member, body, ai);
		expect(result.outcome).toBe('completed');
		return result;
	}

	it('answers, records the exchange, and carries it into the next turn', async () => {
		const opened = await chat({ message: 'Hello there.' });
		expect(opened.chatId).toBeTruthy();

		// Continuing by run id must replay the stored transcript rather than start over — that is the
		// whole reason the loop persists AiMessages instead of a decomposition.
		const continued = await chat({ message: 'And again.', runId: opened.runId });
		expect(continued.runId).toBe(opened.runId);
		expect(continued.chatId).toBe(opened.chatId);

		// The baseline prompt leads every request and is identical across turns; asserting the opening
		// words rather than the whole text keeps this from breaking each time the prompt is reworded.
		expect(seen[0][0]).toMatch(/^system:You are a Norbital agent/);
		expect(seen[1][0]).toBe(seen[0][0]);

		const turns = (index: number) =>
			seen[index].filter((message) => !message.startsWith('system:'));
		expect(turns(0)).toEqual(['user:Hello there.']);
		expect(turns(1)).toEqual(['user:Hello there.', 'assistant:reply 1', 'user:And again.']);

		const rows = await harness.pool.query<{ role: string; seq: number }>(
			`SELECT message->>'role' AS role, (message->>'seq')::int AS seq
			   FROM chat_session,
			        jsonb_array_elements(messages) AS message
			  WHERE norbital_id = $1::uuid
			    AND COALESCE(message->>'kind', 'normal') NOT IN ('usage', 'reasoning')
			  ORDER BY (message->>'seq')::int`,
			[opened.chatId]
		);
		expect(rows.rows.map((row) => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		// One sequence per conversation, and it never restarts. Usage rows occupy 3 and 6.
		expect(rows.rows.map((row) => row.seq)).toEqual([1, 2, 4, 5]);
	});

	it('keeps history beyond forty rows until model-aware compaction replaces it', async () => {
		const opened = await chat({ message: 'Sentinel from the beginning.' });

		// Cross the former row-count replay boundary without approaching any model context limit.
		await harness.pool.query(
			`UPDATE chat_session
			    SET messages = messages || (
			      SELECT jsonb_agg(jsonb_build_object(
			        'norbital_id', uuidv7(),
			        'turn_id', NULL,
			        'role', CASE WHEN seq % 2 = 1 THEN 'user' ELSE 'assistant' END,
			        'seq', seq,
			        'parts', jsonb_build_array(jsonb_build_object(
			          'role', CASE WHEN seq % 2 = 1 THEN 'user' ELSE 'assistant' END,
			          'content', 'filler ' || seq::text
			        )),
			        'kind', 'normal'
			      ) ORDER BY seq)
			      FROM generate_series(3, 44) AS seq
			    )
			  WHERE norbital_id = $1::uuid`,
			[opened.chatId]
		);

		await chat({ message: 'What was the sentinel?', runId: opened.runId });
		expect(seen.at(-1)).toContain('user:Sentinel from the beginning.');
	});

	it('refuses to continue a conversation belonging to someone else', async () => {
		const mine = await chat({ message: 'Mine.' });
		const { runId } = mine;

		const intruder: Identity = {
			userId: '55555555-5555-4555-8555-555555555555',
			userName: 'Other',
			email: 'other@it.local',
			role: 'basic'
		};
		await harness.pool.query(
			`INSERT INTO "user" (norbital_id, email, name, role, status)
			 VALUES ($1::uuid, $2, $3, 'basic', 'active')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[intruder.userId, intruder.email, intruder.userName]
		);
		const stolen = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Yours now.', runId })
			},
			intruder
		);
		expect(stolen.status).toBeGreaterThanOrEqual(400);
	});

	it('refuses API-client remotes and custom invoke names as an agent start door', async () => {
		const legacy = await harness.request(
			{
				method: 'POST',
				path: 'remotes/agentChatStart',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Should not start.' })
			},
			member
		);
		expect(legacy.status).toBe(404);

		const custom = await harness.request(
			{
				method: 'POST',
				path: 'remotes/agentChatStart',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'agentChatStart', payload: { message: 'Should not start.' } })
			},
			member
		);
		expect(custom.status).toBe(404);

		const invoke = await harness.request(
			{
				method: 'POST',
				path: 'invoke/command',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'agentChatStart', payload: { message: 'Should not start.' } })
			},
			member
		);
		expect(invoke.status).toBeGreaterThanOrEqual(400);
	});
});
