import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '../../src/authoring/integration-introspection.js';
import { defineWebhook } from '../../src/authoring/workspace-schema.js';
import type {
	IntegrationDeclaration,
	IntegrationWebhookDeclaration
} from '../../src/authoring/workspace-schema.js';
import {
	runWebhookDelivery,
	type LedgerState,
	type WebhookDependencies
} from '../../src/runtime/integrations/webhook.js';

/**
 * What an inbound binding refuses, and what it lets through.
 *
 * Every test here is a refusal the platform has to make correctly, because the failure mode of a
 * webhook is the opposite of a pull's: a pull that is wrong fetches nothing and says so, while a
 * webhook that is wrong *accepts*. So the interesting assertions are the negative ones, and each is
 * written so that removing the check it covers makes it fail rather than error.
 */

const SECRET = 'a-shared-secret-nobody-else-holds';
const TOLERANCE = 300;
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

const digestOf = (payload: string, secret = SECRET): string =>
	createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** A delivery signed the way the construction template's reports system signs one. */
const signed = (
	body: string,
	options: { readonly secret?: string; readonly atMs?: number; readonly eventId?: string } = {}
) => {
	const seconds = Math.floor((options.atMs ?? NOW) / 1000);
	return {
		headers: {
			'content-type': 'application/json',
			'x-reports-timestamp': String(seconds),
			'x-reports-event-id': options.eventId ?? 'evt-1',
			'x-reports-signature': `sha256=${digestOf(`${seconds}.${body}`, options.secret ?? SECRET)}`
		},
		body
	};
};

const binding: IntegrationWebhookDeclaration = {
	name: 'rfi',
	path: '/rfis',
	signature: {
		header: 'x-reports-signature',
		secret: { env: 'REPORTS_WEBHOOK_SECRET' },
		prefix: 'sha256=',
		timestamp: { header: 'x-reports-timestamp' },
		signedPayload: '{timestamp}.{body}',
		toleranceSeconds: TOLERANCE
	},
	eventIdHeader: 'x-reports-event-id',
	records: { field: 'rfis' },
	identityColumn: 'rfi_number'
};

const integration: IntegrationDeclaration = {
	name: 'rfis.reports',
	collection: 'rfis',
	receive: [],
	webhooks: [binding],
	send: []
};

const Rfi = Schema.Struct({
	number: Schema.String,
	title: Schema.String
});

const authored: AuthoredIntegrationBinding = {
	input: Rfi,
	identityColumn: 'rfi_number',
	identityValue: (record) => {
		const number =
			record === null || typeof record !== 'object' ? undefined : Reflect.get(record, 'number');
		if (typeof number !== 'string' || number === '')
			throw new TypeError('a record with no rfi number');
		return number;
	},
	map: (record) => {
		const title = record === null || typeof record !== 'object' ? '' : Reflect.get(record, 'title');
		// Deliberately writes a *wrong* identity column, to prove the platform overwrites it with the
		// value it read through `identityValue` rather than trusting what the mapper produced.
		return { title, rfi_number: 'MAPPER-SAYS-SO' };
	}
};

type Row = Readonly<{
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
	readonly mode: 'create' | 'update';
}>;

/**
 * An in-memory host: a delivery ledger, a row store keyed by the identity column, and a vault.
 *
 * The row store keys on the identity column exactly as a collection with a unique index on it
 * would, so "two deliveries produced one row" is observable as a store of size one rather than as a
 * count the harness was told to keep.
 */
