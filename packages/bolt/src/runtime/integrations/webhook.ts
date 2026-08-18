import { Effect, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '../../authoring/integration-introspection.js';
import type {
	IntegrationDeclaration,
	IntegrationWebhookDeclaration
} from '../../authoring/workspace-schema.js';
import { absorbRecords, type AbsorbDependencies, type Rejection } from './absorb.js';
import { verifyDelivery } from './signature.js';

/**
 * One pushed delivery, from raw bytes to rows.
 *
 * The sequence is fixed and the order is the design: verify, then recognise, then absorb. Nothing
 * reads the body before the signature has matched, and nothing writes a row before the delivery
 * ledger has said this is not a repeat of one already absorbed. A binding that fails any of the
 * three fails the whole delivery, so the host answers the source non-2xx and the source redelivers —
 * which is the behaviour every provider's retry policy is built around.
 *
 * Split from the service for the same reason `pull.ts` is: the loop asks for a secret, a ledger
 * entry and a write, and gets them. That is what makes the refusals testable without a database,
 * and the refusals are the part that has to be right.
 */

const REJECTIONS_REPORTED = 20;

/**
 * What the ledger knew about this delivery before we wrote to it.
 *
 * `pending` is the state that earns the ledger its keep. A delivery whose rows were half written
 * when the process died leaves a row behind, and treating that as "already handled" would drop the
 * redelivery that was supposed to finish the job. So a `pending` entry is absorbed again — safe,
 * because every write is an identity upsert — while an `absorbed` one is recognised and skipped.
 */
export type LedgerState = 'new' | 'pending' | 'absorbed';

export type WebhookDependencies = AbsorbDependencies & Readonly<{
	/** Reads a declared secret, or fails naming the variable that has no value. */
	readonly secret: (effectId: EffectId, name: string) => Effect.Effect<string, { readonly message: string }>;
	/**
	 * Records this delivery in `bolt_integration_inbox` and says what was there before.
	 *
	 * One call rather than a read then a write, because two deliveries of the same event can arrive
	 * concurrently — providers parallelise retries — and a read-then-write would let both see nothing
	 * and both absorb. The insert's own conflict clause is the arbiter.
	 */
	readonly remember: (
		effectId: EffectId,
		entry: { readonly integration: string; readonly binding: string; readonly receiptId: string; readonly payload: Schema.Json }
	) => Effect.Effect<LedgerState, { readonly message: string }>;
	/** Marks a ledger entry absorbed, so a later redelivery of it is recognised as a repeat. */
	readonly settle: (
		effectId: EffectId,
		entry: { readonly integration: string; readonly receiptId: string }
	) => Effect.Effect<void, { readonly message: string }>;
	readonly now: () => number;
}>;

export type DeliveryReport = Readonly<{
	readonly binding: string;
	/** The ledger key this delivery was recognised by — the source's event id, or the digest. */
	readonly deliveryId: string;
	/** True when the ledger had already absorbed this delivery, so nothing was written this time. */
	readonly duplicate: boolean;
	/** Whether the signature covered a timestamp that was checked against the replay window. */
	readonly replayChecked: boolean;
	readonly received: number;
	readonly created: number;
	readonly updated: number;
	readonly rejected: ReadonlyArray<Rejection>;
}>;

/** Walks a body down a path of object keys, stopping at the first step that is not an object. */
const walk = (body: Schema.Json, path: ReadonlyArray<string>): unknown => {
	let cursor: unknown = body;
	for (const step of path) {
		if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
		cursor = Reflect.get(cursor, step);
	}
	return cursor;
};

/**
 * The records inside a delivery.
 *
 * A body that is not an array and declares no `records` path is one record, not zero. That is the
 * difference between a webhook and a pull: a pull reads a feed and a feed is a list, while most
 * providers post one event per request. Treating a single-object body as an empty list would make
 * the common case silently absorb nothing.
 */
const selectRecords = (body: Schema.Json, records: IntegrationWebhookDeclaration['records']): ReadonlyArray<unknown> => {
	const found = records === undefined ? body : walk(body, 'field' in records ? [records.field] : records.path);
	if (Array.isArray(found)) return found;
	return found === undefined || found === null ? [] : [found];
};

/**
 * How this delivery is recognised if it arrives again.
 *
 * The source's own event id when it names one, because that is the identifier the source itself
 * deduplicates on and it survives a redelivery that re-signs with a fresh timestamp. Failing that,
 * the verified digest — which is a value only a holder of the secret could have produced, and which
 * is identical for two byte-identical deliveries.
 *
 * Both are taken from a header or from the signature, never from the body. A body field naming its
 * own delivery id would let a sender collapse two real events into one, or split one event into
 * many, by editing a value the platform then treated as authority.
 */
const deliveryKey = (
	binding: IntegrationWebhookDeclaration,
	headers: Readonly<Record<string, string>>,
	digest: string
): string => {
	const named = binding.eventIdHeader;
	if (named !== undefined) {
		const wanted = named.trim().toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.trim().toLowerCase() === wanted && value.trim() !== '') return `${binding.name}:${value.trim()}`;
		}
	}
	return `${binding.name}:${digest}`;
};

