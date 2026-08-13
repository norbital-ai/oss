import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import { testAiBinding } from '../support/ai-binding.js';
import {
	bootPodRuntime,
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
describe('Pod agent chat — leftover in-guest runAgent path E2E', () => {
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

	async function chat(body: Record<string, unknown>): Promise<Response> {
		return harness.request(
			{
				method: 'POST',
				path: 'remotes/agentChat',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			},
			member
		);
	}

	it('answers, records the exchange, and carries it into the next turn', async () => {
		const first = await chat({ message: 'Hello there.' });
		expect(first.status).toBe(200);
		const opened = (await first.json()) as { runId: string; chatId: string; text: string };
		expect(opened.text).toBe('reply 1');
		expect(opened.chatId).toBeTruthy();

		// Continuing by run id must replay the stored transcript rather than start over — that is the
		// whole reason the loop persists AiMessages instead of a decomposition.
		const second = await chat({ message: 'And again.', runId: opened.runId });
		expect(second.status).toBe(200);
		const continued = (await second.json()) as { runId: string; chatId: string; text: string };
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
			  ORDER BY (message->>'seq')::int`,
			[opened.chatId]
		);
		expect(rows.rows.map((row) => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		// One sequence per conversation, and it never restarts.
		expect(rows.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
	});

	it('keeps history beyond forty rows until model-aware compaction replaces it', async () => {
		const first = await chat({ message: 'Sentinel from the beginning.' });
		expect(first.status).toBe(200);
		const opened = (await first.json()) as { runId: string; chatId: string };

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

		const continued = await chat({ message: 'What was the sentinel?', runId: opened.runId });
		expect(continued.status, await continued.clone().text()).toBe(200);
		expect(seen.at(-1)).toContain('user:Sentinel from the beginning.');
	});

	it('refuses to continue a conversation belonging to someone else', async () => {
		const mine = await chat({ message: 'Mine.' });
		const { runId } = (await mine.json()) as { runId: string };

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
				path: 'remotes/agentChat',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Yours now.', runId })
			},
			intruder
		);
		expect(stolen.status).toBeGreaterThanOrEqual(400);
	});
});
