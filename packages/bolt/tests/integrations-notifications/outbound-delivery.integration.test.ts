import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Effect, Schema } from 'effect';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type Activation,
	type ConnectorRequest,
	type ConnectorResponse,
	type FacilityBinding,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { describeIntegrations } from '../../src/authoring/integration-introspection.js';
import {
	collection,
	defineConnection,
	defineSend,
	field,
	policy,
	workspace,
	type WorkspaceDefinition
} from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import { makeHttpConnectorBinding } from '../../src/runtime/integrations/http-connector.js';
import * as Integrations from '../../src/runtime/integrations/integrations.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	makeTestDatabase,
	provisioningStatements,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * Outbound delivery, against a real HTTP server on a real socket.
 *
 * This is the third integration pattern, and it is the one that could most easily have been faked:
 * a `send` binding typechecked and `flush` answered "Outbound delivery is not implemented", which is
 * at least honest, but a `flush` that returned `{ delivered: 0 }` against a queue nothing ever wrote
 * to would have looked identical to a working system forever. So almost nothing here is scripted.
 * The connector under test is `makeHttpConnectorBinding` — the same one a host binds — pointed at a
 * `node:http` server that records exactly what arrived: method, path, headers, bytes. Every
 * assertion about what was sent is an assertion about what was received on the wire.
 *
 * The five questions this file exists to answer, and where each is answered:
 *
 * | question                     | answered by                                                |
 * | ---------------------------- | ---------------------------------------------------------- |
 * | what triggers a send         | "the write does not wait on the delivery"                   |
 * | delivery semantics           | "a real send arrives …" (idempotency key, stable on retry)  |
 * | retry and backoff            | "a 4xx is terminal" / "a 5xx is retried, later"             |
 * | ordering                     | "a record's second event waits for its first"               |
 * | failure visibility           | "an exhausted delivery is findable"                         |
 */

/* -------------------------------------------------------------------------------------------------
 * A recording HTTP server: the only thing in this file that is allowed to say what was sent.
 * ---------------------------------------------------------------------------------------------- */

type Recorded = Readonly<{
	readonly method: string;
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}>;

type Answer = Readonly<{
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}>;

/** What the server answers next, swapped per test. Defaults to a plain 202. */
let respond: (received: Recorded, index: number) => Answer = () => ({ status: 202 });
const received: Array<Recorded> = [];
let origin = '';
let server: Server | undefined;

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Array<Buffer> = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
	return Buffer.concat(chunks).toString('utf8');
};

