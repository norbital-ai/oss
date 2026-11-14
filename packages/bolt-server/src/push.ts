import { connect } from 'node:http2';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import webpush from 'web-push';
import { Clock, Effect, Option, Schema } from 'effect';
import { Port, type PortFailure, type Rows, type Sql } from '@norbital-ai/host-api';
import type { Json } from 'effect/Schema';
import type { HostSettings } from './host.ts';

/** An inbox notice for one device subscription; `id` is the notice's, kept when an uncertain delivery is retried. */
export type PushMessage = {
	readonly _tag: 'Push';
	readonly id: string;
	readonly subscription: {
		readonly kind: 'web' | 'apns';
		readonly endpoint: string;
		readonly keys: Json;
	};
	readonly title: string;
	readonly body: string | null;
	readonly link: { readonly model: string; readonly id: string } | null;
	readonly path: string;
};
/** One push transport: a notice sent, or the facility's failure. */
export type PushSender = {
	readonly send: (message: PushMessage) => Effect.Effect<{ readonly provider_id: string }, PortFailure>;
};
type Db<E> = { readonly write: (statement: Sql) => Effect.Effect<Rows, E> };
const Subscription = Schema.Struct({
	endpoint: Schema.String,
	keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String })
});
const Status = Schema.Struct({ statusCode: Schema.Number });
const refused = (message: string, status?: number) =>
	Port.failure('push')({
		kind: status === 408 ? 'timeout' : status === 429 ? 'rate_limited' : status === undefined || status >= 500 ? 'upstream' : 'invalid',
		message,
		...(status === undefined ? {} : { status })
	});
class PushFailure extends Schema.TaggedError<PushFailure>()('PushFailure', {
	cause: Schema.Defect(),
	status: Schema.optionalKey(Schema.Number)
}) {}
const forget = <E>(db: Db<E>, endpoint: string) =>
	db
		.write({ text: 'DELETE FROM bolt_push_subscriptions WHERE endpoint = $1', params: [endpoint] })
		.pipe(Effect.mapError(Port.failure('push')));
export function push<E>(
	db: Db<E>,
	vapid: { public_key: string; private_key: string },
	subject: string,
	send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush)
): PushSender {
	const vapidDetails = { subject, publicKey: vapid.public_key, privateKey: vapid.private_key };
	return {
		send: Effect.fn('server.push')(function* (message) {
			const subscription = yield* Schema.decodeUnknownEffect(Subscription)(
				message.subscription
			).pipe(Effect.mapError(() => refused('The web push subscription is invalid.', 400)));
			const result = yield* Effect.tryPromise({
				try: () =>
					send(
						subscription,
						JSON.stringify({ id: message.id, title: message.title, body: message.body, path: message.path }),
						{ vapidDetails, TTL: 86_400 }
					),
				catch: (cause) => {
					const status = Schema.decodeUnknownOption(Status)(cause);
					return new PushFailure({
						cause,
						...(Option.isNone(status) ? {} : { status: status.value.statusCode })
					});
				}
			}).pipe(
				Effect.catchTag('PushFailure', (failure) =>
					Effect.gen(function* () {
						if (failure.status === 404 || failure.status === 410)
							yield* forget(db, subscription.endpoint);
						return yield* Effect.fail(refused(Port.failure('push')(failure.cause).message, failure.status));
					})
				)
			);
			return { provider_id: result.headers['location'] ?? `push:${result.statusCode}` };
		})
	};
}

