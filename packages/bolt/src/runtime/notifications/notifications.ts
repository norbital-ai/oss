import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { and, asc, eq, isNull, notExists } from 'drizzle-orm';
import {
	EffectId,
	PushSubscription,
	WEB_PUSH_CHANNEL,
	WEB_PUSH_PUBLIC_KEY_CONFIG_KEY,
	WEB_PUSH_SUBSCRIPTION_GONE,
	type WebPushPayload
} from '@norbital-ai/bolt-protocol';
import { HostConfig } from '#lib/runtime/access/system-principal.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { Communication } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	aliased,
	bound,
	composer,
	dbNow,
	executeBuilt,
	jsonb,
	jsonTextEquals,
	one,
	transactionBuilt
} from '#lib/runtime/persistence.js';
import * as Workspace from '#lib/runtime/workspace.js';

const {
	bolt_audit: audit,
	bolt_notifications: notifications,
	bolt_push_subscriptions: pushSubscriptions
} = SYSTEM_MODEL_TABLES;

/** An inbox payload is `{ title, body }` by contract; anything else is pushed as its own title. */
const InboxMessage = Schema.Struct({
	title: Schema.NonEmptyString,
	body: Schema.optionalKey(Schema.String)
});
const decodeInboxMessage = Schema.decodeUnknownOption(InboxMessage);
const decodeSubscriptions = Schema.decodeUnknownEffect(Schema.Array(PushSubscription));

