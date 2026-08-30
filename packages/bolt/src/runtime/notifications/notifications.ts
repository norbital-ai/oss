import { Context, Effect, Layer, Schema } from 'effect';
import { and, asc, eq, notExists } from 'drizzle-orm';
import { EffectId } from '@norbital-ai/bolt-protocol';
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

const { bolt_audit: audit, bolt_notifications: notifications } = SYSTEM_MODEL_TABLES;

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
	readonly drain: (
		effectId: EffectId,
		notification: Notification
	) => Effect.Effect<void, Database.FacilityError>;
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
}>;
/** Identifies the notifications service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Notifications');
export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const database = yield* Database.Service;
		const communication = yield* Communication.Service;
		const workspace = yield* Workspace.Service;
		return Service.of({
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
			drain: Effect.fn('Notifications.drain')(function* (effectId, notification) {
				yield* communication.execute(effectId, {
					_tag: 'Notify',
					recipient: notification.recipient,
					payload: notification.payload
				});
				yield* executeBuilt(
					effectId,
					database,
					composer
						.update(notifications)
						.set({ delivered_at: dbNow() })
						.where(eq(notifications.id, notification.id))
				);
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