export const runWebhookDelivery = (
	dependencies: WebhookDependencies,
	effectId: EffectId,
	integration: IntegrationDeclaration,
	binding: IntegrationWebhookDeclaration,
	authored: AuthoredIntegrationBinding,
	delivery: { readonly headers: Readonly<Record<string, string>>; readonly body: string }
): Effect.Effect<DeliveryReport, { readonly message: string }> =>
	Effect.gen(function* () {
		// Default deny, and it is the first thing that happens. The secret is resolved by the name the
		// declaration carries, through the same vault read that resolves a pull's bearer token — so a
		// route whose secret is not provisioned refuses every delivery rather than accepting them.
		const secret = yield* dependencies.secret(effectId, binding.signature.secret.env);
		const outcome = verifyDelivery(binding.signature, secret, delivery, dependencies.now());
		if (!outcome.verified) {
			return yield* Effect.fail({ message: `${integration.name}.${binding.name} refused a delivery: ${outcome.refusal.reason}` });
		}

		// Parsed only now — after the bytes are known to be authentic. Parsing first would mean running
		// a parser over anything the internet posted at the route, and it would tempt the digest to be
		// taken over the reparsed document, which matches nothing the sender signed.
		const parsed = yield* Effect.try({
			try: (): Schema.Json => JSON.parse(delivery.body) as Schema.Json,
			catch: () => ({ message: `${integration.name}.${binding.name} received a correctly signed body that is not JSON.` })
		});

		const deliveryId = deliveryKey(binding, delivery.headers, outcome.proof.digest);
		const state = yield* dependencies.remember(effectId, {
			integration: integration.name,
			binding: binding.name,
			receiptId: deliveryId,
			payload: parsed
		});
		const empty = {
			binding: binding.name,
			deliveryId,
			replayChecked: outcome.proof.replayChecked,
			received: 0,
			created: 0,
			updated: 0,
			rejected: []
		} as const;
		if (state === 'absorbed') return { ...empty, duplicate: true };

		const raw = selectRecords(parsed, binding.records);
		const absorbed = yield* absorbRecords(
			dependencies,
			effectId,
			{ integration: integration.name, binding: binding.name, collection: integration.collection, identityColumn: binding.identityColumn },
			authored,
			raw,
			0,
			REJECTIONS_REPORTED
		);
		// Settled only once the rows are down. A delivery marked absorbed before its writes would be
		// skipped on redelivery, which turns a crash halfway through a batch into permanent data loss —
		// the one failure the at-least-once contract is supposed to protect against.
		yield* dependencies.settle(effectId, { integration: integration.name, receiptId: deliveryId });
		return {
			...empty,
			duplicate: false,
			received: raw.length,
			created: absorbed.created,
			updated: absorbed.updated,
			rejected: absorbed.rejected
		};
	});
