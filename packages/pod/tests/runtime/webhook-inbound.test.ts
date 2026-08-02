import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import {
	declaredWebhookBindings,
	webhookInboundDeliverer
} from '../../src/lib/bin/invocation/webhook-inbound.js';
import {
	verifyWebhookSignature,
	webhookSignatureTimestamp,
	webhookTimestampIsFresh
} from '../../src/lib/host/webhooks.js';

const SECRET = 'whsec-9d41c0';

function sign(body: string, secret = SECRET): string {
	return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Only the parts of a manifest the inbound path reads. The rest is irrelevant to this file. */
function manifestWith(origin: Record<string, unknown>): NorbitalManifest {
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

function deliverer(manifest: NorbitalManifest, dispatched: unknown[], nowMs?: number) {
	return webhookInboundDeliverer({
		manifest,
		dispatch: async (command) => {
			dispatched.push(command);
			return { status: 'imported', imported: 1 };
		},
		secrets: (name) => (name === 'REPORTS_SECRET' ? SECRET : undefined),
		log: () => undefined,
		...(nowMs != null ? { now: () => nowMs } : {})
	});
}

/** A binding whose provider signs `<timestamp>.<body>` and sends `t=…,v1=…`, i.e. Stripe's. */
const TIMESTAMPED = manifestWith({
	type: 'webhook',
	authentication: {
		type: 'hmac-sha256',
		secret: { type: 'secret', name: 'REPORTS_SECRET' },
		signatureHeader: 'x-reports-signature',
		timestamp: {}
	},
	eventId: { header: 'x-reports-event-id' }
});

/**
 * One Stripe-shaped header. `signedAt` defaults to `claimedAt`, and the two differing is exactly the
 * forgery the scheme exists to catch: a digest lifted from one delivery pasted beside another time.
 */
function timestamped(
	body: string,
	claimedAt: number,
	options?: { readonly signedAt?: number; readonly secret?: string }
): string {
	const signedAt = options?.signedAt ?? claimedAt;
	const digest = createHmac('sha256', options?.secret ?? SECRET)
		.update(`${signedAt}.${body}`, 'utf8')
		.digest('hex');
	return `t=${claimedAt},v1=${digest}`;
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
		expect(verifyWebhookSignature({ body, signature: right.slice(0, 32), secret: SECRET })).toBe(
			false
		);
		// One byte different, same length — the case a naive compare leaks the position of.
		const flipped = right.slice(0, -1) + (right.at(-1) === '0' ? '1' : '0');
		expect(verifyWebhookSignature({ body, signature: flipped, secret: SECRET })).toBe(false);
	});

	it('refuses a signature over a body that is not the one delivered', () => {
		expect(
			verifyWebhookSignature({ body: `${body} `, signature: sign(body), secret: SECRET })
		).toBe(false);
	});

	it('verifies a timestamp-prefixed signed payload, and refuses one signed for another time', () => {
		const at = 1_614_556_800;
		const scheme = { value: String(at) };
		expect(
			verifyWebhookSignature({
				body,
				signature: timestamped(body, at),
				secret: SECRET,
				timestamp: scheme
			})
		).toBe(true);
		// The assertion the whole scheme turns on: a digest that is genuinely correct for `at - 60`,
		// presented under `t=at`. Signing the body alone would have accepted this without noticing.
		expect(
			verifyWebhookSignature({
				body,
				signature: timestamped(body, at, { signedAt: at - 60 }),
				secret: SECRET,
				timestamp: scheme
			})
		).toBe(false);
		// And a body-only digest cannot be smuggled onto the timestamped binding.
		expect(
			verifyWebhookSignature({
				body,
				signature: `t=${at},v1=${sign(body)}`,
				secret: SECRET,
				timestamp: scheme
			})
		).toBe(false);
	});

	it('reads the digest from the declared element, and honours a rotation sending two', () => {
		const at = 1_614_556_800;
		const right = createHmac('sha256', SECRET).update(`${at}.${body}`, 'utf8').digest('hex');
		const stale = createHmac('sha256', 'previous').update(`${at}.${body}`, 'utf8').digest('hex');
		expect(
			verifyWebhookSignature({
				body,
				signature: `t=${at},v1=${stale},v1=${right}`,
				secret: SECRET,
				timestamp: { value: String(at) }
			})
		).toBe(true);
		// `v0` is another provider's label; a binding declaring `v1` must not accept it.
		expect(
			verifyWebhookSignature({
				body,
				signature: `t=${at},v0=${right}`,
				secret: SECRET,
				timestamp: { value: String(at) }
			})
		).toBe(false);
	});

	it('signs across a declared separator with the timestamp from its own header', () => {
		const at = 1_614_556_800;
		const digest = createHmac('sha256', SECRET).update(`${at}:${body}`, 'utf8').digest('hex');
		const timestamp = { value: String(at), header: 'x-timestamp', separator: ':' };
		expect(verifyWebhookSignature({ body, signature: digest, secret: SECRET, timestamp })).toBe(
			true
		);
		// The separator is part of the signed string, so the default `.` must not also verify.
		expect(
			verifyWebhookSignature({
				body,
				signature: digest,
				secret: SECRET,
				timestamp: { value: String(at), header: 'x-timestamp' }
			})
		).toBe(false);
	});
});

