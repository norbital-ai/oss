import { Crypto, Effect, Schema } from 'effect';
import { TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { Transport } from '../ports.ts';
import { type FacilityFailure, Port } from '@norbital-ai/host-api';
import { uuid } from '../port.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { PushBody } from '../../protocol/schema.ts';
import { notice_path } from '../../protocol/wire.ts';
import { prepareNoticeFiles } from '../notifications/notify.ts';
import type { RunHandler } from '../services.ts';

/** Stores (or, with `remove`, forgets) one device of `user`'s; an endpoint belongs to one member at a time. */
export const subscribe = (user: string, body: PushBody) =>
	Effect.gen(function* () {
		const db = yield* TenantDb;
		if ('remove' in body)
			return yield* db.write({
				text: `DELETE FROM bolt_push_subscriptions WHERE "user" = $1 AND endpoint = $2`,
				params: [user, body.endpoint]
			});
		const id = yield* uuid(yield* Crypto.Crypto);
		return yield* db.write({
			text: `WITH gone AS (DELETE FROM bolt_push_subscriptions WHERE endpoint = $3) INSERT INTO bolt_push_subscriptions (id, "user", endpoint, keys, kind) VALUES ($1, $2, $3, $4::jsonb, $5)`,
			params: [id, user, body.endpoint, JSON.stringify(body.keys), body.kind ?? 'web']
		});
	});
const Input = Schema.Struct({ ids: Schema.Array(Schema.String) });
const Notice = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	link: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	kind: Schema.Literals(['web', 'apns']),
	endpoint: Schema.String,
	keys: Schema.Json
});
export const notice_push = Effect.gen(function* () {
	const db = yield* TenantDb,
		transport = yield* Transport,
		context = yield* Effect.context<Effect.Services<ReturnType<typeof prepareNoticeFiles>>>();
	const run: RunHandler = (input) =>
		Effect.gen(function* () {
			const body = yield* Schema.decodeUnknownEffect(Input)(input).pipe(
				Effect.mapError(() =>
					BoltError.make('invalid_input', 'decode', 'a push run needs notice ids')
				)
			);
			if (body.ids.length === 0) return { sent: 0, failed: 0 };
			yield* prepareNoticeFiles(body.ids).pipe(Effect.provideContext(context));
			const rows = yield* db.rows(Notice, {
				text: `SELECT n.id, n.title, n.body, n.link, s.kind, s.endpoint, s.keys FROM sys_notification n JOIN bolt_push_subscriptions s ON s."user" = n.member JOIN sys_user u ON u.id = n.member AND u.active WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY s."user"`,
				params: [JSON.stringify(body.ids)]
			});
			let sent = 0,
				failed = 0,
				transient = 0;
			let retry: FacilityFailure | undefined;
			for (const row of rows) {
				const result = yield* transport
					.send({
						_tag: 'Push',
						id: row.id,
						subscription: { kind: row.kind, endpoint: row.endpoint, keys: row.keys },
						title: row.title,
						body: row.body,
						link: row.link,
						path: notice_path(row.link)
					})
					.pipe(Port.call('push', LIMITS.callMs.http), Effect.result);
				if (result._tag === 'Success') sent++;
				else {
					failed++;
					const error = result.failure;
					if (error._tag === 'FacilityFailure' &&
						(error.kind === 'upstream' || error.kind === 'timeout' || error.kind === 'rate_limited')) {
						transient++;
						retry ??= error;
					}
					yield* Effect.logWarning('Inbox push delivery failed', {
						notice: row.id,
						kind: error._tag === 'Unavailable' ? 'unavailable' : error.kind,
						message: error.message,
						...(error._tag === 'FacilityFailure' && error.status !== undefined ? { status: error.status } : {})
					});
				}
			}
			// A retry can repeat accepted sends: the stable notice id lets devices replace/coalesce them.
			if (retry !== undefined) return yield* BoltError.make(retry.kind, 'facility',
				`Inbox push: ${sent} accepted, ${failed - transient} permanent failures, ${transient} transient failures.`,
				{ sent, failed, transient, failure: retry });
			return { sent, failed };
		});
	return run;
});