const ApnsSubscription = Schema.Struct({
	endpoint: Schema.String,
	keys: Schema.Struct({
		topic: Schema.String,
		environment: Schema.Literals(['development', 'production']),
		team_id: Schema.String
	})
});
const ApnsReason = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }));
class ApnsFailure extends Schema.TaggedError<ApnsFailure>()('ApnsFailure', {
	cause: Schema.Defect()
}) {}
/** One HTTP/2 POST to APNs: its `:status` and body. */
export type ApnsRequest = (
	origin: string,
	headers: { readonly [name: string]: string },
	body: string
) => Effect.Effect<{ readonly status: number; readonly body: string }, ApnsFailure>;
/** A connection per notice. ponytail: one session per send; pool sessions per origin if notice volume grows. */
const http2Request: ApnsRequest = (origin, headers, body) =>
	Effect.callback<{ readonly status: number; readonly body: string }, ApnsFailure>((resume) => {
		const session = connect(origin);
		const fail = (cause: unknown) => {
			session.destroy();
			resume(Effect.fail(new ApnsFailure({ cause })));
		};
		session.on('error', fail);
		const request = session.request({ ':method': 'POST', ...headers });
		let status = 0,
			text = '';
		request.setEncoding('utf8');
		request.on('response', (response) => {
			status = Number(response[':status']);
		});
		request.on('data', (chunk: string) => {
			text += chunk;
		});
		request.on('end', () => {
			session.close();
			resume(Effect.succeed({ status, body: text }));
		});
		request.on('error', fail);
		request.end(body);
		return Effect.sync(() => session.destroy());
	});
const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
/** Apple accepts a provider token for an hour; it is refreshed after 50 minutes. */
const TOKEN_MS = 50 * 60_000;
/**
 * Inbox notices to iOS devices over APNs (HTTP/2, an ES256 provider token per team signed with its `.p8` key). A
 * device APNs reports gone (410, `BadDeviceToken`, `Unregistered`) is deleted; a team without a key is unavailable.
 */
export function apns<E>(
	db: Db<E>,
	keys: HostSettings['apns'],
	request: ApnsRequest = http2Request
): PushSender {
	const tokens = new Map<string, { readonly token: string; readonly at: number }>();
	const token = Effect.fn('server.apns.token')(function* (teamId: string) {
		const team = keys[teamId];
		if (team === undefined)
			return yield* Port.unavailable('push', `no APNs key is configured for team ${teamId}`);
		const now = yield* Clock.currentTimeMillis;
		const cached = tokens.get(teamId);
		if (cached !== undefined && now - cached.at < TOKEN_MS) return cached.token;
		const header = base64url(JSON.stringify({ alg: 'ES256', kid: team.key_id })),
			claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
		const unsigned = `${header}.${claims}`;
		const signature = yield* Effect.try({
			try: () =>
				sign('sha256', Buffer.from(unsigned), {
					key: createPrivateKey(team.key),
					dsaEncoding: 'ieee-p1363'
				}),
			catch: (cause) => refused(`The APNs signing key is invalid: ${Port.failure('push')(cause).message}`, 400)
		});
		const signed = `${unsigned}.${base64url(signature)}`;
		tokens.set(teamId, { token: signed, at: now });
		return signed;
	});
	return {
		send: Effect.fn('server.apns')(function* (message) {
			const device = yield* Schema.decodeUnknownEffect(ApnsSubscription)(message.subscription).pipe(
				Effect.mapError(() => refused('The APNs subscription is invalid.', 400))
			);
			const origin =
				device.keys.environment === 'production'
					? 'https://api.push.apple.com'
					: 'https://api.sandbox.push.apple.com';
			const answer = yield* request(
				origin,
				{
					':path': `/3/device/${device.endpoint}`,
					authorization: `bearer ${yield* token(device.keys.team_id)}`,
					'apns-topic': device.keys.topic,
					'apns-push-type': 'alert',
					'apns-collapse-id': createHash('sha256').update(message.id).digest('hex')
				},
				JSON.stringify(apnsPayload(message))
			).pipe(Effect.mapError((failure) => refused(Port.failure('push')(failure.cause).message)));
			if (answer.status === 200) return { provider_id: `apns:${answer.status}` };
			const reason = Schema.decodeUnknownOption(ApnsReason)(answer.body).pipe(
				Option.map((x) => x.reason),
				Option.getOrElse(() => `status ${answer.status}`)
			);
			if (answer.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered')
				yield* forget(db, device.endpoint);
			return yield* Effect.fail(
				refused(`APNs refused the notice: ${reason}`, answer.status)
			);
		})
	};
}
/** The alert APNs shows, and the workspace path the app opens when it is tapped. */
const apnsPayload = (message: PushMessage) => ({
	id: message.id,
	aps: {
		alert: { title: message.title, ...(message.body === null ? {} : { body: message.body }) },
		sound: 'default'
	},
	path: message.path
});
