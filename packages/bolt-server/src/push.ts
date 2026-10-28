import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import webpush from 'web-push';
import { Clock, Effect, Option, Schema } from 'effect';
import { Port, Transport } from '@norbital-ai/bolt/engine';
import type { PushMessage, Rows, Sql } from '@norbital-ai/bolt/engine';
import type { HostSettings } from './host.ts';
type Db<E> = { readonly write: (statement: Sql) => Effect.Effect<Rows, E> };
const Subscription = Schema.Struct({
	endpoint: Schema.String,
	keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String })
});
const Status = Schema.Struct({ statusCode: Schema.Number });
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
	vapid: { publicKey: string; privateKey: string },
	subject: string,
	send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush)
): Transport['Service'] {
	const vapidDetails = { subject, ...vapid };
	return {
		send: Effect.fn('server.push')(function* (message) {
			if (message._tag !== 'Push')
				return yield* Port.unavailable('push', 'This transport sends inbox notices.');
			const subscription = yield* Schema.decodeUnknownEffect(Subscription)(
				message.subscription
			).pipe(Effect.mapError(Port.failure('push')));
			const result = yield* Effect.tryPromise({
				try: () =>
					send(
						subscription,
						JSON.stringify({ title: message.title, body: message.body, path: message.path }),
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
						return yield* Effect.fail(Port.failure('push')(failure.cause));
					})
				)
			);
			return { providerId: result.headers['location'] ?? `push:${result.statusCode}` };
		})
	};
}

const ApnsSubscription = Schema.Struct({
	endpoint: Schema.String,
	keys: Schema.Struct({
		topic: Schema.String,
		environment: Schema.Literals(['development', 'production']),
		teamId: Schema.String
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
): Transport['Service'] {
	const tokens = new Map<string, { readonly token: string; readonly at: number }>();
	const token = Effect.fn('server.apns.token')(function* (teamId: string) {
		const team = keys[teamId];
		if (team === undefined)
			return yield* Port.unavailable('push', `no APNs key is configured for team ${teamId}`);
		const now = yield* Clock.currentTimeMillis;
		const cached = tokens.get(teamId);
		if (cached !== undefined && now - cached.at < TOKEN_MS) return cached.token;
		const header = base64url(JSON.stringify({ alg: 'ES256', kid: team.keyId })),
			claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
		const unsigned = `${header}.${claims}`;
		const signature = yield* Effect.try({
			try: () =>
				sign('sha256', Buffer.from(unsigned), {
					key: createPrivateKey(team.key),
					dsaEncoding: 'ieee-p1363'
				}),
			catch: Port.failure('push')
		});
		const signed = `${unsigned}.${base64url(signature)}`;
		tokens.set(teamId, { token: signed, at: now });
		return signed;
	});
	return {
		send: Effect.fn('server.apns')(function* (message) {
			if (message._tag !== 'Push')
				return yield* Port.unavailable('push', 'This transport sends inbox notices.');
			const device = yield* Schema.decodeUnknownEffect(ApnsSubscription)(message.subscription).pipe(
				Effect.mapError(Port.failure('push'))
			);
			const origin =
				device.keys.environment === 'production'
					? 'https://api.push.apple.com'
					: 'https://api.sandbox.push.apple.com';
			const answer = yield* request(
				origin,
				{
					':path': `/3/device/${device.endpoint}`,
					authorization: `bearer ${yield* token(device.keys.teamId)}`,
					'apns-topic': device.keys.topic,
					'apns-push-type': 'alert'
				},
				JSON.stringify(apnsPayload(message))
			).pipe(Effect.mapError((failure) => Port.failure('push')(failure.cause)));
			if (answer.status === 200) return { providerId: `apns:${answer.status}` };
			const reason = Schema.decodeUnknownOption(ApnsReason)(answer.body).pipe(
				Option.map((x) => x.reason),
				Option.getOrElse(() => `status ${answer.status}`)
			);
			if (answer.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered')
				yield* forget(db, device.endpoint);
			return yield* Effect.fail(
				Port.failure('push')(new Error(`APNs refused the notice: ${reason}`))
			);
		})
	};
}
/** The alert APNs shows, and the workspace path the app opens when it is tapped. */
const apnsPayload = (message: PushMessage) => ({
	aps: {
		alert: { title: message.title, ...(message.body === null ? {} : { body: message.body }) },
		sound: 'default'
	},
	path: message.path
});
