import { Effect, Option, Redacted } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	PUBLIC_WORKSPACE_ROOT_CONFIG_KEY,
	type AIRequest,
	type AIResponse,
	type TransactionalMailRequest,
	type TransactionalMailResponse,
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
 * An invitation's link is minted by the runtime beneath the host's declared workspace root, and
 * the invitation is transactional mail: the host's mail facility renders and sends it.
 */
describe('inviting somebody to a workspace', () => {
	it('sends a notice that carries the subject, the text and a link into the shell', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async () => ({ _tag: 'Failure', error: { code: 'unused', message: 'unused' } }) as never
		};
		const notices: Array<TransactionalMailRequest> = [];
		const mail: FacilityBinding<TransactionalMailRequest, TransactionalMailResponse> = {
			call: async (_metadata, request) => {
				notices.push(request);
				return { _tag: 'Success', value: { id: `mail-${notices.length}` } };
			}
		};
		harness = await makeBoltTestRuntime(testWorkspace(), { ai, mail });
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
		// Transactional mail, never a channel: a host-owned template renders it from this data.
		expect(notices).toHaveLength(1);
		const notice = notices[0]!;
		expect(notice).toMatchObject({
			kind: 'workspace_invitation',
			to: 'invitee@example.test',
			data: { invitationId, workspace: 'test-tenant' }
		});
		expect(JSON.stringify(notice.data)).toContain(
			`https://host.example/__bolt/invitation?workspace=test-tenant&claim=${encodeURIComponent(invitationId)}`
		);
	});
});
