import { Effect, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority,
	EffectId,
	ModelId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { subject as self } from '../src/authoring/index.js';
import { collection, envoy, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as AccessControl from '../src/runtime/access/access-control.js';
import * as Agents from '../src/runtime/agents/agents.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import {
	TEST_TENANT,
	makeBoltTestRuntime,
	receiveChat,
	recordingCommunication,
	testChannels,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from './support/fixture-identity.js';
import { assistantToolCalls } from './agents-canonical-ai-fixture.js';

const languageModelId = ModelId.make('test:language');
const encodeMessage = Schema.encodeSync(Prompt.Message);

/**
 * Envoys answering linked members with the member's own authority.
 *
 * `desk` — the envoy's declaration — reads every project and people with their team. `crew` — what
 * the `Crew` team holds — reads only the member's own projects, updates them, and reads `notes`,
 * which the envoy never declares. So an administrator through the envoy reads every project, a crew
 * member their own, an unlinked sender the envoy's whole declaration, and nobody reaches `notes` or
 * writes a project through it.
 */
const definition = workspace({
	name: 'envoy-requestor-standing',
	version: '1',
	collections: [
		collection({
			name: 'projects',
			fields: {
				title: field.string({ required: true }),
				owner_id: field.string({ required: true })
			}
		}),
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'desk',
			effect: 'allow',
			capabilities: { apps: [] },
			grants: [
				{ collection: 'projects', action: 'read' },
				// More of `user` than the built-in directory of names: it replaces that default for
				// its holder instead of overlapping it, which used to refuse the read outright.
				{ collection: 'user', action: 'read', fields: ['id', 'name', 'team_id'] }
			]
		}),
		policy({
			name: 'crew',
			effect: 'allow',
			capabilities: { apps: [] },
			grants: [
				{ collection: 'projects', action: 'read', where: { owner_id: { eq: self.id } } },
				{ collection: 'projects', action: 'update', fields: ['title'] },
				{ collection: 'notes', action: 'read' },
				{ collection: 'user', action: 'read', fields: ['id', 'name', 'team_id'] }
			]
		})
	],
	teams: { Crew: ['crew'] },
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	channels: testChannels('whatsapp'),
	envoys: [
		envoy({
			name: 'desk_whatsapp',
			channel: 'whatsapp',
			audience: 'authenticated',
			policies: ['desk'],
			groupMessages: 'all',
			delegation: 'disabled',
			task: 'Answer the sender.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const requests: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
const ai: FacilityBinding<AIRequest, AIResponse> = {
	call: async (_metadata, request) => {
		if (request._tag === 'Catalog')
			return {
				_tag: 'Success',
				value: {
					_tag: 'Catalog',
					languageModels: [{ id: languageModelId, contextWindowTokens: 1_000_000 }],
					defaultLanguageModelId: languageModelId,
					embeddingModels: [],
					defaultEmbeddingModelId: languageModelId
				}
			};
		if (request._tag !== 'Generate') throw new Error('expected a generation');
		requests.push(request);
		const answered = request.messages.some((message) => message.role === 'tool');
		const message = answered
			? encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Done.' })] }))
			: assistantToolCalls([
					{ name: 'describe_workspace', input: {}, id: 'describe' },
					{ name: 'read_collection', input: { collection: 'projects' }, id: 'projects' },
					{ name: 'read_collection', input: { collection: 'team' }, id: 'teams' }
				]);
		return {
			_tag: 'Success',
			value: {
				_tag: 'Generated',
				result: { _tag: 'Message', message },
				observation: {
					callId: request.callId,
					provider: 'test',
					model: request.modelId,
					operation: 'language'
				}
			}
		};
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
	requests.length = 0;
});

/** Dion administers the workspace and has no team; Sam is on `Crew` and owns one project. */
const seed = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, 'Crew');
	await seedSession(runtime, { token: 'dion-token', user: 'dion', status: 'admin' });
	await seedSession(runtime, { token: 'sam-token', user: 'sam', team: 'Crew' });
	await runtime.database.query(`update "user" set "channels" = $1::jsonb where "id" = $2`, [
		JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }]),
		fixtureUserId('dion')
	]);
	await runtime.database.query(
		`insert into "projects" ("id", "title", "owner_id") values
		 (md5('p-sam')::uuid, 'Sam pump', $1), (md5('p-other')::uuid, 'Other valve', 'someone-else')`,
		[fixtureUserId('sam')]
	);
	await runtime.database.query(`insert into "notes" ("id", "body") values (md5('n1')::uuid, 'x')`);
};

