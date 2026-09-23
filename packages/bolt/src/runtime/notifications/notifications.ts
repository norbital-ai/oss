import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { and, asc, eq } from 'drizzle-orm';
import { EffectId, PushSubscription, WEB_PUSH_PUBLIC_KEY_CONFIG_KEY } from '@norbital-ai/bolt-protocol';
import { HostConfig } from '#lib/runtime/access/system-principal.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';

/**
 * The inbox ledger's reader and the browser push subscriptions. Rows land here from the `inbox`
 * transport's drain (`Channels.drain`), which also pushes them.
 */
const { bolt_notifications: notifications, bolt_push_subscriptions: pushSubscriptions } =
	SYSTEM_MODEL_TABLES;

export const Notification = Schema.Struct({
	id: Schema.NonEmptyString,
	recipient: Schema.NonEmptyString,
	payload: Schema.Json,
	read: Schema.Boolean
});
export interface Notification extends Schema.Schema.Type<typeof Notification> {}
export type Interface = Readonly<{
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
