import { Result, Schema } from 'effect';
import type {
	AuthoredIntegrationSend,
	IntegrationSendEventContext
} from '#lib/authoring/integration-introspection.js';
import type {
	IntegrationDeclaration,
	IntegrationSendDeclaration,
	IntegrationSendEvent
} from '#lib/authoring/workspace-schema.js';
import type * as Identity from '#lib/runtime/identity/identity.js';

/**
 * The enqueue half of outbound delivery: one collection write, turned into rows for the outbox.
 *
 * This is the part that runs inside the tenant's own mutation, so everything in this file is pure
 * and synchronous. It reads the authored trigger, decides whether the write concerns any outbound
 * binding, builds the payload, and hands back rows for the caller to insert **in the same
 * transaction as the write itself**. Nothing here opens a socket, and nothing here can.
 *
 * That is the answer to the only interesting question about an outbound integration: what fires it.
 * A hook that performed the request would be simpler to write and would make every create in the
 * collection wait on a partner's response time, take that partner's outage as a failed tenant
 * write, and lose the event entirely if the process died between the commit and the request. So the
 * write enqueues and a drain delivers — the same shape Colony's storage meter was moved to, for the
 * same reason.
 *
 * Enqueuing in the write's own transaction is what makes the queue trustworthy rather than merely
 * asynchronous: the row and the intent to tell somebody about the row commit together or not at
 * all. A post-commit enqueue has a window in which the row exists and the delivery does not, and
 * that window is exactly where a silently dropped outbound event comes from.
 */

/** One outbound binding, bound to the collection whose writes it watches. */
export type SendSubscription = Readonly<{
	readonly integration: string;
	readonly collection: string;
	readonly declaration: IntegrationSendDeclaration;
	readonly authored: AuthoredIntegrationSend;
}>;

/**
 * One row for `bolt_integration_outbox`.
 *
 * `refusal` is what makes an authored mistake visible instead of fatal. A trigger predicate or a
 * body function is authored code and can throw; letting that throw propagate would fail the
 * tenant's write over a mistyped field access, and swallowing it would drop the event with no trace
 * anywhere. So the entry is still written — dead-lettered, naming the binding and the reason — and
 * the write proceeds. `payload` is `null` on such an entry because there is nothing to send.
 */
type OutboxEntry = Readonly<{
	readonly integration: string;
	readonly binding: string;
	readonly collection: string;
	readonly recordId: string;
	readonly operation: IntegrationSendEvent;
	/**
	 * The request path, with its `{column}` tokens already filled from the record.
	 *
	 * Resolved here and stored rather than resolved at delivery time, because by then the record may
	 * have changed or — for a delete, which is the case that needs the token most — may not exist. A
	 * delivery addressing the row as it was when the event happened is the only addressing that can
	 * be right.
	 */
	readonly path: string | null;
	readonly payload: Schema.Json | null;
	readonly refusal: string | null;
}>;

/**
 * Fills `{column}` tokens in a declared path from the record, percent-encoding every value.
 *
 * The values come from the row and never from the payload, for the reason an inbound identity is
 * read through the declared `identity` rather than from the body: a delivery that could nominate
 * the resource it addresses is a delivery that can address the wrong one. Encoding is not optional
 * either — an external key containing a `/` would otherwise silently retarget the request at a
 * different path.
 *
 * A token with no usable value refuses rather than substituting an empty string, because
 * `PUT /orders/` is a request against the collection endpoint and an API that accepts it does
 * something entirely unlike what the binding meant.
 */
const resolvePath = (
	path: string,
	record: Readonly<Record<string, unknown>>
): { readonly path: string } | { readonly refusal: string } => {
	const missing: Array<string> = [];
	const filled = path.replaceAll(/\{([^{}]+)\}/g, (_token, name: string) => {
		const value: unknown = Reflect.get(record, name);
		if (typeof value === 'string' && value !== '') return encodeURIComponent(value);
		if (typeof value === 'number' || typeof value === 'bigint')
			return encodeURIComponent(String(value));
		missing.push(name);
		return '';
	});
	return missing.length === 0
		? { path: filled }
		: {
				refusal: `the path names {${missing.join('}, {')}} and the record carries no value for ${missing.length === 1 ? 'it' : 'them'}`
			};
};

/**
 * Every outbound binding a workspace declares, indexed by the collection it watches.
 *
 * Built once when the collections layer is constructed rather than per write. A collection with no
 * outbound binding — which is nearly all of them — then costs one failed map lookup per mutation
 * and not a scan of the workspace's integrations.
 */
export const sendSubscriptions = (
	integrations: ReadonlyArray<IntegrationDeclaration>,
	authored: Readonly<
		Record<string, Readonly<{ readonly send: Readonly<Record<string, AuthoredIntegrationSend>> }>>
	>
): ReadonlyMap<string, ReadonlyArray<SendSubscription>> => {
	const byCollection = new Map<string, Array<SendSubscription>>();
	for (const integration of integrations) {
		for (const declaration of integration.send) {
			const live = authored[integration.name]?.send[declaration.name];
			// A declaration whose authored half did not reach the runtime is skipped rather than
			// guessed at: its trigger predicate is the thing that decides whether a write is worth
			// sending, and a binding without one would either send everything or nothing.
			if (live === undefined) continue;
			const existing = byCollection.get(integration.collection);
			const subscription: SendSubscription = {
				integration: integration.name,
				collection: integration.collection,
				declaration,
				authored: live
			};
			if (existing === undefined) byCollection.set(integration.collection, [subscription]);
			else existing.push(subscription);
		}
	}
	return byCollection;
};

