import { Effect } from 'effect';
import {
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding,
	type FacilityCall
} from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Identity from '../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const recordingCommunication = () => {
	const calls: Array<Readonly<{ metadata: FacilityCall; request: CommunicationRequest }>> = [];
	let failNext = false;
	const binding: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
		call: async (metadata, request) => {
			calls.push({ metadata, request });
			if (failNext) {
				failNext = false;
				return {
					_tag: 'Failure',
					error: {
						code: 'provider_temporarily_unavailable',
						message: 'try again',
						retryable: true,
						outcome: 'unknown'
					}
				};
			}
			return { _tag: 'Success', value: {} };
		}
	};
	return {
		binding,
		calls,
		failOnce: () => {
			failNext = true;
		}
	};
};

const sendCode = (runtime: BoltTestRuntime, effectId: string, email: string) =>
	runtime.runtime.runPromise(
		Effect.flatMap(Identity.Service, (identity) =>
			identity.sendCode(runtime.effectId(effectId), email)
		)
	);

describe('direct sign-in code delivery', () => {
	it('persists challenges and submits known and unknown addresses directly to the provider', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId")
			 values (md5('known'::text)::uuid, 'Known', 'known@example.test', 'test-tenant')`,
			[]
		);

		await sendCode(harness, 'challenge-known', 'known@example.test');
		await sendCode(harness, 'challenge-unknown', 'unknown@example.test');

		// Both address states persist the challenge and take the same provider path, so the response
		// cannot be used as an account-existence oracle.
		expect(communication.calls.map(({ request }) => request)).toEqual([
			expect.objectContaining({ _tag: 'Send', recipient: 'known@example.test' }),
			expect.objectContaining({ _tag: 'Send', recipient: 'unknown@example.test' })
		]);
		expect(communication.calls.map(({ metadata }) => metadata.idempotencyKey)).toEqual([
			'challenge-known:code-delivery',
			'challenge-unknown:code-delivery'
		]);
		const verification = await harness.database.query(
			`select identifier, value from "verification" order by identifier`,
			[]
		);
		expect(verification).toHaveLength(2);
		const tasks = await harness.database.query(
			`select command, effect_id, status from bolt_task where command = 'identity.deliverCode'`,
			[]
		);
		expect(tasks).toEqual([]);
		expect(harness.tasks.requests.some((request) => request._tag === 'Wake')).toBe(false);
	});

	it('surfaces a provider rejection and allows the caller to request a fresh code', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		communication.failOnce();
		await expect(sendCode(harness, 'challenge-rejected', 'retry@example.test')).rejects.toBeDefined();
		await sendCode(harness, 'challenge-retry', 'retry@example.test');
		expect(communication.calls.map(({ metadata }) => String(metadata.idempotencyKey))).toEqual([
			'challenge-rejected:code-delivery',
			'challenge-retry:code-delivery'
		]);
		expect(communication.calls.map(({ request }) => request)).toEqual([
			expect.objectContaining({ _tag: 'Send', recipient: 'retry@example.test' }),
			expect.objectContaining({ _tag: 'Send', recipient: 'retry@example.test' })
		]);
		expect(
			await harness.database.query(
				`select effect_id from bolt_task where command = 'identity.deliverCode'`,
				[]
			)
		).toEqual([]);
	});

	it('refuses the request and leaves no courier when challenge persistence fails', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		await harness.database.query('drop table "verification"', []);

		await expect(sendCode(harness, 'challenge-unpersisted', 'lost@example.test')).rejects.toBeDefined();
		expect(communication.calls).toEqual([]);
	});
});
