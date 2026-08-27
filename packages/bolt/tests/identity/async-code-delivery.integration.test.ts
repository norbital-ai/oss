import { Effect, Schema } from 'effect';
import {
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding,
	type FacilityCall
} from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Identity from '../../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

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

describe('durable sign-in code delivery', () => {
	it('persists challenges and courier tasks for known and unknown addresses before touching the provider', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId")
			 values (md5('known'::text)::uuid, 'Known', 'known@example.test', 'test-tenant')`,
			[]
		);

		await sendCode(harness, 'challenge-known', 'known@example.test');
		await sendCode(harness, 'challenge-unknown', 'unknown@example.test');

		// The HTTP-side operation performs no provider I/O. Both address states take the same two
		// durable writes, so its success cannot be used as an account-existence oracle.
		expect(communication.calls).toEqual([]);
		const verification = await harness.database.query(
			`select identifier, value from "verification" order by identifier`,
			[]
		);
		expect(verification).toHaveLength(2);
		const tasks = await harness.database.query(
			`select command, effect_id, input, status from bolt_task order by effect_id`,
			[]
		);
		expect(tasks).toHaveLength(2);
		expect(tasks.map((row) => row['command'])).toEqual([
			Identity.DELIVER_CODE_COMMAND,
			Identity.DELIVER_CODE_COMMAND
		]);
		expect(tasks.map((row) => row['status'])).toEqual(['pending', 'pending']);
		expect(harness.tasks.requests.some((request) => request._tag === 'Wake')).toBe(true);

		const delivery = Schema.decodeUnknownSync(Identity.CodeDelivery)(tasks[1]?.['input']);
		expect(
			verification.some((row) => String(row['value']).startsWith(`${delivery.code}:`))
		).toBe(true);
	});

	it('reuses one provider idempotency key across attempts and never sends an expired code', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		await sendCode(harness, 'challenge-retry', 'retry@example.test');
		const current = harness;
		const [task] = await harness.database.query(
			`select input from bolt_task where command = $1`,
			[Identity.DELIVER_CODE_COMMAND]
		);
		const delivery = Schema.decodeUnknownSync(Identity.CodeDelivery)(task?.['input']);

		const deliver = (attempt: string, input: Identity.CodeDelivery) =>
			current.runtime.runPromise(
				Effect.flatMap(Identity.Service, (identity) =>
					identity.deliverCode(current.effectId(attempt), input)
				)
			);
		communication.failOnce();
		// The failure is not swallowed: dispatch hands its retryable bit to the durable task runner.
		await expect(deliver('attempt-1', delivery)).rejects.toBeDefined();
		expect(await deliver('attempt-2', delivery)).toBe(true);
		expect(communication.calls.map(({ metadata }) => String(metadata.idempotencyKey))).toEqual([
			delivery.deliveryId,
			delivery.deliveryId
		]);
		expect(communication.calls.map(({ request }) => request)).toEqual([
			expect.objectContaining({ _tag: 'Send', recipient: delivery.email }),
			expect.objectContaining({ _tag: 'Send', recipient: delivery.email })
		]);

		const expired = { ...delivery, expiresAtEpochMs: 0 };
		expect(await deliver('attempt-expired', expired)).toBe(false);
		expect(communication.calls).toHaveLength(2);
	});

	it('refuses the request and leaves no courier when challenge persistence fails', async () => {
		const communication = recordingCommunication();
		harness = await makeBoltTestRuntime(undefined, { communication: communication.binding });
		await harness.database.query('drop table "verification"', []);

		await expect(sendCode(harness, 'challenge-unpersisted', 'lost@example.test')).rejects.toBeDefined();
		expect(await harness.database.query('select effect_id from bolt_task', [])).toEqual([]);
		expect(communication.calls).toEqual([]);
	});
});
