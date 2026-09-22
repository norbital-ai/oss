import { Clock, Effect, Schema } from 'effect';
import { EffectId, NotificationRecipient } from '@norbital-ai/bolt-protocol';
import type { AutomationApi } from '#lib/authoring/automations-schema.js';
import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type * as TaskQueue from '#lib/runtime/tasks/tasks.js';

/**
 * The statement an automation reminder writes. The key's meaning is the authoring contract's
 * (`AutomationApi['notify']`); this is how the rows land.
 *
 * The rows are the same rows a collection-declared notice writes, in the same shape: one per
 * recipient, the id derived from the key so a retry re-joins its own row, and `{ team }` resolved
 * to that team's members inside the insert. The delivery task rides the same transaction, and the
 * host is woken *before* the write commits, the same order `deliverNotificationsRow` is announced
 * in: a crash between the two costs a false alarm, while a committed delivery nobody comes back for
 * costs the message.
 */
const AutomationReminder = Schema.Struct({
	key: Schema.NonEmptyString,
	recipients: Schema.Array(NotificationRecipient).check(Schema.isMinLength(1)),
	title: Schema.NonEmptyString,
	body: Schema.String
});

export const sendReminder = Effect.fn('Notifications.sendReminder')(function* (
	effectId: EffectId,
	database: Database.Interface,
	tasks: TaskQueue.Interface,
	reminder: Parameters<AutomationApi['notify']>[0]
) {
	const decoded = yield* Schema.decodeUnknownEffect(AutomationReminder)(reminder);
	const payload = JSON.stringify({
		channel: 'inbox',
		title: decoded.title,
		body: decoded.body
	});
	yield* tasks.wake(EffectId.make(`${effectId}:notify:wake`), yield* Clock.currentTimeMillis);
	const statements = decoded.recipients.map((recipient) =>
		typeof recipient === 'string'
			? {
					sql: 'insert into bolt_notifications (id, recipient, payload, read) values ($1, $2, $3::jsonb, false) on conflict (id) do nothing',
					parameters: [deriveRecordId(`${decoded.key}:${recipient}`), recipient, payload]
				}
			: {
					sql: `insert into bolt_notifications (id, recipient, payload, read) select md5($1 || ':' || u.id::text)::uuid, u.id::text, $2::jsonb, false from "user" as u join "team" as t on t.id = u.team_id where lower(t.name) = lower($3) on conflict (id) do nothing`,
					parameters: [decoded.key, payload, recipient.team]
				}
	);
	statements.push({
		sql: `insert into bolt_task (command, input, effect_id, status) values ('notifications.deliver', '{}'::jsonb, $1, 'pending') on conflict (effect_id) do nothing`,
		parameters: [`${effectId}:notify:${deriveRecordId(decoded.key)}`]
	});
	yield* database.execute(effectId, { _tag: 'Transaction', statements });
});
