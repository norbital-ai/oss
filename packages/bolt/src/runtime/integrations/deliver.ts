import { Effect, Result, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type {
	HttpConnection,
	IntegrationDeclaration,
	IntegrationSendDeclaration
} from '../../authoring/workspace-schema.js';
import { isRetryableStatus, retryDelayMs, type IntegrationHttpMethod } from './http.js';
import { authenticationHeaders } from './pull.js';

/**
 * The drain half of outbound delivery: queued rows out, HTTP requests away, outcomes recorded.
 *
 * Split from the service for the reason `pull.ts` and `webhook.ts` are: the loop asks for a claim,
 * a credential, a request and a settlement, and gets them. What it decides — retry this, do not
 * retry that, give up now, wait this long — is then testable without a database and without a
 * network, and those decisions are the entire contract this file exists to keep.
 *
 * **The contract, stated once, here.**
 *
 * *Delivery is at-least-once.* A receiver may see the same delivery twice: an acknowledgement can
 * be lost after the request was processed, and the only honest response to a lost acknowledgement
 * is to send again. Exactly-once across an HTTP boundary is not achievable and is not claimed. What
 * the platform owes instead is a key a receiver can deduplicate on — `idempotencyHeader`, derived
 * from the outbox row's own sequence, byte-identical across every attempt at that row.
 *
 * *Retry is for the failures that can succeed.* A 429 or a 5xx is the receiver saying "not now"; a
 * 4xx is it saying "not like that", and repeating a request it has already rejected on its merits
 * spends its rate limit to no purpose. So 429 and 5xx retry with exponential backoff — doubling,
 * capped, and yielding to a `Retry-After` when the receiver sent one, because it is the only party
 * that knows — and every other 4xx dead-letters on the first answer.
 *
 * *Backoff is persisted, not slept.* The next attempt is a timestamp on the row, not a sleep inside
 * this loop. A sleeping retry holds the invocation open for as long as the partner is down, and a
 * host that killed it on a deadline would lose the schedule rather than the attempt.
 *
 * *Ordering is per record, and only per record.* The claim takes the lowest pending sequence for
 * each record, so two updates to one row are delivered in the order they happened and the second
 * waits while the first is backing off. Between different records there is no ordering guarantee at
 * all, and none is implied. One exception is stated rather than hidden: when a delivery exhausts
 * its retries and dead-letters, it stops blocking the deliveries behind it — the alternative is one
 * unreachable endpoint freezing a record's queue permanently.
 *
 * *Nothing that fails disappears.* Every terminal outcome is a row in `bolt_integration_outbox`
 * with `status = 'failed'`, the status code that caused it and a short reason. `Integrations.status`
 * counts them.
 */

/** What a claimed row carries into one delivery attempt. */
export type ClaimedDelivery = Readonly<{
	readonly sequence: number;
	readonly binding: string;
	readonly collection: string;
	readonly recordId: string;
	readonly operation: string;
	readonly path: string | null;
	readonly payload: Schema.Json | null;
	/** This attempt's number, one-based — the claim increments it, so a first attempt arrives as 1. */
	readonly attempts: number;
}>;

/** How a delivery ended, as the ledger records it. */
export type Settlement =
	| Readonly<{ readonly _tag: 'Delivered'; readonly sequence: number; readonly status: number }>
	| Readonly<{
			readonly _tag: 'Retry';
			readonly sequence: number;
			readonly status: number | null;
			readonly reason: string;
			readonly delayMs: number;
	  }>
	| Readonly<{
			readonly _tag: 'Failed';
			readonly sequence: number;
			readonly status: number | null;
			readonly reason: string;
	  }>;

type Answered = Readonly<{
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Schema.Json;
}>;

export type DeliverDependencies = Readonly<{
	/**
	 * Claims the next due deliveries for this integration and marks them in flight.
	 *
	 * One statement rather than a read then a write, for the reason `claimPull` is one: two drains
	 * can overlap — a cron tick and a manual flush — and a read-then-write would let both claim the
	 * same rows and deliver each of them twice for no reason at all.
	 */
	readonly claim: (
		effectId: EffectId,
		integration: string,
		limit: number
	) => Effect.Effect<ReadonlyArray<ClaimedDelivery>, { readonly message: string }>;
	readonly request: (
		effectId: EffectId,
		connector: string,
		descriptor: {
			readonly method: IntegrationHttpMethod;
			readonly url: string;
			readonly headers: Readonly<Record<string, string>>;
			readonly body?: Schema.Json;
		}
	) => Effect.Effect<Answered, { readonly message: string; readonly retryable: boolean }>;
	/** Reads a declared secret, or fails naming the variable that has no value. */
	readonly secret: (
		effectId: EffectId,
		name: string
	) => Effect.Effect<string, { readonly message: string }>;
	readonly settle: (
		effectId: EffectId,
		settlement: Settlement
	) => Effect.Effect<void, { readonly message: string }>;
	readonly now: () => number;
}>;

export type DeliveryOutcome = Readonly<{
	readonly binding: string;
	readonly recordId: string;
	readonly operation: string;
	readonly attempt: number;
	readonly outcome: 'delivered' | 'retrying' | 'failed';
	readonly status: number | null;
	/** Absent on success. Never a payload and never a header — a status and a short sentence. */
	readonly reason: string | null;
}>;

export type FlushReport = Readonly<{
	readonly integration: string;
	readonly collection: string;
	readonly claimed: number;
	readonly delivered: number;
	readonly retrying: number;
	readonly failed: number;
	readonly deliveries: ReadonlyArray<DeliveryOutcome>;
}>;

/** How many deliveries one drain may attempt, when the caller does not say. */
export const DRAIN_BATCH_DEFAULT = 25;

/** How many times a retryable failure is retried before the delivery dead-letters. */
const ATTEMPTS_DEFAULT = 5;
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

/**
 * How much of a failure reason is kept.
 *
 * A reason is diagnostic, not an archive. A partner that answers a 500 with a two-megabyte HTML
 * error page would otherwise put two megabytes of it in this tenant's database on every attempt,
 * and the useful part is in the first line.
 */
const REASON_LIMIT = 300;

const shorten = (reason: string): string =>
	reason.length <= REASON_LIMIT ? reason : `${reason.slice(0, REASON_LIMIT)}…`;

/**
 * The delivery key a receiver deduplicates on.
 *
 * Derived from the outbox row's identity, so every attempt at one delivery presents the same value
 * and two genuinely different events never collide — including two updates to the same record,
 * which are two deliveries and must not be collapsed into one. It is derived and never taken from
 * the payload, for the same reason an inbound receipt is derived from a header or the verified
 * digest: a key the message supplies is a key the message gets to choose.
 */
export const deliveryKey = (integration: string, binding: string, sequence: number): string =>
	`${integration}:${binding}:${sequence}`;

/** Whether this method carries a body. `DELETE` does not: several APIs answer 400 to one that does. */
const carriesBody = (method: IntegrationHttpMethod): boolean =>
	method === 'POST' || method === 'PUT' || method === 'PATCH';

const url = (connection: HttpConnection, path: string): string =>
	`${connection.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

/**
 * Runs one claimed delivery and says how it ended.
 *
 * A single attempt, not a retry loop: the retry lives in the ledger, so what this decides is
 * whether there should *be* another attempt and how long to wait for it.
 */
const attemptDelivery = (
	dependencies: DeliverDependencies,
	effectId: EffectId,
	integration: IntegrationDeclaration,
	connection: HttpConnection,
	declaration: IntegrationSendDeclaration,
	headers: Readonly<Record<string, string>>,
	claimed: ClaimedDelivery
): Effect.Effect<{ readonly settlement: Settlement; readonly outcome: DeliveryOutcome }> =>
	Effect.gen(function* () {
		const describe = (
			outcome: DeliveryOutcome['outcome'],
			status: number | null,
			reason: string | null
		): DeliveryOutcome => ({
			binding: claimed.binding,
			recordId: claimed.recordId,
			operation: claimed.operation,
			attempt: claimed.attempts,
			outcome,
			status,
			reason
		});
		const attempts = Math.max(declaration.retry?.attempts ?? ATTEMPTS_DEFAULT, 1);
		const backoff = {
			initialDelayMs: declaration.retry?.initialDelayMs ?? INITIAL_DELAY_MS,
			maxDelayMs: declaration.retry?.maxDelayMs ?? MAX_DELAY_MS
		};
		// A row queued without a resolved path is a row `outboxEntriesFor` already refused, so it should
		// never have been claimable. Stated rather than asserted away: a claim that started returning
		// one should dead-letter it with a sentence rather than request `undefined`.
		if (claimed.path === null) {
			const reason = `${integration.name}.${claimed.binding} has no resolved request path`;
			return {
				settlement: { _tag: 'Failed', sequence: claimed.sequence, status: null, reason },
				outcome: describe('failed', null, reason)
			};
		}
		const answer = yield* Effect.result(
			dependencies.request(effectId, integration.name, {
				method: declaration.method,
				url: url(connection, claimed.path),
				headers,
				...(carriesBody(declaration.method) && claimed.payload !== null
					? { body: claimed.payload }
					: {})
			})
		);
		const status = Result.isSuccess(answer) ? answer.success.status : null;
		if (Result.isSuccess(answer) && answer.success.status < 400) {
			return {
				settlement: {
					_tag: 'Delivered',
					sequence: claimed.sequence,
					status: answer.success.status
				},
				outcome: describe('delivered', answer.success.status, null)
			};
		}
		const reason = shorten(
			Result.isFailure(answer)
				? answer.failure.message
				: `${declaration.method} answered ${answer.success.status}`
		);
		const retryable = Result.isFailure(answer)
			? answer.failure.retryable
			: isRetryableStatus(answer.success.status);
		if (!retryable) {
			return {
				// A 4xx is terminal on the first answer. Nothing about repeating a request the receiver has
				// already rejected on its merits changes the answer, and the attempts would land on
				// somebody else's rate limit.
				settlement: { _tag: 'Failed', sequence: claimed.sequence, status, reason },
				outcome: describe('failed', status, reason)
			};
		}
		if (claimed.attempts >= attempts) {
			const exhausted = `${reason} (gave up after ${claimed.attempts} attempts)`;
			return {
				settlement: { _tag: 'Failed', sequence: claimed.sequence, status, reason: exhausted },
				outcome: describe('failed', status, exhausted)
			};
		}
		// `Retry-After` belongs to the answer that just arrived, so it is read here rather than
		// recomputed later: the receiver is the only party that knows when it will be ready.
		const after = Result.isSuccess(answer) ? answer.success.headers['retry-after'] : undefined;
		const delayMs = retryDelayMs(claimed.attempts - 1, backoff, after, dependencies.now());
		return {
			settlement: { _tag: 'Retry', sequence: claimed.sequence, status, reason, delayMs },
			outcome: describe('retrying', status, reason)
		};
	});

/**
 * Drains one integration's outbox.
 *
 * Sequential rather than concurrent, and that is the ordering guarantee doing its work: a batch is
 * claimed in sequence order and delivered in it, so a partner sees one record's events in the order
 * they happened. It also means a slow receiver costs one drain rather than a burst of parallel
 * requests at a system that is already struggling.
 *
 * Every delivery is isolated. A settlement that fails to write is reported against that delivery
 * and the drain continues, because the alternative — one row's failure aborting the batch — leaves
 * every delivery after it claimed, in flight and unsettled.
 */
export const runOutboxDrain = (
	dependencies: DeliverDependencies,
	effectId: EffectId,
	integration: IntegrationDeclaration,
	limit: number
): Effect.Effect<FlushReport, { readonly message: string }> =>
	Effect.gen(function* () {
		const connection = integration.connection;
		if (connection === undefined) {
			// Unreachable by construction — `describeIntegrations` refuses an integration that declares a
			// send without a connection — and stated anyway, because the alternative to stating it is
			// asserting it away with a cast.
			return yield* Effect.fail({
				message: `${integration.name} declares a send binding with no connection: there is no baseUrl to deliver to.`
			});
		}
		const claimed = yield* dependencies.claim(effectId, integration.name, Math.max(limit, 1));
		const empty: FlushReport = {
			integration: integration.name,
			collection: integration.collection,
			claimed: claimed.length,
			delivered: 0,
			retrying: 0,
			failed: 0,
			deliveries: []
		};
		if (claimed.length === 0) return empty;

		// Resolved once for the batch rather than per delivery: it is one vault read for one connection,
		// and doing it per row would multiply a tenant's secret reads by the size of the queue.
		const credential = yield* authenticationHeaders(dependencies.secret, effectId, connection);
		const deliveries: Array<DeliveryOutcome> = [];
		let delivered = 0;
		let retrying = 0;
		let failed = 0;
		for (const entry of claimed) {
			const declaration = integration.send.find((candidate) => candidate.name === entry.binding);
			if (declaration === undefined) {
				// The binding was removed from the workspace after the delivery was queued. Dead-lettered
				// rather than left pending forever: a queue that grows against a binding nobody declares is
				// a leak, and one that is silently dropped is the failure this whole ledger exists to stop.
				const reason = `${integration.name} no longer declares a send binding named ${entry.binding}`;
				const settled = yield* Effect.result(
					dependencies.settle(effectId, {
						_tag: 'Failed',
						sequence: entry.sequence,
						status: null,
						reason
					})
				);
				failed += 1;
				deliveries.push({
					binding: entry.binding,
					recordId: entry.recordId,
					operation: entry.operation,
					attempt: entry.attempts,
					outcome: 'failed',
					status: null,
					reason: Result.isFailure(settled)
						? `${reason}; and the ledger write failed: ${settled.failure.message}`
						: reason
				});
				continue;
			}
			const headers = {
				...(declaration.headers ?? {}),
				...credential,
				[declaration.idempotencyHeader ?? 'idempotency-key']: deliveryKey(
					integration.name,
					entry.binding,
					entry.sequence
				)
			};
			const attempted = yield* attemptDelivery(
				dependencies,
				effectId,
				integration,
				connection,
				declaration,
				headers,
				entry
			);
			const settled = yield* Effect.result(dependencies.settle(effectId, attempted.settlement));
			if (attempted.outcome.outcome === 'delivered') delivered += 1;
			else if (attempted.outcome.outcome === 'retrying') retrying += 1;
			else failed += 1;
			deliveries.push(
				Result.isFailure(settled)
					? {
							...attempted.outcome,
							reason: `${attempted.outcome.reason ?? 'delivered'}; and the ledger write failed: ${settled.failure.message}`
						}
					: attempted.outcome
			);
		}
		return { ...empty, delivered, retrying, failed, deliveries };
	});
