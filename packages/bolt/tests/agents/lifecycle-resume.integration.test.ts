import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

const catalog: AIResponse = {
	output: {
		defaultModel: 'test-model',
		options: [{ id: 'test-model', contextLength: 128_000 }]
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('agent lane resume and stop boundaries', () => {
	it('lets stop beat an in-flight provider completion without committing stale output', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => (started = resolve));
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: catalog };
				started();
				await held;
				return {
					_tag: 'Success',
					value: { output: { role: 'assistant', content: 'stale provider answer' } }
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = 'stop-provider-boundary';
		const running = harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enqueue'),
				adminSubject,
				'web',
				conversationId,
				'input',
				Agents.userAgentInput('Start the work.')
			)
		);
		await providerStarted;
		await harness.runtime.runPromise(
			agents.stop(harness.effectId('stop'), adminSubject, conversationId)
		);
		release();
		expect((await running).status).toBe('failed');
		expect(
			await harness.database.query(
				`select lane.state, run.status, run.disposition
				 from agent_lane lane join agent_run run on run.conversation_id = lane.conversation_id
				 where lane.conversation_id = $1`,
				[conversationId]
			)
		).toEqual([{ state: 'stopped', status: 'aborted', disposition: 'stopped' }]);
		expect(
			await harness.database.query(
				`select count(*)::int as count from chat_message
				 where conversation_id = $1 and role = 'assistant'`,
				[conversationId]
			)
		).toEqual([{ count: 0 }]);
	});

	it('only continues a stopped active run through explicit resume', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Models'
					? { _tag: 'Success', value: catalog }
					: { _tag: 'Success', value: { output: { role: 'assistant', content: 'Resumed.' } } }
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const conversationId = 'resume-active-run';
		const runId = 'stopped-run';
		await harness.database.query(
			`insert into chat_session
				(conversation_id, agent_name, user_id, sandbox_key, visibility)
			 values ($1, 'web', $2, $2, 'personal')`,
			[conversationId, adminSubject.userId]
		);
		await harness.database.query(
			`insert into chat_message
				(message_id, conversation_id, role, content_kind, content_text, search_text, semantic_hash)
				 values ('resume-input', $1, 'user', 'text', 'Continue safely.', 'Continue safely.', 'resume-hash')`,
			[conversationId]
		);
		const sequenceRows = await harness.database.query(
			'select sequence from chat_message where message_id = $1',
			['resume-input']
		);
		const sequence = sequenceRows[0]?.sequence;
		if (typeof sequence !== 'number') throw new Error('missing input boundary');
		await harness.database.query(
			`insert into agent_run
				(run_id, conversation_id, generation, status, started_at, cause, input_boundary,
				 subject_snapshot, authority_fingerprint, agent_release_id, resolved_model, depth)
			 values ($1, $2, 1, 'running', 1, 'input', $3, $4::jsonb, 'authority', 'release',
				 $5::jsonb, 0)`,
			[
				runId,
				conversationId,
				sequence,
				JSON.stringify(adminSubject),
				JSON.stringify({ id: 'test-model', contextTokens: 128_000 })
			]
		);
		await harness.database.query(
			`insert into agent_lane
				(conversation_id, state, active_run_id, active_generation, requested_generation)
			 values ($1, 'active', $2, 1, 1)`,
			[conversationId, runId]
		);
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.stop(harness.effectId('stop-before-resume'), adminSubject, conversationId)
		);
		expect(
			await harness.database.query(
				'select state, active_run_id from agent_lane where conversation_id = $1',
				[conversationId]
			)
		).toEqual([{ state: 'stopped', active_run_id: runId }]);
		await harness.runtime.runPromise(
			agents.resume(harness.effectId('resume'), adminSubject, conversationId)
		);
		expect(
			await harness.database.query(
				`select run_id, status, disposition, cause, driver_epoch from agent_run
				 where conversation_id = $1 order by generation`,
				[conversationId]
			)
		).toEqual([
			{ run_id: runId, status: 'aborted', disposition: 'stopped', cause: 'input', driver_epoch: 0 },
			{
				run_id: `run:resume:${harness.effectId('resume')}`,
				status: 'completed',
				disposition: null,
				cause: 'resume',
				driver_epoch: 1
			}
		]);
		expect(
			await harness.database.query(
				`select role, content_text from chat_message
				 where conversation_id = $1 order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ role: 'user', content_text: 'Continue safely.' },
			{ role: 'assistant', content_text: 'Resumed.' }
		]);
	});
});
