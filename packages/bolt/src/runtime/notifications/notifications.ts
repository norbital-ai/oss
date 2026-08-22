import { Context, Effect, Layer, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { Communication } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Workspace from '#lib/runtime/workspace.js';

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
				yield* database.execute(effectId, {
					_tag: 'Transaction',
					statements: [
						{
							sql: 'insert into bolt_notifications (id, recipient, payload, read) values ($1, $2, $3, $4) on conflict do nothing',
							parameters: [
								notification.id,
								notification.recipient,
								notification.payload,
								notification.read
							]
						},
						{
							sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
							parameters: [
								'notification_enqueued',
								notification.recipient,
								{ workspace: workspace.definition.name, notificationId: notification.id }
							]
						}
					]
				});
			}),
			drain: Effect.fn('Notifications.drain')(function* (effectId, notification) {
				yield* communication.execute(effectId, {
					_tag: 'Notify',
					recipient: notification.recipient,
					payload: notification.payload
				});
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'update bolt_notifications set delivered_at = now() where id = $1',
					parameters: [notification.id]
				});
			}),
			markRead: Effect.fn('Notifications.markRead')(
				function* (effectId, recipient, notificationId) {
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'update bolt_notifications set read = true where id = $1 and recipient = $2',
						parameters: [notificationId, recipient]
					});
				}
			),
			list: Effect.fn('Notifications.list')(function* (effectId, recipient, unreadOnly = false) {
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select id, recipient, payload, read from bolt_notifications where recipient = $1${unreadOnly ? ' and read = false' : ''} order by id`,
					parameters: [recipient]
				});
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