const harness = (options: { readonly secret?: string | null; readonly nowMs?: number } = {}) => {
	const ledger = new Map<string, LedgerState>();
	const rows = new Map<string, Row>();
	const writes: Array<Row> = [];
	const dependencies: WebhookDependencies = {
		secret: (_effectId, name) =>
			options.secret === null
				? Effect.fail({
						message: `rfis.reports needs the environment variable ${name}, and the vault has no value for it`
					})
				: Effect.succeed(options.secret ?? SECRET),
		remember: (_effectId, entry) => {
			const key = `${entry.integration}:${entry.receiptId}`;
			const held = ledger.get(key);
			if (held === undefined) {
				ledger.set(key, 'pending');
				return Effect.succeed('new');
			}
			return Effect.succeed(held === 'absorbed' ? 'absorbed' : 'pending');
		},
		settle: (_effectId, entry) => {
			ledger.set(`${entry.integration}:${entry.receiptId}`, 'absorbed');
			return Effect.succeed(undefined);
		},
		existing: (_effectId, _collection, column, keys) =>
			Effect.succeed(
				new Map(
					keys.flatMap((key) => {
						const row = rows.get(key);
						// A list, because one record may fan out into several rows sharing this identity.
						return row === undefined || row.values[column] !== key
							? []
							: [[key, [row.id]] as const];
					})
				)
			),
		remove: (_effectId, _collection, ids) => {
			for (const id of ids) {
				for (const [key, row] of rows) if (row.id === id) rows.delete(key);
			}
			return Effect.succeed(undefined);
		},
		write: (_effectId, _collection, id, values, mode) => {
			const key = values['rfi_number'];
			if (typeof key !== 'string')
				return Effect.fail({ message: 'a row with no identity reached the store' });
			const row: Row = { id, values, mode };
			rows.set(key, row);
			writes.push(row);
			return Effect.succeed(undefined);
		},
		pipeline: () => undefined,
		// Refuses rather than answers: neither binding here declares a `resolve`, so the loop must
		// never reach this. A stub that quietly succeeded would hide the loop starting to call it.
		resolve: () => Effect.fail({ message: 'this binding declares no resolve' }),
		now: () => options.nowMs ?? NOW
	};
	return { dependencies, ledger, rows, writes };
};

const deliver = (
	bound: ReturnType<typeof harness>,
	delivery: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
) =>
	Effect.runPromise(
		Effect.result(
			runWebhookDelivery(
				bound.dependencies,
				EffectId.make('delivery'),
				integration,
				binding,
				authored,
				delivery
			)
		)
	);

