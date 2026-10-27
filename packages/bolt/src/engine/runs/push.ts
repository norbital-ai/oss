import { Crypto, Effect, Schema } from 'effect';
import { TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { Transport } from '../ports.ts';
import { Port } from '../port.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { PushBody } from '../../protocol/schema.ts';
import { noticePath } from '../../protocol/wire.ts';
import { prepareNoticeFiles } from '../notifications/notify.ts';
import type { RunHandler } from '../services.ts';

export const NOTICE_PUSH = 'bolt.push';
/** Stores (or, with `remove`, forgets) one device of `user`'s; an endpoint belongs to one member at a time. */
export const subscribe = (user: string, body: PushBody) =>
	Effect.gen(function* () {
		const db = yield* TenantDb;
		if ('remove' in body)
			return yield* db.write({
				text: `DELETE FROM bolt_push_subscriptions WHERE "user" = $1 AND endpoint = $2`,
				params: [user, body.endpoint]
			});
		const id = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		);
		return yield* db.write({
			text: `WITH gone AS (DELETE FROM bolt_push_subscriptions WHERE endpoint = $3) INSERT INTO bolt_push_subscriptions (id, "user", endpoint, keys, kind) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			params: [id, user, body.endpoint, JSON.stringify(body.keys), body.kind ?? 'web']
		});
	});
const Input = Schema.Struct({ ids: Schema.Array(Schema.String) });
const Notice = Schema.Struct({
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	kind: Schema.Literals(['web', 'apns']),
	endpoint: Schema.String,
	keys: Schema.Json
});
export const noticePush = Effect.gen(function* () {
	const db = yield* TenantDb,
		transport = yield* Transport,
		context = yield* Effect.context<Effect.Services<ReturnType<typeof prepareNoticeFiles>>>();
	const run: RunHandler = (input) =>
		Effect.gen(function* () {
			const body = yield* Schema.decodeUnknownEffect(Input)(input).pipe(
				Effect.mapError(() =>
					BoltError.make('invalidInput', 'decode', 'a push run needs notice ids')
				)
			);
			if (body.ids.length === 0) return { sent: 0, failed: 0 };
			yield* prepareNoticeFiles(body.ids).pipe(Effect.provideContext(context));
			const rows = yield* db.rows(Notice, {
				text: `SELECT n.title, n.body, n.link, s.kind, s.endpoint, s.keys FROM sys_notification n JOIN bolt_push_subscriptions s ON s."user" = n.member JOIN sys_user u ON u.id = n.member AND u.active WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY s."user"`,
				params: [JSON.stringify(body.ids)]
			});
			let sent = 0,
				failed = 0;
			for (const row of rows) {
				const result = yield* transport
					.send({
						_tag: 'Push',
						subscription: { kind: row.kind, endpoint: row.endpoint, keys: row.keys },
						title: row.title,
						body: row.body,
						link: row.link,
						path: noticePath(row.link)
					})
					.pipe(Port.call('push', LIMITS.callMs.http), Effect.result);
				if (result._tag === 'Success') sent++;
				else failed++;
			}
			return { sent, failed };
		});
	return run;
});
