import { Effect, Option, Redacted } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	PUBLIC_WORKSPACE_ROOT_CONFIG_KEY,
	type AIRequest,
	type AIResponse,
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { HostConfig } from '../src/runtime/access/system-principal.js';
import * as Identity from '../src/runtime/identity/identity.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/**
 * An invitation is written by the runtime, link included, beneath the host's declared workspace
 * root. The host's mailer only sends it: what an invitee reads is the workspace's own, and a host
 * that has said where it serves the shell gets a working link without composing anything.
 */
describe('inviting somebody to a workspace', () => {
	it('sends a notice that carries the subject, the text and a link into the shell', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async () => ({ _tag: 'Failure', error: { code: 'unused', message: 'unused' } }) as never
		};
		const notices: Array<CommunicationRequest> = [];
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				notices.push(request);
				return { _tag: 'Success', value: { receipt: { id: `wire-${notices.length}` } } };
			}
		};
		harness = await makeBoltTestRuntime(testWorkspace(), { ai, communication });
		const identity = await harness.runtime.runPromise(Identity.Service);
		const invitationId = await harness.runtime.runPromise(
			identity
				.invite(harness.effectId('invite'), 'test-tenant', 'Invitee@Example.test', 'admin-1')
				.pipe(
					Effect.provideService(HostConfig, {
						read: (key) =>
							Effect.succeed(
								key === PUBLIC_WORKSPACE_ROOT_CONFIG_KEY
									? Option.some(Redacted.make('https://host.example/__bolt'))
									: Option.none()
							)
					})
				)
		);
		const notice = notices.find((request) => request._tag === 'Notify');
		expect(notice?._tag).toBe('Notify');
		if (notice?._tag !== 'Notify') return;
		expect(notice.recipient).toBe('invitee@example.test');
		expect(notice.payload).toMatchObject({
			kind: 'workspace_invitation',
			invitationId,
			subject: 'You have been invited to test-tenant'
		});
		expect(JSON.stringify(notice.payload)).toContain(
			`https://host.example/__bolt/invitation?workspace=test-tenant&claim=${encodeURIComponent(invitationId)}`
		);
	});
});