/** Whether any outbound binding on this collection watches this operation at all. */
export const watchesOperation = (
	subscriptions: ReadonlyArray<SendSubscription>,
	operation: IntegrationSendEvent
): boolean => subscriptions.some(({ declaration }) => declaration.events.includes(operation));

/**
 * The row as the trigger and the body see it.
 *
 * An update is the merge of what was stored and what is being written, because the predicate is
 * asked "is this record now interesting" and a bare patch cannot answer that — `{ status: 'shipped' }`
 * does not carry the customer the body wants to name. `id` is stamped last so a payload can
 * always address the record, and stamped rather than trusted from the values for the same reason an
 * inbound identity column is: the record is data, not authority.
 */
export const eventRecord = (
	operation: IntegrationSendEvent,
	id: string,
	values: Readonly<Record<string, Schema.Json>>,
	previous: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> =>
	operation === 'delete'
		? { ...(previous ?? {}), id: id }
		: { ...(previous ?? {}), ...values, id: id };

const describe = (cause: unknown): string =>
	cause instanceof Error && cause.message !== '' ? cause.message : String(cause);

/**
 * The default payload, for a binding that declares no `body`.
 *
 * Deliberately an envelope rather than the bare row: a receiver has to be able to tell a create
 * from a delete, and the record alone cannot say which it is. `record` is the whole row, which is
 * the honest default and also the reason `body` exists — a collection with columns a partner has no
 * business seeing should state what it sends.
 */
const defaultBody = (
	collection: string,
	event: IntegrationSendEventContext,
	recordId: string
): Schema.Json => ({
	event: event.operation,
	collection,
	id: recordId,
	record: Schema.is(Schema.Json)(event.record) ? event.record : null
});

/**
 * One collection write, as the outbox sees it: the row's id plus everything a trigger or body is
 * told about the event.
 */
type OutboxEvent = IntegrationSendEventContext &
	Readonly<{ readonly recordId: string }>;

/**
 * Turns one collection write into the outbox rows it earns.
 *
 * Per binding, and each one isolated: a binding whose predicate throws dead-letters that binding's
 * entry and leaves every other binding on the collection untouched. That is `absorb.ts`'s rule —
 * one bad record costs a record — applied to the other direction, where the unit is a binding
 * rather than a record.
 *
 * `writer` is the subject performing the write, and it is here for one rule: an integration's own
 * mirror write does not queue a delivery back to that same integration. Without it, a collection
 * that both pulls from a system and sends to it is a loop — the pull writes, the write queues a
 * send, the send updates the source, the next pull writes again — and the loop is invisible in
 * review because each half is individually correct. It is scoped to the *same* integration on
 * purpose: mirroring one system into a collection that feeds another is a real pattern, and this
 * does not refuse it.
 */
export const outboxEntriesFor = (
	subscriptions: ReadonlyArray<SendSubscription>,
	writer: Identity.Subject,
	event: OutboxEvent
): ReadonlyArray<OutboxEntry> => {
	const entries: Array<OutboxEntry> = [];
	const context: IntegrationSendEventContext = {
		operation: event.operation,
		record: event.record,
		previous: event.previous
	};
	for (const subscription of subscriptions) {
		if (!subscription.declaration.events.includes(event.operation)) continue;
		if (writer.userId === `integration:${subscription.integration}`) continue;
		const base = {
			integration: subscription.integration,
			binding: subscription.declaration.name,
			collection: subscription.collection,
			recordId: event.recordId,
			operation: event.operation
		} as const;
		const refuse = (reason: string): void => {
			entries.push({ ...base, path: null, payload: null, refusal: reason });
		};
		let matched: boolean;
		const matchedAttempt = Result.try(() => subscription.authored.matches(context));
		if (Result.isFailure(matchedAttempt)) {
			refuse(`the ${event.operation} trigger threw: ${describe(matchedAttempt.failure)}`);
			continue;
		}
		matched = matchedAttempt.success;
		if (!matched) continue;
		const target = resolvePath(subscription.declaration.path, event.record);
		if (!('path' in target)) {
			refuse(target.refusal);
			continue;
		}
		const build = subscription.authored.body;
		if (build === undefined) {
			entries.push({
				...base,
				path: target.path,
				payload: defaultBody(subscription.collection, context, event.recordId),
				refusal: null
			});
			continue;
		}
		let produced: unknown;
		const buildAttempt = Result.try(() => build(context));
		if (Result.isFailure(buildAttempt)) {
			refuse(`the body function threw: ${describe(buildAttempt.failure)}`);
			continue;
		}
		produced = buildAttempt.success;
		if (!Schema.is(Schema.Json)(produced)) {
			// Refused rather than coerced. A body silently stringified into `"[object Object]"` is a
			// delivery a partner accepts and cannot use, which is worse than one that never left.
			refuse('the body function produced a value that is not JSON');
			continue;
		}
		entries.push({ ...base, path: target.path, payload: produced, refusal: null });
	}
	return entries;
};
