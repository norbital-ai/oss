import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, policy } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import { ADMIN_STATUS } from '../src/runtime/identity/identity.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import { scriptedTranscript } from './agents-canonical-ai-fixture.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';

/**
 * Who may read which conversation.
 *
 * A member reads their own conversations, the conversations they took part in, and every
 * conversation of a `public` envoy. An `authenticated` envoy's chat stays with its participants.
 * An administrator reads all of them. Nothing here is about writing: sending stays with the owner.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const CONTRACTORS = 'Contractors';
const MEMBERS = 'Members';

const workspace = testWorkspace({
	apps: [app({ name: 'home', label: 'Home' })],
	policies: [
		policy({
			name: 'members',
			effect: 'allow',
			capabilities: { apps: ['home'] },
			grants: [{ collection: 'people', action: 'read' }]
		}),
		policy({
			name: 'whatsapp_contractor',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'update' }]
		})
	],
	teams: { [MEMBERS]: ['members'], [CONTRACTORS]: ['members', 'whatsapp_contractor'] },
	envoys: [
		{
			name: 'wa_private',
			channel: 'whatsapp',
			audience: 'authenticated',
			policies: ['whatsapp_contractor'],
			task: 'Answer contractors.',
			delegation: 'disabled'
		},
		{
			name: 'wa_public',
			channel: 'whatsapp_public',
			audience: 'public',
			policies: ['whatsapp_contractor'],
			task: 'Answer anyone.',
			delegation: 'disabled'
		}
	]
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const subject = (user: string, team: string): Identity.Subject => ({
	userId: fixtureUserId(user),
	tenantId: 'test-tenant',
	teamPath: [team],
	policies: []
});
/** The subject an envoy's turn runs under for a linked sender: the envoy's policies, held directly. */
const viaEnvoy = (user: string): Identity.Subject => ({
	userId: fixtureUserId(user),
	tenantId: 'test-tenant',
	teamPath: [],
	policies: ['whatsapp_contractor'],
	admin: false
});

const conversation = (suffix: string) =>
	ConversationId.make(`00000000-0000-4000-8000-0000000007${suffix}`);
const ALICE_WEB = conversation('01');
const ALICE_PRIVATE = conversation('02');
const ALICE_PUBLIC = conversation('03');
const BOB_PRIVATE = conversation('04');

const open = (
	runtime: BoltTestRuntime,
	label: string,
	who: Identity.Subject,
	conversationId: ConversationId,
	agentId: string
) =>
	runtime.runtime.runPromise(
		Effect.flatMap(Agents.Service, (agents) =>
			agents.submit(runtime.effectId(`visibility:${label}`), who, {
				conversationId,
				agentId: AgentId.make(agentId),
				message: Agents.userAgentInput(`Hello from ${label}`),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		)
	);

const readIds = async (runtime: BoltTestRuntime, token: string, collection: string) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(
			Invocation.cases.Command.make({
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make(`visibility-read-${token}-${collection}`),
				scope,
				command: 'collections.export',
				input: { collection, limit: 50 } as never,
				headers: { authorization: [`Bearer ${token}`] }
			})
		).pipe(Effect.result)
	);
	if (outcome._tag !== 'Success')
		throw new Error(`${collection} was refused to ${token}: ${JSON.stringify(outcome)}`);
	const rows = outcome.success.value;
	if (!Array.isArray(rows)) throw new Error(`expected rows from ${collection}`);
	return new Set((rows as ReadonlyArray<Record<string, unknown>>).map((row) => row['id']));
};

const seed = async (runtime: BoltTestRuntime) => {
	await seedSession(runtime, { token: 'alice', user: 'alice', team: CONTRACTORS });
	await seedSession(runtime, { token: 'bob', user: 'bob', team: CONTRACTORS });
	await seedSession(runtime, { token: 'carol', user: 'carol', team: MEMBERS });
	await seedSession(runtime, { token: 'admin', user: 'admin', status: ADMIN_STATUS });
	await open(runtime, 'alice-web', subject('alice', CONTRACTORS), ALICE_WEB, 'web');
	await open(runtime, 'alice-private', viaEnvoy('alice'), ALICE_PRIVATE, 'wa_private');
	await open(runtime, 'alice-public', viaEnvoy('alice'), ALICE_PUBLIC, 'wa_public');
	await open(runtime, 'bob-private', viaEnvoy('bob'), BOB_PRIVATE, 'wa_private');
	// Alice posts into Bob's group chat: she is a participant there, not its owner.
	await open(runtime, 'alice-in-bob', viaEnvoy('alice'), BOB_PRIVATE, 'wa_private');
};

describe('conversation visibility', () => {
	it('a member sees their own, the ones they took part in, and every public envoy chat', async () => {
		harness = await makeBoltTestRuntime(workspace, { ai: scriptedTranscript([]).ai });
		await seed(harness);

		expect(await readIds(harness, 'alice', 'conversation')).toEqual(
			new Set([ALICE_WEB, ALICE_PRIVATE, ALICE_PUBLIC, BOB_PRIVATE])
		);
		expect(await readIds(harness, 'bob', 'conversation')).toEqual(
			new Set([ALICE_PUBLIC, BOB_PRIVATE])
		);
		expect(await readIds(harness, 'carol', 'conversation')).toEqual(new Set([ALICE_PUBLIC]));
	});

	it('scopes messages by the same rule', async () => {
		harness = await makeBoltTestRuntime(workspace, { ai: scriptedTranscript([]).ai });
		await seed(harness);

		const conversationsOf = async (token: string) => {
			const outcome = await harness!.runtime.runPromise(
				dispatchInvocation(
					Invocation.cases.Command.make({
						protocolVersion: PROTOCOL_VERSION,
						id: InvocationId.make(`visibility-messages-${token}`),
						scope,
						command: 'collections.export',
						input: { collection: 'conversation_message', limit: 50 } as never,
						headers: { authorization: [`Bearer ${token}`] }
					})
				)
			);
			return new Set(
				(outcome.value as ReadonlyArray<Record<string, unknown>>).map(
					(row) => row['conversation_id']
				)
			);
		};
		expect(await conversationsOf('carol')).toEqual(new Set([ALICE_PUBLIC]));
		expect(await conversationsOf('bob')).toEqual(new Set([ALICE_PUBLIC, BOB_PRIVATE]));
	});

	it('an administrator sees every conversation', async () => {
		harness = await makeBoltTestRuntime(workspace, { ai: scriptedTranscript([]).ai });
		await seed(harness);

		expect(await readIds(harness, 'admin', 'conversation')).toEqual(
			new Set([ALICE_WEB, ALICE_PRIVATE, ALICE_PUBLIC, BOB_PRIVATE])
		);
	});
});