describe('webhookSignatureTimestamp', () => {
	const body = JSON.stringify({ rfi: { number: 'RFI-1' } });

	it('reads `t` from the signature header, or a header of its own when one is declared', () => {
		const signature = timestamped(body, 1_614_556_800);
		expect(webhookSignatureTimestamp({ scheme: {}, headers: {}, signature })).toBe('1614556800');
		expect(
			webhookSignatureTimestamp({
				scheme: { header: 'x-timestamp' },
				headers: { 'x-timestamp': ' 1614556801 ' },
				signature
			})
		).toBe('1614556801');
		// Nothing to read is `undefined`, never a substitute value.
		expect(webhookSignatureTimestamp({ scheme: {}, headers: {}, signature: sign(body) })).toBe(
			undefined
		);
		expect(
			webhookSignatureTimestamp({ scheme: { header: 'x-timestamp' }, headers: {}, signature })
		).toBe(undefined);
	});
});

describe('webhookTimestampIsFresh', () => {
	const nowMs = 1_700_000_000_000;
	const nowSeconds = nowMs / 1000;

	it('accepts inside the window and refuses either side of it', () => {
		expect(webhookTimestampIsFresh({ value: String(nowSeconds - 299), nowMs })).toBe(true);
		expect(webhookTimestampIsFresh({ value: String(nowSeconds - 301), nowMs })).toBe(false);
		// Forward-dated too: a capture stamped next year would otherwise be replayable until then.
		expect(webhookTimestampIsFresh({ value: String(nowSeconds + 301), nowMs })).toBe(false);
		expect(
			webhookTimestampIsFresh({ value: String(nowSeconds - 301), toleranceSeconds: 600, nowMs })
		).toBe(true);
		expect(webhookTimestampIsFresh({ value: 'yesterday', nowMs })).toBe(false);
		expect(webhookTimestampIsFresh({ value: '', nowMs })).toBe(false);
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
		const result = await deliverer(
			SIGNED,
			dispatched
		)({
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
		const result = await deliverer(
			SIGNED,
			dispatched
		)({
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

	describe('a binding whose provider signs a timestamp alongside the body', () => {
		const nowMs = 1_700_000_000_000;
		const at = nowMs / 1000;

		function headers(signature: string) {
			return { 'x-reports-signature': signature, 'x-reports-event-id': 'evt_1' };
		}

		function deliver(signature: string, clockMs = nowMs) {
			const dispatched: unknown[] = [];
			return deliverer(
				TIMESTAMPED,
				dispatched,
				clockMs
			)({
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				body,
				headers: headers(signature)
			}).then((result) => ({ result, dispatched }));
		}

		it('imports a delivery signed over `<timestamp>.<body>` inside the window', async () => {
			const { result, dispatched } = await deliver(timestamped(body, at));
			expect(result).toEqual({ status: 'imported', imported: 1 });
			expect(dispatched).toHaveLength(1);
		});

		it('rejects a digest that is valid for a different timestamp', async () => {
			// Correct secret, correct body, correct-for-`at - 60` digest, presented as `t=at`. The only
			// thing wrong with it is the thing the timestamp is in the signed string to protect.
			const { result, dispatched } = await deliver(timestamped(body, at, { signedAt: at - 60 }));
			expect(result).toEqual({ status: 'rejected', reason: 'signature did not verify' });
			expect(dispatched).toEqual([]);
		});

		it('rejects a perfectly valid delivery replayed outside the window', async () => {
			const captured = timestamped(body, at);
			// The same bytes that imported a moment ago, replayed an hour later. Nothing about the
			// signature has changed — only the clock has, which is the entire point.
			const { result, dispatched } = await deliver(captured, nowMs + 3_600_000);
			expect(result).toEqual({
				status: 'rejected',
				reason: 'delivery is outside the replay window'
			});
			expect(dispatched).toEqual([]);
			// And a delivery dated an hour into the future is refused the same way.
			const forward = await deliver(timestamped(body, at + 3600));
			expect(forward.result.reason).toBe('delivery is outside the replay window');
			expect(forward.dispatched).toEqual([]);
		});

		it('rejects a delivery carrying no timestamp rather than falling back to the body alone', async () => {
			// A body-only signature, which this secret genuinely produced. Accepting it would let a
			// sender pick the weaker, windowless scheme by leaving `t=` out.
			const { result, dispatched } = await deliver(sign(body));
			expect(result).toEqual({
				status: 'rejected',
				reason: 'delivery carries no signature timestamp'
			});
			expect(dispatched).toEqual([]);
		});
	});

	describe('a binding that narrows the event types it accepts', () => {
		const byHeader = manifestWith({
			type: 'webhook',
			events: ['charge.succeeded'],
			eventType: { header: 'x-reports-event-type' },
			authentication: {
				type: 'hmac-sha256',
				secret: { type: 'secret', name: 'REPORTS_SECRET' },
				signatureHeader: 'x-reports-signature'
			}
		});
		const byPath = manifestWith({
			type: 'webhook',
			events: ['charge.succeeded'],
			eventType: { path: 'event.type' },
			authentication: {
				type: 'hmac-sha256',
				secret: { type: 'secret', name: 'REPORTS_SECRET' },
				signatureHeader: 'x-reports-signature'
			}
		});

		async function deliver(manifest: NorbitalManifest, payload: string, eventType?: string) {
			const dispatched: unknown[] = [];
			const result = await deliverer(
				manifest,
				dispatched
			)({
				integrationName: 'field_reports',
				bindingName: 'rfis.receive.rfi',
				body: payload,
				headers: {
					'x-reports-signature': sign(payload),
					...(eventType ? { 'x-reports-event-type': eventType } : {})
				}
			});
			return { result, dispatched };
		}

		it('imports the declared event type and rejects one it did not declare', async () => {
			const accepted = await deliver(byHeader, body, 'charge.succeeded');
			expect(accepted.result).toEqual({ status: 'imported', imported: 1 });

			// Correctly signed, brand new, and simply not this binding's business.
			const refused = await deliver(byHeader, body, 'charge.refunded');
			expect(refused.result).toEqual({
				status: 'rejected',
				reason: 'event type "charge.refunded" is not declared here'
			});
			expect(refused.dispatched).toEqual([]);
		});

		it('rejects a delivery that names no event type at all', async () => {
			const { result, dispatched } = await deliver(byHeader, body);
			expect(result).toEqual({ status: 'rejected', reason: 'delivery names no event type' });
			expect(dispatched).toEqual([]);
		});

		it('reads the event type from a declared body path', async () => {
			const succeeded = JSON.stringify({ event: { type: 'charge.succeeded' } });
			expect((await deliver(byPath, succeeded)).result).toEqual({
				status: 'imported',
				imported: 1
			});
			const refunded = JSON.stringify({ event: { type: 'charge.refunded' } });
			const refused = await deliver(byPath, refunded);
			expect(refused.result.status).toBe('rejected');
			expect(refused.dispatched).toEqual([]);
			// A path that runs off the object, and a leaf that is not a string, are both "no event type"
			// rather than something coerced into one.
			expect((await deliver(byPath, JSON.stringify({ event: 7 }))).result.reason).toBe(
				'delivery names no event type'
			);
			expect(
				(await deliver(byPath, JSON.stringify({ event: { type: ['charge.succeeded'] } }))).result
					.reason
			).toBe('delivery names no event type');
		});

		it('refuses everything when the narrowing has no declared source to evaluate', async () => {
			// `defineWorkspace` will not emit this; a manifest that reaches here with it went around the
			// compiler, and importing everything would be the restriction silently meaning nothing.
			const unevaluable = manifestWith({
				type: 'webhook',
				events: ['charge.succeeded'],
				authentication: {
					type: 'hmac-sha256',
					secret: { type: 'secret', name: 'REPORTS_SECRET' },
					signatureHeader: 'x-reports-signature'
				}
			});
			const { result, dispatched } = await deliver(unevaluable, body, 'charge.succeeded');
			expect(result).toEqual({ status: 'rejected', reason: 'event narrowing is not evaluable' });
			expect(dispatched).toEqual([]);
		});
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