const refusalOf = async (
	bound: ReturnType<typeof harness>,
	delivery: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
) => {
	const outcome = await deliver(bound, delivery);
	if (Result.isSuccess(outcome)) {
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome.success)}`);
	}
	return outcome.failure.message;
};

const reportOf = async (
	bound: ReturnType<typeof harness>,
	delivery: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
) => {
	const outcome = await deliver(bound, delivery);
	if (Result.isFailure(outcome)) {
		throw new Error(`expected the delivery to be absorbed, got ${outcome.failure.message}`);
	}
	return outcome.success;
};

const ONE_RFI = JSON.stringify({ rfis: [{ number: 'RFI-001', title: 'Slab penetration clash' }] });

describe('webhook signature verification', () => {
	/**
	 * The default-deny case. An unsigned delivery is not a malformed request to be reported and moved
	 * past — it is an anonymous write attempt against a public route, and the only correct answer is
	 * to refuse before anything reads the body.
	 */
	it('refuses a body that carries no signature at all', async () => {
		const bound = harness();
		const message = await refusalOf(bound, {
			headers: { 'content-type': 'application/json', 'x-reports-event-id': 'evt-1' },
			body: ONE_RFI
		});

		expect(message).toContain('carries no x-reports-signature header');
		expect(bound.rows.size).toBe(0);
		// Nothing was even recorded: the ledger is written after verification, so an unsigned delivery
		// cannot fill the inbox with unauthenticated bodies.
		expect(bound.ledger.size).toBe(0);
	});

	it('refuses a body signed with the wrong secret', async () => {
		const bound = harness();
		const message = await refusalOf(bound, signed(ONE_RFI, { secret: 'not-the-shared-secret' }));

		expect(message).toContain('does not match the body under the declared secret');
		expect(bound.rows.size).toBe(0);
	});

	it('absorbs a correctly signed delivery and lands the record', async () => {
		const bound = harness();
		const report = await reportOf(bound, signed(ONE_RFI));

		expect(report.duplicate).toBe(false);
		expect(report.replayChecked).toBe(true);
		expect(report.created).toBe(1);
		expect(report.rejected).toEqual([]);
		expect(bound.rows.size).toBe(1);
		// Stamped from the declared identity, not from the row the mapper returned — the mapper wrote
		// `MAPPER-SAYS-SO` into the identity column and the platform overwrote it.
		expect(bound.rows.get('RFI-001')?.values['rfi_number']).toBe('RFI-001');
		expect(bound.rows.get('RFI-001')?.values['title']).toBe('Slab penetration clash');
	});

	/**
	 * The reason HMAC exists at all: the signature has to be over the bytes, so that editing the bytes
	 * after signing invalidates it. A scheme that verified a re-serialised parse would pass this.
	 */
	it('refuses a body that was tampered with after it was signed', async () => {
		const bound = harness();
		const authentic = signed(ONE_RFI);
		const tampered = {
			headers: authentic.headers,
			body: JSON.stringify({
				rfis: [{ number: 'RFI-001', title: 'Slab penetration clash — CLOSED' }]
			})
		};
		const message = await refusalOf(bound, tampered);

		expect(message).toContain('does not match the body under the declared secret');
		expect(bound.rows.size).toBe(0);
	});

	/**
	 * A whitespace-only edit, which is the version of tampering a "verify the parsed document" scheme
	 * would wave through: the JSON means the same thing, and the bytes do not.
	 */
	it('refuses a body whose bytes changed even though its JSON did not', async () => {
		const bound = harness();
		const authentic = signed(ONE_RFI);
		const message = await refusalOf(bound, {
			headers: authentic.headers,
			body: JSON.stringify(JSON.parse(ONE_RFI), null, 2)
		});

		expect(message).toContain('does not match the body under the declared secret');
	});

	it('refuses a delivery signed outside the replay window', async () => {
		const bound = harness();
		// Correctly signed — for eleven minutes ago. Everything about it verifies except its age.
		const stale = signed(ONE_RFI, { atMs: NOW - 11 * 60 * 1000 });
		const message = await refusalOf(bound, stale);

		expect(message).toContain(`outside the ${TOLERANCE}s replay window`);
		expect(bound.rows.size).toBe(0);
	});

	/** The same body inside the window is absorbed, so the test above is about age and nothing else. */
	it('absorbs a delivery signed just inside the replay window', async () => {
		const bound = harness();
		const report = await reportOf(bound, signed(ONE_RFI, { atMs: NOW - (TOLERANCE - 30) * 1000 }));

		expect(report.created).toBe(1);
	});

	it('refuses every delivery when the vault holds no secret for the binding', async () => {
		const bound = harness({ secret: null });
		const message = await refusalOf(bound, signed(ONE_RFI));

		expect(message).toContain('REPORTS_WEBHOOK_SECRET');
		expect(bound.rows.size).toBe(0);
	});

	/**
	 * A vault that answers with an empty string is the configuration that looks provisioned and is
	 * not: HMAC under an empty key is a digest anyone can compute, so this must refuse rather than
	 * verify everything.
	 */
	it('refuses when the vault answers with an empty secret', async () => {
		const bound = harness({ secret: '' });
		const message = await refusalOf(bound, signed(ONE_RFI, { secret: '' }));

		expect(message).toContain('verifying against an empty secret');
		expect(bound.rows.size).toBe(0);
	});
});

describe('webhook delivery is at-least-once', () => {
	/** Every provider retries. Two deliveries of one event have to leave one row behind. */
	it('produces one row when the same delivery arrives twice', async () => {
		const bound = harness();
		const delivery = signed(ONE_RFI);

		const first = await reportOf(bound, delivery);
		const second = await reportOf(bound, delivery);

		expect(first.duplicate).toBe(false);
		expect(first.created).toBe(1);
		// Recognised by the ledger before anything was read, so the second delivery wrote nothing at all.
		expect(second.duplicate).toBe(true);
		expect(second.created).toBe(0);
		expect(second.updated).toBe(0);
		expect(bound.rows.size).toBe(1);
		expect(bound.writes).toHaveLength(1);
	});

	/**
	 * The second guarantee, independent of the first: a source that re-sends the same record under a
	 * *new* event id defeats the ledger, and the identity upsert has to catch it. This is the property
	 * the construction template fell back on when its webhook was downgraded to a poll.
	 */
	it('updates rather than duplicates when the same record arrives under a new event id', async () => {
		const bound = harness();

		const first = await reportOf(bound, signed(ONE_RFI, { eventId: 'evt-1' }));
		const second = await reportOf(bound, signed(ONE_RFI, { eventId: 'evt-2' }));

		expect(first.created).toBe(1);
		expect(second.duplicate).toBe(false);
		// A different delivery, the same record: absorbed again, and it updated the row it wrote before.
		expect(second.created).toBe(0);
		expect(second.updated).toBe(1);
		expect(bound.rows.size).toBe(1);
	});

	/**
	 * A delivery recorded but not settled is one whose process died mid-batch. Redelivery of it must
	 * be absorbed rather than skipped, or the retry that was meant to finish the job drops the rows.
	 */
	it('absorbs a redelivery whose previous attempt never settled', async () => {
		const bound = harness();
		const delivery = signed(ONE_RFI);
		await reportOf(bound, delivery);
		// Rewind the ledger to the state an interrupted attempt leaves behind.
		bound.ledger.set('rfis.reports:rfi:evt-1', 'pending');

		const retried = await reportOf(bound, delivery);

		expect(retried.duplicate).toBe(false);
		expect(retried.updated).toBe(1);
		expect(bound.rows.size).toBe(1);
	});
});

describe('webhook partial failure', () => {
	/**
	 * The one thing the pull design got unambiguously right, carried over: `input` describes one
	 * record, so a bad record costs a record. A whole-body schema would drop the batch.
	 */
	it('refuses a malformed record while its well-formed siblings land', async () => {
		const bound = harness();
		const body = JSON.stringify({
			rfis: [
				{ number: 'RFI-001', title: 'Slab penetration clash' },
				{ number: 'RFI-002', title: 42 },
				{ number: 'RFI-003', title: 'Handrail height' }
			]
		});
		const report = await reportOf(bound, signed(body));

		expect(report.received).toBe(3);
		expect(report.created).toBe(2);
		expect(report.rejected).toHaveLength(1);
		expect(report.rejected[0]?.index).toBe(1);
		expect(bound.rows.size).toBe(2);
		expect([...bound.rows.keys()].toSorted()).toEqual(['RFI-001', 'RFI-003']);
	});

	/** A record that decodes but carries no usable identity is refused the same per-record way. */
	it('refuses a record with no identity while its siblings land', async () => {
		const bound = harness();
		const body = JSON.stringify({
			rfis: [
				{ number: '', title: 'Nameless' },
				{ number: 'RFI-004', title: 'Duct clash' }
			]
		});
		const report = await reportOf(bound, signed(body));

		expect(report.created).toBe(1);
		expect(report.rejected).toHaveLength(1);
		expect(report.rejected[0]?.reason).toContain('a record with no rfi number');
		expect(bound.rows.size).toBe(1);
	});

	/** A single-object body is one record, not zero: most providers post one event per request. */
	it('treats a body that is one object as one record', async () => {
		const bound = harness();
		const single = JSON.stringify({ rfis: { number: 'RFI-009', title: 'Lone event' } });
		const report = await reportOf(bound, signed(single));

		expect(report.received).toBe(1);
		expect(report.created).toBe(1);
	});

	it('refuses a correctly signed body that is not JSON', async () => {
		const bound = harness();
		const message = await refusalOf(bound, signed('not json at all'));

		expect(message).toContain('is not JSON');
	});
});

describe('webhook declarations that cannot verify are refused at authoring time', () => {
	const base = {
		input: Rfi,
		identity: {
			column: 'rfi_number',
			value: (record: { readonly number: string }) => record.number
		}
	};

	/**
	 * The trap this exists for: a freshness check over a timestamp the signature does not cover
	 * refuses nothing, because the attacker replaying the body also chooses the timestamp header. It
	 * is invisible in review and every test of it passes, so it fails the build instead.
	 */
	it('refuses a replay window over a timestamp the signature does not cover', () => {
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/rfis',
					signature: {
						header: 'x-reports-signature',
						secret: { env: 'REPORTS_WEBHOOK_SECRET' },
						timestamp: { header: 'x-reports-timestamp' },
						signedPayload: '{body}'
					}
				}
			})
		).toThrow(/An unsigned timestamp is attacker-controlled/u);
	});

	it('refuses a signed payload that does not cover the body', () => {
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/rfis',
					signature: {
						header: 'x-reports-signature',
						secret: { env: 'REPORTS_WEBHOOK_SECRET' },
						signedPayload: '{timestamp}'
					}
				}
			})
		).toThrow(/omits \{body\}/u);
	});

	it('refuses a binding that names no secret', () => {
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/rfis',
					signature: { header: 'x-reports-signature', secret: { env: '  ' } }
				}
			})
		).toThrow(/verification against an empty key/u);
	});

	it('accepts the shapes GitHub, Slack and Stripe actually send', () => {
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/gh',
					signature: { header: 'x-hub-signature-256', secret: { env: 'GH' }, prefix: 'sha256=' }
				}
			})
		).not.toThrow();
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/slack',
					signature: {
						header: 'x-slack-signature',
						secret: { env: 'SLACK' },
						prefix: 'v0=',
						timestamp: { header: 'x-slack-request-timestamp' },
						signedPayload: 'v0:{timestamp}:{body}'
					}
				}
			})
		).not.toThrow();
		expect(() =>
			defineWebhook({
				...base,
				webhook: {
					path: '/stripe',
					signature: {
						header: 'stripe-signature',
						secret: { env: 'STRIPE' },
						parameter: 'v1',
						timestamp: { parameter: 't' },
						signedPayload: '{timestamp}.{body}'
					}
				}
			})
		).not.toThrow();
	});
});

describe('the digest comparison is constant-time by construction', () => {
	/**
	 * Asserted structurally rather than by measurement, and deliberately so.
	 *
	 * A timing test cannot be trusted here: the difference an early-exit comparison makes is tens of
	 * nanoseconds, while a JIT warm-up, a GC pause or a noisy neighbour move the measurement by
	 * milliseconds. A test that tried to observe it would either fail at random or — far worse — pass
	 * at random, and a green timing assertion over `===` would be an actively false assurance about
	 * the one property nobody can see by reading the diff.
	 *
	 * So the property is pinned where it is actually decidable: the source either hands the two
	 * digests to `timingSafeEqual` or it does not. This fails if somebody replaces that call with an
	 * operator, which is the regression worth catching.
	 */
	const source = readFileSync(
		new URL('../../src/runtime/integrations/signature.ts', import.meta.url),
		'utf8'
	);

	it('compares the digests with timingSafeEqual', () => {
		expect(source).toContain('timingSafeEqual(provided, expected)');
	});

	/**
	 * Stated as an exhaustive list rather than as a forbidden pattern, because the interesting claim
	 * is not "no operator appears near a digest" — `provided === undefined` is a decode check and
	 * `provided.length !== expected.length` is the guard `timingSafeEqual` requires. The claim is that
	 * the *only* place the two digests meet an operator is that length guard, and that comparing their
	 * contents goes through `timingSafeEqual`. A new `provided === expected` shows up here as an extra
	 * entry.
	 */
	it('never compares the digests themselves with an equality operator', () => {
		const comparisons = source
			.split('\n')
			.map((line) => line.trim())
			.filter(
				(line) => /[!=]==/u.test(line) && /\bprovided\b/u.test(line) && /\bexpected\b/u.test(line)
			);

		expect(comparisons).toEqual(['if (provided.length !== expected.length) {']);
	});

	/**
	 * The length guard has to stay, because `timingSafeEqual` throws on operands of different lengths
	 * — a short signature would crash the route rather than be refused by it.
	 */
	it('guards the length before the constant-time compare', () => {
		expect(source).toContain('provided.length !== expected.length');
		expect(source.indexOf('provided.length !== expected.length')).toBeLessThan(
			source.indexOf('timingSafeEqual(provided, expected)')
		);
	});
});