export const Notification = Schema.Struct({
	id: Schema.NonEmptyString,
	recipient: Schema.NonEmptyString,
	payload: Schema.Json,
	read: Schema.Boolean
});
export interface Notification extends Schema.Schema.Type<typeof Notification> {}
export type Interface = Readonly<{
	readonly enqueue: (
		effectId: EffectId,
		notification: Notification
	) => Effect.Effect<void, Database.FacilityError>;
	/** Pushes every undelivered inbox row to its recipient's browsers and marks it delivered. */
	readonly deliver: (effectId: EffectId) => Effect.Effect<number, Database.FacilityError>;
	readonly markRead: (
		effectId: EffectId,
		recipient: string,
		notificationId: string
	) => Effect.Effect<void, Database.FacilityError>;
	readonly list: (
		effectId: EffectId,
		recipient: string,
		unreadOnly?: boolean
	) => Effect.Effect<ReadonlyArray<Notification>, Database.FacilityError>;
	/** The host's VAPID public key, or none when this host sends no pushes. */
	readonly pushPublicKey: () => Effect.Effect<Option.Option<string>>;
	readonly subscribe: (
		effectId: EffectId,
		recipient: string,
		subscription: PushSubscription
	) => Effect.Effect<void, Database.FacilityError>;
	readonly unsubscribe: (
		effectId: EffectId,
		recipient: string,
		endpoint: string
	) => Effect.Effect<void, Database.FacilityError>;
}>;
/** Identifies the notifications service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Notifications');
export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const communication = yield* Communication.Service;
		const workspace = yield* Workspace.Service;
		const hostConfig = yield* Effect.serviceOption(HostConfig);
		const pushPublicKey = () =>
			Option.isNone(hostConfig)
				? Effect.succeedNone
				: hostConfig.value.read(WEB_PUSH_PUBLIC_KEY_CONFIG_KEY).pipe(
						Effect.map(Option.map(Redacted.value)),
						Effect.orElseSucceed(() => Option.none<string>())
					);
		// Scoped to the recipient: a browser can only ever drop a subscription it holds.
		const unsubscribe = Effect.fn('Notifications.unsubscribe')(function* (
			effectId: EffectId,
			recipient: string,
			endpoint: string
		) {
			yield* executeBuilt(
				effectId,
				database,
				composer
					.delete(pushSubscriptions)
					.where(
						and(
							eq(pushSubscriptions.recipient, recipient),
							eq(pushSubscriptions.endpoint, endpoint)
						)
					)
			);
		});
		/**
		 * Every browser the recipient subscribed gets the inbox row as a push. A push is best effort
		 * on top of the inbox, so a refused send is logged, not raised — except a push service that
		 * has forgotten the browser, which is the one answer that changes durable state here.
		 */
		const pushOut = Effect.fn('Notifications.push')(function* (
			effectId: EffectId,
			notification: Notification
		) {
			if (Option.isNone(yield* pushPublicKey())) return;
			const rows = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
					.from(pushSubscriptions)
					.where(eq(pushSubscriptions.recipient, notification.recipient))
			);
			const subscriptions = yield* decodeSubscriptions(rows.rows).pipe(
				Effect.orElseSucceed(() => [] as ReadonlyArray<PushSubscription>)
			);
			const message = decodeInboxMessage(notification.payload);
			const payload: Omit<WebPushPayload, 'subscription'> = Option.isSome(message)
				? { title: message.value.title, body: message.value.body ?? '' }
				: { title: workspace.definition.name, body: String(notification.payload) };
			for (const subscription of subscriptions) {
				const sent = yield* communication
					.execute(effectId, {
						_tag: 'Send',
						channel: WEB_PUSH_CHANNEL,
						recipient: subscription.endpoint,
						payload: { ...payload, subscription }
					})
					.pipe(Effect.result);
				if (sent._tag === 'Success') continue;
				if (sent.failure.code === WEB_PUSH_SUBSCRIPTION_GONE)
					yield* unsubscribe(effectId, notification.recipient, subscription.endpoint);
				else
					yield* Effect.logWarning(
						`[bolt] push to ${notification.recipient} not delivered: ${sent.failure.code}: ${sent.failure.message}`
					);
			}
		});
		return Service.of({
			pushPublicKey,
			unsubscribe,
			subscribe: Effect.fn('Notifications.subscribe')(
				function* (effectId, recipient, subscription) {
					yield* executeBuilt(
						effectId,
						database,
						composer
							.insert(pushSubscriptions)
							.values({
								recipient,
								endpoint: subscription.endpoint,
								keys: JSON.stringify(subscription.keys)
							})
							.onConflictDoUpdate({
								target: pushSubscriptions.endpoint,
								set: { recipient, keys: JSON.stringify(subscription.keys) }
							})
					);
				}
			),
			enqueue: Effect.fn('Notifications.enqueue')(function* (effectId, notification) {
				const auditPayload = {
					workspace: workspace.definition.name,
					notificationId: notification.id
				};
				const alreadyAudited = composer
					.select({ one: one() })
					.from(audit)
					.where(
						and(
							eq(audit.kind, 'notification_enqueued'),
							eq(audit.subject_id, notification.recipient),
							jsonTextEquals(audit.payload, 'notificationId', notification.id)
						)
					);
				const inserted = yield* transactionBuilt(effectId, database, [
					composer
						.insert(notifications)
						.values({ ...notification, payload: JSON.stringify(notification.payload) })
						.onConflictDoNothing({ target: notifications.id }),
					composer
						.insert(audit)
						.select(
							composer
								.select({
									kind: aliased(bound('notification_enqueued'), 'kind'),
									subject_id: aliased(bound(notification.recipient), 'subject_id'),
									payload: aliased(jsonb(auditPayload), 'payload')
								})
								.from(notifications)
								.where(and(eq(notifications.id, notification.id), notExists(alreadyAudited)))
						)
						.returning({ sequence: audit.sequence })
				]);
			}),
			deliver: Effect.fn('Notifications.deliver')(function* (effectId) {
				// ponytail: 200 per task; a write that lands more re-queues itself on the next write.
				const undelivered = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							id: notifications.id,
							recipient: notifications.recipient,
							payload: notifications.payload,
							read: notifications.read
						})
						.from(notifications)
						.where(isNull(notifications.delivered_at))
						.orderBy(asc(notifications.id))
						.limit(200)
				);
				const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Notification))(
					undelivered.rows
				).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Notification>));
				for (const notification of rows) {
					yield* pushOut(effectId, notification);
					yield* executeBuilt(
						effectId,
						database,
						composer
							.update(notifications)
							.set({ delivered_at: dbNow() })
							.where(eq(notifications.id, notification.id))
					);
				}
				return rows.length;
			}),
			markRead: Effect.fn('Notifications.markRead')(
				function* (effectId, recipient, notificationId) {
					yield* executeBuilt(
						effectId,
						database,
						composer
							.update(notifications)
							.set({ read: true })
							.where(
								and(eq(notifications.id, notificationId), eq(notifications.recipient, recipient))
							)
					);
				}
			),
			list: Effect.fn('Notifications.list')(function* (effectId, recipient, unreadOnly = false) {
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							id: notifications.id,
							recipient: notifications.recipient,
							payload: notifications.payload,
							read: notifications.read
						})
						.from(notifications)
						.where(
							and(
								eq(notifications.recipient, recipient),
								unreadOnly ? eq(notifications.read, false) : undefined
							)
						)
						.orderBy(asc(notifications.id))
				);
				return yield* Schema.decodeUnknownEffect(Schema.Array(Notification))(result.rows).pipe(
					Effect.mapError(
						() =>
							new Database.FacilityError({
								operation: 'notifications.list',
								code: 'malformed_persistence',
								message: 'Stored notification rows do not satisfy the notification schema',
								retryable: false,
								outcome: 'known'
							})
					)
				);
			})
		});
	})
);
