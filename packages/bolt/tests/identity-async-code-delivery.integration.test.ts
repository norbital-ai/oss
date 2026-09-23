import { Effect } from 'effect';
import {
	type TransactionalMailRequest,
	type TransactionalMailResponse,
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

const recordingMail = () => {
	const calls: Array<Readonly<{ metadata: FacilityCall; request: TransactionalMailRequest }>> = [];
	let failNext = false;
	const binding: FacilityBinding<TransactionalMailRequest, TransactionalMailResponse> = {
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
		const mail = recordingMail();
		harness = await makeBoltTestRuntime(undefined, { mail: mail.binding });
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId")
			 values (md5('known'::text)::uuid, 'Known', 'known@example.test', 'test-tenant')`,
			[]
		);

		await sendCode(harness, 'challenge-known', 'known@example.test');
		await sendCode(harness, 'challenge-unknown', 'unknown@example.test');

		// Both address states persist the challenge and take the same provider path, so the response
		// cannot be used as an account-existence oracle.
		expect(mail.calls.map(({ request }) => request)).toEqual([
			expect.objectContaining({ kind: 'sign_in_code', to: 'known@example.test' }),
			expect.objectContaining({ kind: 'sign_in_code', to: 'unknown@example.test' })
		]);
		expect(mail.calls.map(({ metadata }) => metadata.idempotencyKey)).toEqual([
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
		const mail = recordingMail();
		harness = await makeBoltTestRuntime(undefined, { mail: mail.binding });
		mail.failOnce();
		await expect(
			sendCode(harness, 'challenge-rejected', 'retry@example.test')
		).rejects.toBeDefined();
		await sendCode(harness, 'challenge-retry', 'retry@example.test');
		expect(mail.calls.map(({ metadata }) => String(metadata.idempotencyKey))).toEqual([
			'challenge-rejected:code-delivery',
			'challenge-retry:code-delivery'
		]);
		expect(mail.calls.map(({ request }) => request)).toEqual([
			expect.objectContaining({ kind: 'sign_in_code', to: 'retry@example.test' }),
			expect.objectContaining({ kind: 'sign_in_code', to: 'retry@example.test' })
		]);
		expect(
			await harness.database.query(
				`select effect_id from bolt_task where command = 'identity.deliverCode'`,
				[]
			)
		).toEqual([]);
	});

	it('refuses the request and leaves no courier when challenge persistence fails', async () => {
		const mail = recordingMail();
		harness = await makeBoltTestRuntime(undefined, { mail: mail.binding });
		await harness.database.query('drop table "verification"', []);

		await expect(
			sendCode(harness, 'challenge-unpersisted', 'lost@example.test')
		).rejects.toBeDefined();
		expect(mail.calls).toEqual([]);
	});
});