beforeAll(async () => {
	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		void (async () => {
			const body = await readBody(request);
			const headers = Object.fromEntries(
				Object.entries(request.headers).flatMap(([name, value]) =>
					typeof value === 'string' ? [[name.toLowerCase(), value] as const] : []
				)
			);
			const entry: Recorded = {
				method: request.method ?? '',
				path: request.url ?? '',
				headers,
				body
			};
			received.push(entry);
			const answer = respond(entry, received.length - 1);
			response.writeHead(answer.status, {
				'content-type': 'application/json',
				...(answer.headers ?? {})
			});
			response.end(answer.body ?? '{}');
		})();
	});
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('the test server did not bind a port');
	origin = `http://localhost:${(address as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/* -------------------------------------------------------------------------------------------------
 * The authored `+integrations.ts`, written as a collection directory would write it.
 * ---------------------------------------------------------------------------------------------- */

type Order = Readonly<{
	readonly id: string;
	readonly external_id: string;
	readonly status: string;
	readonly amount: number;
}>;

/** The binding under test in most of this file: every create, and an update that changed `status`. */
const ordersModule = (baseUrl: string) => ({
	partner: {
		policies: [],
		connection: defineConnection({
			baseUrl,
			authentication: { type: 'bearer', token: { env: 'PARTNER_TOKEN' } }
		}),
		send: {
			status_changed: defineSend<Order>({
				send: {
					method: 'POST',
					// `{external_id}` is filled from the stored row, not from the body — the whole point of
					// resolving it at enqueue time is that a delete still knows what it deleted.
					path: '/orders/{external_id}/events',
					headers: { 'x-partner-channel': 'bolt' },
					retry: { attempts: 3, initialDelayMs: 1_000, maxDelayMs: 60_000 }
				},
				on: {
					create: () => true,
					// The reason a trigger takes `previous`: "did this change" is not a question a patch can
					// answer on its own.
					update: ({ previous, record }) => previous.status !== record.status,
					delete: () => true
				},
				body: ({ operation, record }) => ({
					kind: operation,
					order: record.external_id,
					status: record.status
				})
			})
		}
	}
});

/** A binding whose body throws, to prove an authored mistake does not fail the tenant's write. */
const brokenModule = (baseUrl: string) => ({
	partner: {
		policies: [],
		connection: defineConnection({ baseUrl }),
		send: {
			broken: defineSend<Order>({
				send: { method: 'POST', path: '/orders' },
				on: 'create',
				body: () => {
					throw new Error('the author read a column that is not there');
				}
			})
		}
	}
});

/** A binding addressing a column the collection does not have, to prove the path is not guessed at. */
const unaddressableModule = (baseUrl: string) => ({
	partner: {
		policies: [],
		connection: defineConnection({ baseUrl }),
		send: {
			unaddressable: defineSend<Order>({
				send: { method: 'PUT', path: '/orders/{partner_reference}' },
				on: 'create'
			})
		}
	}
});

const definitionFor = (integrations: WorkspaceDefinition['integrations']): WorkspaceDefinition =>
	workspace({
		name: 'outbound-delivery',
		version: '1',
		collections: [
			collection({
				name: 'orders',
				fields: {
					external_id: field.string({ required: true, indexed: true }),
					status: field.string({ required: true }),
					amount: field.number()
				}
			})
		],
		apps: [],
		policies: [
			policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
		],
		teams: {
			admin: ['admin']
		},
		automations: [],
		integrations,
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		envoys: [],
		requiredFacilities: ['database', 'connector'],
		schemaFingerprint: 'sha256:outbound-delivery-fixture',
		environment: { variables: { PARTNER_TOKEN: { label: 'Partner API token', secret: true } } }
	});

/* -------------------------------------------------------------------------------------------------
 * The harness.
 * ---------------------------------------------------------------------------------------------- */

let harness: BoltTestRuntime | undefined;

const current = (): BoltTestRuntime => {
	if (harness === undefined) throw new Error('harness not built');
	return harness;
};

const build = async (
	module: (baseUrl: string) => Parameters<typeof describeIntegrations>[0][string],
	options: { readonly token?: string | null } = {}
): Promise<void> => {
	const described = describeIntegrations({ orders: module(origin) });
	harness = await makeBoltTestRuntime(definitionFor(described.declarations), {
		// The real connector, not a script: this is the file that has to prove bytes leave the process.
		connector: makeHttpConnectorBinding(),
		authored: { ...emptyAuthoredRuntime, integrations: described.authored }
	});
	if (options.token !== null) {
		await harness.runtime.runPromise(
			Effect.flatMap(Secrets.Service, (secrets) =>
				secrets.write(
					EffectId.make('vault'),
					'PARTNER_TOKEN',
					options.token ?? 'partner-token-fixture',
					'proof'
				)
			)
		);
	}
};

afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
	received.length = 0;
	respond = () => ({ status: 202 });
});

const create = (
	name: string,
	values: Readonly<Record<string, Schema.Json>>,
	subject: Identity.Subject = adminSubject
) =>
	current().runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.mutate(
				EffectId.make(`create:${name}`),
				subject,
				'orders',
				[{ ...values, id: recordId(name) }],
				false,
				0,
				{ root: { id: recordId(name), action: 'create' } }
			)
		)
	);

const update = (name: string, run: string, values: Readonly<Record<string, Schema.Json>>) =>
	current().runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.mutate(
				EffectId.make(`update:${run}`),
				adminSubject,
				'orders',
				[{ ...values, id: recordId(name) }],
				false,
				0,
				{ root: { id: recordId(name), action: 'update' } }
			)
		)
	);

const remove = (name: string, run: string) =>
	current().runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.delete(EffectId.make(`delete:${run}`), adminSubject, 'orders', recordId(name))
		)
	);

const flush = (run: string, input: Schema.Json = null) =>
	current().runtime.runPromise(
		Effect.flatMap(Integrations.Service, (integrations) =>
			integrations.flush(EffectId.make(`flush:${run}`), 'orders.partner', input)
		)
	);

const status = (run: string) =>
	current().runtime.runPromise(
		Effect.flatMap(Integrations.Service, (integrations) =>
			integrations.status(EffectId.make(`status:${run}`), 'orders.partner')
		)
	);

/** The report crosses as `Schema.Json`, so it is read the way a host would have to read it. */
const at = (value: Schema.Json, key: string): unknown =>
	value === null || typeof value !== 'object' || Array.isArray(value)
		? undefined
		: Reflect.get(value, key);

const outbox = async (): Promise<ReadonlyArray<Record<string, unknown>>> =>
	current().database.query(
		'select sequence, binding_name, record_id, operation, path, payload, status, attempts, last_status, last_error, extract(epoch from (next_attempt_at - now())) as waits from bolt_integration_outbox order by sequence',
		[]
	);

/** Makes every pending delivery due now, standing in for the wall clock a cron would have waited on. */
const advancePastBackoff = async (): Promise<void> => {
	await current().database.query(
		"update bolt_integration_outbox set next_attempt_at = now() - interval '1 second' where status = 'pending'",
		[]
	);
};

/* -------------------------------------------------------------------------------------------------
 * What the declaration refuses, at the point where a workspace is compiled.
 * ---------------------------------------------------------------------------------------------- */

describe('an outbound declaration that cannot deliver is refused at compile time', () => {
	it('requires an explicit policy list, where an empty list means no data access', () => {
		expect(() =>
			describeIntegrations({
				orders: {
					partner: {
						connection: { baseUrl: 'https://partner.example' },
						send: { anything: { send: { method: 'POST', path: '/orders' }, on: 'create' } }
					} as never
				}
			})
		).toThrow(/explicit policies array/);
	});

	/**
	 * A send has nowhere to go without a `baseUrl`, exactly as a pull does. Before this, `connection`
	 * was required only when a pull was declared — so a webhook-plus-send integration compiled fine
	 * and every delivery would have failed at drain time, once, per queued row, forever.
	 */
	it('refuses a send binding on an integration with no connection', () => {
		expect(() =>
			describeIntegrations({
				orders: {
					partner: {
						policies: [],
						send: { anything: { send: { method: 'POST', path: '/orders' }, on: 'create' } }
					}
				}
			})
		).toThrow(/no connection/);
	});

	/**
	 * The method is not defaulted. A delivery that silently `POST`s where the author meant `PUT`
	 * creates a duplicate on somebody else's system every time a record is updated, and the
	 * declaration is one word away from saying which it wanted.
	 */
	it('refuses a send binding that does not state its method', () => {
		expect(() =>
			describeIntegrations({
				orders: {
					partner: {
						policies: [],
						connection: { baseUrl: 'https://partner.example' },
						send: { anything: { send: { path: '/orders' }, on: 'create' } }
					}
				}
			})
		).toThrow(/must state POST, PUT, PATCH or DELETE/);
	});

	it('refuses a send binding with no path and one that subscribes to nothing', () => {
		expect(() => defineSend<Order>({ send: { method: 'POST', path: '  ' }, on: 'create' })).toThrow(
			/requires a path/
		);
		expect(() => defineSend<Order>({ send: { method: 'POST', path: '/orders' }, on: {} })).toThrow(
			/subscribes to no collection event/
		);
	});
});

/* -------------------------------------------------------------------------------------------------
 * What triggers a send, and what a tenant's write pays for it.
 * ---------------------------------------------------------------------------------------------- */

describe('a write queues a delivery and does not wait for it', () => {
	/**
	 * The design question this whole file turns on. A hook that fired the request inline is the
	 * obvious shape: it is one function, it needs no table, and it would put every create in this
	 * collection behind a partner's response time and turn that partner's outage into a failed
	 * tenant write.
	 *
	 * So the proof is a negative one, and it is the strongest kind available: the write completes,
	 * and the socket the delivery would have used has seen nothing at all.
	 */
	it('completes the write with no HTTP request having happened', async () => {
		await build(ordersModule);
		await create('order-1', { external_id: 'A-1', status: 'placed', amount: 10 });
		expect(received).toEqual([]);
		const rows = await outbox();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.['status']).toBe('pending');
		expect(rows[0]?.['operation']).toBe('create');
	});

	/**
	 * And the queue entry commits with the row rather than after it. A post-commit enqueue has a
	 * window in which the row exists and the intent to tell anybody about it does not; the statement
	 * riding in the mutation's own transaction is what closes it.
	 */
	it('writes the queue entry inside the write is own transaction', async () => {
		await build(ordersModule);
		current().database.forget();
		await create('order-tx', { external_id: 'A-TX', status: 'placed', amount: 1 });
		const statements = current().database.statements;
		const rowInsert = statements.findIndex((sql) => sql.includes('insert into "orders"'));
		const queueInsert = statements.findIndex((sql) => sql.includes('bolt_integration_outbox'));
		expect(rowInsert).toBeGreaterThanOrEqual(0);
		expect(queueInsert).toBeGreaterThan(rowInsert);
	});

	/** An update that changed nothing the binding cares about is not an event. */
	it('consults the authored trigger rather than queueing every write', async () => {
		await build(ordersModule);
		await create('order-2', { external_id: 'A-2', status: 'placed', amount: 5 });
		await update('order-2', 'amount', { amount: 6 });
		await update('order-2', 'status', { status: 'shipped' });
		const rows = await outbox();
		expect(rows.map((row) => row['operation'])).toEqual(['create', 'update']);
	});

	/**
	 * An integration's own mirror write does not queue a delivery back to that same integration.
	 *
	 * Without this, a collection that both pulls from a system and sends to it is a loop: the pull
	 * writes, the write queues a send, the send updates the source, the next pull writes again. Each
	 * half is individually correct, which is exactly why it is invisible in review.
	 */
	it('does not queue a delivery for the integration is own write', async () => {
		await build(ordersModule);
		await create(
			'order-mirror',
			{ external_id: 'A-M', status: 'placed', amount: 2 },
			{
				userId: 'integration:orders.partner',
				tenantId: 'system',
				teamPath: ['admin'],
				policies: []
			}
		);
		expect(await outbox()).toEqual([]);
	});
});

/* -------------------------------------------------------------------------------------------------
 * Delivery: what actually arrives on the wire.
 * ---------------------------------------------------------------------------------------------- */

describe('a queued delivery reaches a real endpoint', () => {
	/**
	 * The load-bearing test. Everything else in this file is about what happens when a delivery goes
	 * wrong, and none of it means anything unless one can go right — over a socket, through the same
	 * connector a host binds, carrying the credential the connection declared.
	 *
	 * The authorization header is the part worth being specific about: it proves the `{ env }`
	 * reference was resolved through the vault, by the same function that resolves a pull's bearer
	 * token, and that the resolved value reached the wire rather than a header the runtime forgot to
	 * attach.
	 */
	it('arrives with the declared method, path, headers and credential', async () => {
		await build(ordersModule, { token: 'partner-token-fixture' });
		await create('order-3', { external_id: 'A-3', status: 'placed', amount: 42 });
		const report = await flush('one');
		expect(at(report, 'delivered')).toBe(1);
		expect(received).toHaveLength(1);
		const sent = received[0];
		expect(sent?.method).toBe('POST');
		expect(sent?.path).toBe('/orders/A-3/events');
		expect(sent?.headers['authorization']).toBe('Bearer partner-token-fixture');
		expect(sent?.headers['x-partner-channel']).toBe('bolt');
		expect(sent?.headers['content-type']).toBe('application/json');
		expect(JSON.parse(sent?.body ?? 'null')).toEqual({
			kind: 'create',
			order: 'A-3',
			status: 'placed'
		});
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('delivered');
		expect(rows[0]?.['last_status']).toBe(202);
	});

	/**
	 * At-least-once, with a key the receiver can collapse on.
	 *
	 * Exactly-once is not achievable across an HTTP boundary and is not claimed anywhere: an
	 * acknowledgement can be lost after the request was processed, and the only honest answer to a
	 * lost acknowledgement is to send again. What the platform owes instead is a key that is
	 * identical across every attempt at one delivery and different between two genuinely different
	 * events — which is why it is derived from the outbox row and never from the payload.
	 */
	it('carries an idempotency key that is stable across retries and unique per event', async () => {
		await build(ordersModule);
		respond = (_entry, index) => (index === 0 ? { status: 503 } : { status: 202 });
		await create('order-4', { external_id: 'A-4', status: 'placed', amount: 1 });
		await flush('first');
		await advancePastBackoff();
		await flush('second');
		await create('order-5', { external_id: 'A-5', status: 'placed', amount: 1 });
		await flush('third');
		const keys = received.map((entry) => entry.headers['idempotency-key']);
		expect(keys).toHaveLength(3);
		// The retry of one delivery presents the same key…
		expect(keys[0]).toBe(keys[1]);
		// …and a different event does not.
		expect(keys[2]).not.toBe(keys[0]);
		expect(keys[0]).toMatch(/^orders\.partner:status_changed:\d+$/);
	});

	/**
	 * A delete has to be able to name what it deleted, which is the case that decides where a request
	 * path is resolved. Resolved at delivery time it could not: the row is gone by then. Resolved at
	 * enqueue time, from the row read before the statement ran, it addresses exactly the resource the
	 * event was about.
	 */
	it('addresses a deleted record by the key the row carried before it was deleted', async () => {
		await build(ordersModule);
		await create('order-6', { external_id: 'A-6', status: 'placed', amount: 1 });
		await remove('order-6', 'gone');
		// Two drains, because they are two events for one record and a record's events go out one at a
		// time. That is the ordering guarantee showing up where it was not the point of the test.
		await flush('deletes-1');
		await flush('deletes-2');
		expect(received.map((entry) => entry.path)).toEqual([
			'/orders/A-6/events',
			'/orders/A-6/events'
		]);
		expect(JSON.parse(received[1]?.body ?? 'null')).toMatchObject({ kind: 'delete', order: 'A-6' });
	});
});

/* -------------------------------------------------------------------------------------------------
 * Retry, backoff, and the failures that must not be retried.
 * ---------------------------------------------------------------------------------------------- */

describe('retry is for the failures that can succeed', () => {
	/**
	 * A 4xx is the receiver saying "not like that". Repeating it changes nothing, spends somebody
	 * else's rate limit, and hides a declaration bug behind four minutes of backoff — so it is
	 * terminal on the first answer, and it is terminal *visibly*.
	 */
	it('does not retry a 4xx, and dead-letters it on the first answer', async () => {
		await build(ordersModule);
		respond = () => ({ status: 422, body: '{"error":"unknown order"}' });
		await create('order-7', { external_id: 'A-7', status: 'placed', amount: 1 });
		const report = await flush('rejected');
		expect(at(report, 'failed')).toBe(1);
		expect(received).toHaveLength(1);
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('failed');
		expect(rows[0]?.['last_status']).toBe(422);
		expect(String(rows[0]?.['last_error'])).toContain('422');
		// And a second drain does not pick it up again: a dead letter is terminal, not merely late.
		await flush('rejected-again');
		expect(received).toHaveLength(1);
	});

	/**
	 * A 5xx is the receiver saying "not now", so it is retried — and the retry is a timestamp on the
	 * row rather than a sleep inside the invocation. That is what the two flushes prove: the delivery
	 * is still pending, and the very next drain declines to send it because it is not yet due.
	 *
	 * Backoff is asserted as growth rather than as a literal delay, because the literal is the
	 * declaration's business and the property is the platform's: the second wait is longer than the
	 * first, so a partner that is down does not get hammered on its way back up.
	 */
	it('retries a 5xx later, and each wait is longer than the one before', async () => {
		await build(ordersModule);
		respond = () => ({ status: 503 });
		await create('order-8', { external_id: 'A-8', status: 'placed', amount: 1 });

		const first = await flush('backoff-1');
		expect(at(first, 'retrying')).toBe(1);
		expect(received).toHaveLength(1);
		const afterFirst = await outbox();
		expect(afterFirst[0]?.['status']).toBe('pending');
		expect(afterFirst[0]?.['attempts']).toBe(1);
		const firstWait = Number(afterFirst[0]?.['waits']);
		expect(firstWait).toBeGreaterThan(0);

		// The next tick of the drain, before the wait has elapsed: nothing is due, so nothing is sent.
		const early = await flush('backoff-early');
		expect(at(early, 'claimed')).toBe(0);
		expect(received).toHaveLength(1);

		await advancePastBackoff();
		await flush('backoff-2');
		expect(received).toHaveLength(2);
		const afterSecond = await outbox();
		expect(afterSecond[0]?.['attempts']).toBe(2);
		expect(Number(afterSecond[0]?.['waits'])).toBeGreaterThan(firstWait);
	});

	/**
	 * `Retry-After` wins over the computed delay, because the receiver is the only party that knows
	 * when it will be ready. A platform that ignored it would keep knocking through a window the
	 * partner explicitly asked it not to.
	 */
	it('waits as long as a 429 asked it to', async () => {
		await build(ordersModule);
		respond = () => ({ status: 429, headers: { 'retry-after': '45' } });
		await create('order-9', { external_id: 'A-9', status: 'placed', amount: 1 });
		await flush('throttled');
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('pending');
		// 45s, not the 1s the declaration's own first backoff step would have produced.
		expect(Number(rows[0]?.['waits'])).toBeGreaterThan(40);
	});
});

/* -------------------------------------------------------------------------------------------------
 * Failure visibility — the property whose absence is the worst outcome here.
 * ---------------------------------------------------------------------------------------------- */

describe('nothing that fails disappears', () => {
	/**
	 * A delivery that exhausts its retries has to land somewhere a person can find it. The inbound
	 * side has a ledger for exactly this reason; this is the outbound one, and the two things it has
	 * to be able to say are *that* it failed and *why*.
	 *
	 * `attempts: 3` is declared, so the third answer is the last one: the row moves to `failed`, the
	 * drain stops claiming it, and `status` counts it without anybody opening a database.
	 */
	it('lands an exhausted delivery in a findable dead-letter state', async () => {
		await build(ordersModule);
		respond = () => ({ status: 500, body: 'upstream exploded' });
		await create('order-10', { external_id: 'A-10', status: 'placed', amount: 1 });
		for (const run of ['exhaust-1', 'exhaust-2', 'exhaust-3', 'exhaust-4']) {
			await advancePastBackoff();
			await flush(run);
		}
		expect(received).toHaveLength(3);
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('failed');
		expect(rows[0]?.['attempts']).toBe(3);
		expect(String(rows[0]?.['last_error'])).toContain('gave up after 3 attempts');
		const reported = await status('after-exhaustion');
		expect(reported.failed).toBe(1);
		expect(reported.pending).toBe(0);
	});

	/**
	 * `absorb.ts`'s rule, applied to the other direction: one bad delivery costs that delivery.
	 *
	 * Three records, the middle one rejected. A loop that failed its batch would deliver the first
	 * and abandon the third — which is the shape of bug that looks like an intermittent partner
	 * problem for weeks.
	 */
	it('lets one failing delivery fail without taking its batch with it', async () => {
		await build(ordersModule);
		respond = (entry) => (entry.path.includes('B-2') ? { status: 404 } : { status: 202 });
		await create('batch-1', { external_id: 'B-1', status: 'placed', amount: 1 });
		await create('batch-2', { external_id: 'B-2', status: 'placed', amount: 1 });
		await create('batch-3', { external_id: 'B-3', status: 'placed', amount: 1 });
		const report = await flush('batch');
		expect(at(report, 'claimed')).toBe(3);
		expect(at(report, 'delivered')).toBe(2);
		expect(at(report, 'failed')).toBe(1);
		expect(received.map((entry) => entry.path)).toEqual([
			'/orders/B-1/events',
			'/orders/B-2/events',
			'/orders/B-3/events'
		]);
		const rows = await outbox();
		expect(rows.map((row) => row['status'])).toEqual(['delivered', 'failed', 'delivered']);
	});

	/**
	 * An authored `body` that throws is a mistake in a workspace, and there are exactly three things
	 * the platform can do with it: fail the tenant's write, drop the event, or record it. Only the
	 * third is defensible — a mistyped field access should not be able to stop a collection from
	 * accepting writes, and it should certainly not vanish.
	 */
	it('dead-letters an authored body that throws, and still lands the write', async () => {
		await build(brokenModule, { token: null });
		await create('order-11', { external_id: 'A-11', status: 'placed', amount: 1 });
		const stored = await current().database.query('select external_id from orders', []);
		expect(stored).toEqual([{ external_id: 'A-11' }]);
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('failed');
		expect(String(rows[0]?.['last_error'])).toContain('the body function threw');
		expect(String(rows[0]?.['last_error'])).toContain('not there');
		// And it is never sent. A dead letter is not claimable, so the drain answers an honest zero
		// rather than requesting `undefined` against a partner.
		expect(at(await flush('broken'), 'claimed')).toBe(0);
		expect(received).toEqual([]);
	});

	/**
	 * A path token the record cannot fill refuses rather than substituting an empty string.
	 *
	 * `PUT /orders/` is a request against the collection endpoint, and an API that accepts it does
	 * something entirely unlike what the binding meant — on every record, silently. So the delivery
	 * dead-letters at enqueue time with a sentence naming the token, which is also where the identity
	 * discipline shows: the value is looked for on the stored row and nowhere else, so a payload
	 * cannot volunteer the resource it would like the request addressed to.
	 */
	it('dead-letters a delivery whose path names a value the record does not carry', async () => {
		await build(unaddressableModule, { token: null });
		await create('order-15', { external_id: 'A-15', status: 'placed', amount: 1 });
		const rows = await outbox();
		expect(rows[0]?.['status']).toBe('failed');
		expect(rows[0]?.['path']).toBeNull();
		expect(String(rows[0]?.['last_error'])).toContain('{partner_reference}');
		expect(received).toEqual([]);
	});

	/**
	 * A drain that died between claiming a delivery and settling it must not have taken the delivery
	 * with it.
	 *
	 * This is `PULL_LEASE`'s guarantee on the outbound side. A claim marks the row `inflight`, and a
	 * host that killed the invocation on a deadline never reaches the settlement — so a claim with no
	 * expiry would leave that row queued, visible and never sent. Reclaiming it costs at most a
	 * duplicate, which is what the idempotency key is for; not reclaiming it costs the delivery.
	 */
	it('takes back a delivery whose drain died before settling it', async () => {
		await build(ordersModule);
		await create('order-16', { external_id: 'A-16', status: 'placed', amount: 1 });
		await current().database.query(
			"update bolt_integration_outbox set status = 'inflight', attempts = 1, updated_at = now()",
			[]
		);
		// Freshly claimed: another drain must leave it alone, because somebody may still be sending it.
		expect(at(await flush('leased'), 'claimed')).toBe(0);
		expect(received).toEqual([]);
		await current().database.query(
			"update bolt_integration_outbox set updated_at = now() - interval '30 minutes'",
			[]
		);
		expect(at(await flush('abandoned'), 'delivered')).toBe(1);
		expect(received).toHaveLength(1);
	});

	/**
	 * A missing credential refuses the whole drain rather than sending unauthenticated requests.
	 *
	 * This is the same refusal a pull makes and it matters more here: an unauthenticated pull reads
	 * nothing, while an unauthenticated send is a write attempt at somebody else's system.
	 */
	it('refuses to drain when the declared credential is not in the vault', async () => {
		await build(ordersModule, { token: null });
		await create('order-12', { external_id: 'A-12', status: 'placed', amount: 1 });
		await expect(flush('unset')).rejects.toThrow(/PARTNER_TOKEN/);
		expect(received).toEqual([]);
	});
});

/* -------------------------------------------------------------------------------------------------
 * Ordering.
 * ---------------------------------------------------------------------------------------------- */

describe('a record is events are delivered in order', () => {
	/**
	 * The guarantee, stated exactly: **per record, in order; between records, none.**
	 *
	 * Two events for one row, the first meeting a 503. The second must not overtake it — a receiver
	 * that saw "shipped" and then "placed" would end up with a state neither the platform nor the
	 * tenant ever held. So the claim only ever takes the lowest pending sequence for each record, and
	 * the due-time filter is applied after that pick rather than inside it: filtering first would
	 * skip the backing-off head and select the delivery behind it, which is the silent reordering
	 * this is written to prevent.
	 */
	it('holds a record is later event while its earlier one is backing off', async () => {
		await build(ordersModule);
		respond = () => ({ status: 503 });
		await create('order-13', { external_id: 'A-13', status: 'placed', amount: 1 });
		await update('order-13', 'ship', { status: 'shipped' });
		expect((await outbox()).map((row) => row['operation'])).toEqual(['create', 'update']);

		await flush('ordered-1');
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0]?.body ?? 'null')).toMatchObject({ kind: 'create' });
		const rows = await outbox();
		expect(rows[0]?.['attempts']).toBe(1);
		// The second event was never claimed, so it has never been attempted.
		expect(rows[1]?.['attempts']).toBe(0);
		expect(rows[1]?.['status']).toBe('pending');
	});

	/** And once the first is through, the second follows — in the order the writes happened. */
	it('delivers the two events of one record in the order they were written', async () => {
		await build(ordersModule);
		await create('order-14', { external_id: 'A-14', status: 'placed', amount: 1 });
		await update('order-14', 'ship-2', { status: 'shipped' });
		await flush('ordered-2');
		await flush('ordered-3');
		expect(
			received.map((entry) => JSON.parse(entry.body) as { kind: string; status: string })
		).toEqual([
			{ kind: 'create', order: 'A-14', status: 'placed' },
			{ kind: 'update', order: 'A-14', status: 'shipped' }
		]);
	});
});

/* -------------------------------------------------------------------------------------------------
 * What the host is asked to do about all of this.
 * ---------------------------------------------------------------------------------------------- */

const activation: Activation = {
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make('activation-outbound'),
	scope: {
		tenantId: TenantId.make('tenant-1'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('release-1')
	},
	deadlineEpochMs: Date.now() + 10_000,
	reason: 'deploy'
};

const unreachable = <Input, Output>(name: string): FacilityBinding<Input, Output> => ({
	call: async () => ({
		_tag: 'Failure',
		error: {
			code: `${name}.unreachable`,
			message: `activation must not call ${name}`,
			retryable: false,
			outcome: 'known'
		}
	})
});

describe('a write queues the drain that will deliver it', () => {
	/**
	 * Backoff being a timestamp rather than a sleep is only half a retry policy; something has to
	 * come back and look. That something used to be a fixed `* * * * *` registration per sending
	 * integration — 1440 wakes a day against the tenant's database whether or not anything was ever
	 * queued. A delivery is now enqueued by the write that caused it, in that write's own
	 * transaction, so the job cannot exist without the delivery.
	 */
	it('enqueues one flush task per sending integration, in the write is own transaction', async () => {
		await build(ordersModule);
		await create('order-17', { external_id: 'A-17', status: 'placed', amount: 1 });
		const rows = await current().database.query(
			"select command, input, status from bolt_task where command = 'integrations.flush'",
			[]
		);
		// `running`, because `bolt_task` records work the runtime has taken on rather than work
		// waiting to be claimed: the queue's `pending` state went with the claim that read it.
		expect(rows).toEqual([
			{ command: 'integrations.flush', input: { name: 'orders.partner' }, status: 'running' }
		]);
		// And it commits with the record, not after it: the two cannot disagree on whether the
		// delivery exists.
		const statements = current().database.statements;
		const rowInsert = statements.findIndex((sql) => sql.includes('insert into "orders"'));
		const taskInsert = statements.findIndex((sql) => sql.includes('insert into "bolt_task"'));
		expect(rowInsert).toBeGreaterThanOrEqual(0);
		expect(taskInsert).toBeGreaterThan(rowInsert);
	});

	/**
	 * Activation declares nothing for outbound deliveries. There is no drain cron and no schedule
	 * row — the registration is routing only, so a host knows where a manual flush is addressed,
	 * and a delivery that backs off schedules its own return instead of being looked for.
	 */
	it('activation declares no drain schedule, and only routes the flush command', async () => {
		const described = describeIntegrations({ orders: ordersModule('https://partner.example') });
		const definition = definitionFor(described.declarations);
		const bundle = makeBundle(definition, buildManifest(definition, { artifactId: 'outbound' }));
		const requests: Array<TaskRequest> = [];
		const database = await makeTestDatabase();
		try {
			for (const step of await provisioningStatements(definition)) {
				const result = await database.binding.call(
					{
						invocationId: activation.id,
						effectId: EffectId.make(`provision:${step.id}`),
						deadlineEpochMs: activation.deadlineEpochMs,
						idempotencyKey: step.id
					},
					{ _tag: 'Query', sql: step.sql, parameters: [] },
					new AbortController().signal
				);
				if (result._tag !== 'Success')
					throw new Error(`provisioning failed: ${JSON.stringify(result)}`);
			}
			const result = await bundle.activate(
				activation,
				{
					scope: activation.scope,
					tasks: {
						call: async (_metadata, input) => {
							requests.push(input);
							return { _tag: 'Success', value: {} };
						}
					} satisfies FacilityBinding<TaskRequest, TaskResponse>,
					database: database.binding,
					connector: unreachable<ConnectorRequest, ConnectorResponse>('connector')
				},
				new AbortController().signal
			);
			if (result._tag !== 'Activated')
				throw new Error(`activation failed: ${JSON.stringify(result)}`);
			// Registration is routing only — one entry per command, so a host knows where a manual
			// flush is addressed, and none of them carries a cron.
			expect(
				result.registrations.filter(({ command }) => command === 'integrations.flush')
			).toEqual([{ command: 'integrations.flush' }]);
			expect(
				requests.filter(
					(request) => request._tag === 'Register' && request.command === 'integrations.flush'
				)
			).toEqual([
				{
					_tag: 'Register',
					releaseId: activation.scope.releaseId,
					command: 'integrations.flush'
				}
			]);
			// No schedule row, because there is no cron: the only thing that schedules a drain is a
			// delivery itself.
			const schedules = await database.query('select key from bolt_schedule', []);
			expect(schedules).toEqual([]);
		} finally {
			await database.close();
		}
	});
});