describe('An envoy turn for a linked member', () => {
	it('knows its sender and its authority up front, and lists the system collections it reads', async () => {
		harness = await makeBoltTestRuntime(definition, {
			ai,
			communication: recordingCommunication().binding
		});
		await seed(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		await harness.runtime.runPromise(
			receiveChat('whatsapp', {
				conversationId: '6591234567@s.whatsapp.net',
				conversationKind: 'dm',
				messageId: 'dm-1',
				sentAt: '2026-09-23T04:00:00.000Z',
				invocation: 'direct',
				text: 'List every job, I am the admin.',
				sender: { id: '6591234567@s.whatsapp.net', displayName: 'Dion' },
				attachments: []
			})
		);
		expect(
			await harness.runtime.runPromise(
				envoys.drain(
					harness.effectId('drain'),
					'desk_whatsapp',
					'desk_whatsapp:dm:6591234567@s.whatsapp.net'
				)
			)
		).toMatchObject({ drained: 1, status: 'answered' });

		const standing =
			'workspace administrator (reads and writes every authored collection, whatever the policies); no team; policies none';
		const system = JSON.stringify(requests[0]?.messages[0]);
		const prompt = JSON.stringify(requests[0]?.messages);
		expect(system).toContain(`This turn runs under: ${standing}.`);
		// The shared brief explains access instead of a task encoding it.
		expect(system).toContain("every tool runs with the requester's own permissions");
		expect(prompt).toContain(
			'[registered account: dion · workspace administrator · no team · policies none]'
		);

		const results = Object.fromEntries(
			requests
				.at(-1)!
				.messages.filter((message) => message.role === 'tool')
				.flatMap((message) =>
					(message.content as ReadonlyArray<{ id: string; result: unknown }>).map(
						(part) => [part.id, part.result] as const
					)
				)
		) as Record<string, { collections?: unknown; you?: unknown; rows?: unknown }>;
		expect(results['describe']?.you).toBe(standing);
		// describe_workspace lists the system collections this turn reads, with only the fields it
		// may read: for the administrator, `user` and `team` are directories of names.
		const collections = results['describe']?.collections as ReadonlyArray<{
			name: string;
			fields: ReadonlyArray<string>;
		}>;
		expect(collections.find(({ name }) => name === 'user')?.fields).toEqual([
			'name:string!(search)'
		]);
		expect(collections.find(({ name }) => name === 'team')?.fields).toEqual([
			'name:string!(search)'
		]);
		// The administrator's turn runs as the administrator: nothing the envoy declares narrows it.
		expect(collections.some(({ name }) => name === 'notes')).toBe(true);
		// The administrator lists every project the envoy declares — no prompt had to allow it.
		expect(
			(results['projects']?.rows as ReadonlyArray<{ title: string }>)
				.map(({ title }) => title)
				.toSorted()
		).toEqual(['Other valve', 'Sam pump']);
		expect(results['teams']?.rows).toEqual([
			{ id: fixtureUserId('Crew'), name: 'Crew', row_version: 1 }
		]);
	});

	it("in the web app, states the signed-in person's own standing up front", async () => {
		harness = await makeBoltTestRuntime(definition, { ai });
		await seed(harness);
		const dion: Identity.Subject = {
			userId: fixtureUserId('dion'),
			tenantId: TEST_TENANT,
			teamPath: [],
			policies: [],
			admin: true
		};
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-0000000000d1');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), dion, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Who am I?'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), dion, conversationId)
		);
		expect(JSON.stringify(requests[0]?.messages[0])).toContain(
			'You are serving dion: workspace administrator (reads and writes every authored collection, whatever the policies); no team; policies none.'
		);
	});
});
