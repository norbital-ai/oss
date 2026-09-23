import { Effect, Option, Redacted } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	PUBLIC_WORKSPACE_ROOT_CONFIG_KEY,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import { HostConfig } from '../src/runtime/access/system-principal.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import {
	makeBoltTestRuntime,
	receiveChat,
	recordingCommunication,
	testChannels,
	type BoltTestRuntime,
	type TestChatDelivery
} from './support/bolt-test-layer.js';

const definition = workspace({
	name: 'envoy-registration-redeem',
	version: '1',
	collections: [],
	apps: [],
	policies: [
		policy({ name: 'operator', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {},
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	channels: testChannels('whatsapp'),
	envoys: [
		envoy({
			name: 'field_ops_whatsapp',
			channel: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			groupMessages: 'mention_or_reply',
			delegation: 'disabled',
			task: 'Handle field updates.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const delivery: TestChatDelivery = {
	conversationId: '6591234567@s.whatsapp.net',
	conversationKind: 'dm',
	messageId: 'hello',
	sentAt: '2026-09-16T00:00:00.000Z',
	invocation: 'direct',
	text: 'hello',
	sender: { id: '6591234567@s.whatsapp.net', displayName: 'Dion' },
	attachments: []
};

const person = (userId: string): Identity.Subject => ({
	userId,
	tenantId: 'test-tenant',
	teamPath: [],
	policies: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * A registration link, opened again by the person who redeemed it, is a success: their number is
 * registered, which is what they came to make true. The claim page redeems on every signed-in
 * load, so a sign-in reload lands here — it used to read as "already registered" and stop.
 */
describe('redeeming an envoy registration', () => {
	it('answers registered once, already_registered for the same person, used for anyone else', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async () => ({ _tag: 'Failure', error: { code: 'unused', message: 'unused' } }) as never
		};
		const { sends, binding: communication } = recordingCommunication();
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId") values
			 (md5('dion'::text)::uuid, 'Dion', 'dion@example.test', 'test-tenant'),
			 (md5('other'::text)::uuid, 'Other', 'other@example.test', 'test-tenant')`,
			[]
		);
		const [ids] = await harness.database.query(
			`select md5('dion')::uuid as dion, md5('other')::uuid as other`,
			[]
		);
		const dion = String(ids!['dion']);
		const other = String(ids!['other']);
		const envoys = await harness.runtime.runPromise(Envoys.Service);

		const received = await harness.runtime.runPromise(
			receiveChat('whatsapp', delivery).pipe(
				Effect.provideService(HostConfig, {
					read: (key) =>
						Effect.succeed(
							key === PUBLIC_WORKSPACE_ROOT_CONFIG_KEY
								? Option.some(Redacted.make('https://host.example/__bolt/'))
								: Option.none()
						)
				})
			)
		);
		// An unknown sender is history, not work: nothing admitted, a notice sent instead.
		expect(received.admitted).toEqual([]);
		const [claim] = await harness.database.query(
			`select link_id from bolt_channel_links where status = 'pending'`,
			[]
		);
		const claimId = String(claim!['link_id']);
		// The notice carries a complete link beneath the host's declared workspace root: the runtime
		// mints it, so any host that says where it lives gets a working link without rewriting.
		const notice = sends[0]?.message;
		expect(JSON.stringify(notice)).toContain(
			`https://host.example/__bolt/envoy-registration?workspace=test-tenant&claim=${encodeURIComponent(claimId)}`
		);

		const redeem = (label: string, who: Identity.Subject) =>
			harness!.runtime.runPromise(
				envoys.redeemRegistration(harness!.effectId(`redeem:${label}`), claimId, who)
			);
		expect(await redeem('first', person(dion))).toMatchObject({ state: 'registered' });
		expect(await redeem('again', person(dion))).toMatchObject({ state: 'already_registered' });
		expect(await redeem('other', person(other))).toEqual({ state: 'used' });
	});
});
