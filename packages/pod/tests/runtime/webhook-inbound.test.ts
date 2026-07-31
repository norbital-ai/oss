import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import {
	declaredWebhookBindings,
	webhookInboundDeliverer
} from '../../src/lib/bin/invocation/webhook-inbound.js';
import { verifyWebhookSignature } from '../../src/lib/host/webhooks.js';

const SECRET = 'whsec-9d41c0';

function sign(body: string, secret = SECRET): string {
	return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Only the parts of a manifest the inbound path reads. The rest is irrelevant to this file. */
function manifestWith(
	origin: Record<string, unknown>
): NorbitalManifest {
	return {
		integrations: {
			field_reports: {
				name: 'field_reports',
				definition: {
					inbound: { 'rfis.receive.rfi': { collection: 'rfis', pipeline: 'import', origin } },
					outbound: {}
				}
			}
		}
	} as unknown as NorbitalManifest;
}

const SIGNED = manifestWith({
	type: 'webhook',
	authentication: {
		type: 'hmac-sha256',
		secret: { type: 'secret', name: 'REPORTS_SECRET' },
		signatureHeader: 'x-reports-signature'
	},
	eventId: { header: 'x-reports-event-id' }
});

function deliverer(manifest: NorbitalManifest, dispatched: unknown[]) {
	return webhookInboundDeliverer({
		manifest,
		dispatch: async (command) => {
			dispatched.push(command);
			return { status: 'imported', imported: 1 };
		},
		secrets: (name) => (name === 'REPORTS_SECRET' ? SECRET : undefined),
		log: () => undefined
	});
}

describe('verifyWebhookSignature', () => {
	const body = JSON.stringify({ rfi: { number: 'RFI-1' } });

	it('accepts the digest in every encoding a provider might send it in', () => {
		const digest = createHmac('sha256', SECRET).update(body, 'utf8').digest();
		for (const signature of [
			digest.toString('hex'),
			digest.toString('hex').toUpperCase(),
			`sha256=${digest.toString('hex')}`,
			`v0=${digest.toString('hex')}`,
			digest.toString('base64')
		]) {
			expect(verifyWebhookSignature({ body, signature, secret: SECRET }), signature).toBe(true);
		}
	});

	it('refuses a digest made with another secret, an absent one, and a truncated one', () => {
		const right = sign(body);
		expect(verifyWebhookSignature({ body, signature: sign(body, 'other'), secret: SECRET })).toBe(
			false
		);
		expect(verifyWebhookSignature({ body, signature: undefined, secret: SECRET })).toBe(false);
		expect(verifyWebhookSignature({ body, signature: '', secret: SECRET })).toBe(false);
		// A prefix of the correct digest: the length check has to reject it rather than throw.
		expect(
			verifyWebhookSignature({ body, signature: right.slice(0, 32), secret: SECRET })
		).toBe(false);
		// One byte different, same length — the case a naive compare leaks the position of.
		const flipped = right.slice(0, -1) + (right.at(-1) === '0' ? '1' : '0');
		expect(verifyWebhookSignature({ body, signature: flipped, secret: SECRET })).toBe(false);
	});

	it('refuses a signature over a body that is not the one delivered', () => {
		expect(
			verifyWebhookSignature({ body: `${body} `, signature: sign(body), secret: SECRET })
		).toBe(false);
	});
});

describe('declaredWebhookBindings', () => {
	it('names each webhook binding, its headers, and whether it is signed', () => {
		expect(declaredWebhookBindings(SIGNED)).toEqual([
			{
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				collectionName: 'rfis',
				signed: true,
				signatureHeader: 'x-reports-signature',
				eventIdHeader: 'x-reports-event-id'
			}
		]);
	});

	it('ignores pull and system-event bindings, which have no endpoint', () => {
		const pull = manifestWith({
			type: 'api-pull',
			schedule: '* * * * *',
			url: 'https://example.invalid/x'
		});
		expect(declaredWebhookBindings(pull)).toEqual([]);
	});
});

describe('webhookInboundDeliverer', () => {
	const body = JSON.stringify({ rfi: { number: 'RFI-7' } });

	it('verifies before dispatching, and passes the provider event id through', async () => {
		const dispatched: unknown[] = [];
		const result = await deliverer(SIGNED, dispatched)({
			integrationName: 'field_reports',
			bindingName: 'rfis.receive.rfi',
			body,
			headers: { 'x-reports-signature': sign(body), 'x-reports-event-id': 'evt_1' }
		});
		expect(result).toEqual({ status: 'imported', imported: 1 });
		expect(dispatched).toEqual([
			{
				kind: 'integration',
				direction: 'receive',
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				collectionName: 'rfis',
				importData: { rfi: { number: 'RFI-7' } },
				eventId: 'evt_1'
			}
		]);
	});

	it('dispatches nothing at all when the signature is wrong', async () => {
		const dispatched: unknown[] = [];
		const result = await deliverer(SIGNED, dispatched)({
			integrationName: 'field_reports',
			bindingName: 'rfis.receive.rfi',
			body,
			headers: { 'x-reports-signature': sign(body, 'stolen'), 'x-reports-event-id': 'evt_1' }
		});
		expect(result.status).toBe('rejected');
		// The assertion that matters: a failed verification never reaches the runtime, so it cannot
		// import, cannot claim a ledger row, and cannot be distinguished by side effect from silence.
		expect(dispatched).toEqual([]);
	});

	it('refuses everything when the host cannot resolve the declared secret', async () => {
		const dispatched: unknown[] = [];
		const deliver = webhookInboundDeliverer({
			manifest: SIGNED,
			dispatch: async (command) => {
				dispatched.push(command);
				return { status: 'imported', imported: 1 };
			},
			secrets: () => undefined,
			log: () => undefined
		});
		const result = await deliver({
			integrationName: 'field_reports',
			bindingName: 'rfis.receive.rfi',
			body,
			headers: { 'x-reports-signature': sign(body) }
		});
		expect(result.status).toBe('rejected');
		expect(dispatched).toEqual([]);
	});

	it('falls back to a digest of the body when the provider sends no event id', async () => {
		const dispatched: { eventId?: string }[] = [];
		const deliver = deliverer(SIGNED, dispatched as unknown[]);
		const delivery = {
			integrationName: 'field_reports',
			bindingName: 'rfis.receive.rfi',
			body,
			headers: { 'x-reports-signature': sign(body) }
		};
		await deliver(delivery);
		await deliver(delivery);
		// The same bytes have to produce the same key, or a redelivery would look new and the ledger
		// would be present and useless.
		expect(dispatched[0]?.eventId).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(dispatched[1]?.eventId).toBe(dispatched[0]?.eventId);
	});

	it('rejects an unknown binding and a body that is not JSON', async () => {
		const dispatched: unknown[] = [];
		const deliver = deliverer(SIGNED, dispatched);
		expect(
			(
				await deliver({
					integrationName: 'field_reports',
					bindingName: 'rfis.receive.nope',
					body,
					headers: { 'x-reports-signature': sign(body) }
				})
			).status
		).toBe('rejected');
		const notJson = 'this is not json';
		expect(
			(
				await deliver({
					integrationName: 'field_reports',
					bindingName: 'rfis.receive.rfi',
					body: notJson,
					headers: { 'x-reports-signature': sign(notJson) }
				})
			).status
		).toBe('rejected');
		expect(dispatched).toEqual([]);
	});

	it('reports the runtime refusing a payload, distinctly from rejecting one', async () => {
		const deliver = webhookInboundDeliverer({
			manifest: SIGNED,
			dispatch: async () => ({ status: 'refused', imported: 0, reason: 'invalid_type' }),
			secrets: () => SECRET,
			log: () => undefined
		});
		expect(
			await deliver({
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				body,
				headers: { 'x-reports-signature': sign(body) }
			})
		).toEqual({ status: 'refused', imported: 0, reason: 'invalid_type' });
	});

	it('reports a duplicate the runtime already claimed', async () => {
		const deliver = webhookInboundDeliverer({
			manifest: SIGNED,
			dispatch: async () => ({ status: 'duplicate', imported: 0 }),
			secrets: () => SECRET,
			log: () => undefined
		});
		expect(
			await deliver({
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				body,
				headers: { 'x-reports-signature': sign(body) }
			})
		).toEqual({ status: 'duplicate', imported: 0 });
	});
});
