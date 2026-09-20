import { Effect, Option, Schema } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import webPush from 'web-push';
import {
	WEB_PUSH_SUBSCRIPTION_GONE,
	WebPushPayload,
	type WireError
} from '@norbital-ai/bolt-protocol';

/** The VAPID identity a host sends pushes as; the public half is what browsers subscribe against. */
export type WebPushKeys = Readonly<{
	readonly publicKey: string;
	readonly privateKey: string;
	/** `mailto:` or `https:` — the push service's way to reach whoever runs this host. */
	readonly subject: string;
}>;

const decodePayload = Schema.decodeUnknownResult(WebPushPayload);
/** `web-push` rejects with a `WebPushError` carrying the push service's status; anything else has none. */
const pushServiceStatus = Schema.decodeUnknownOption(Schema.Struct({ statusCode: Schema.Number }));

/**
 * Sends one `webpush` channel payload. Every host that offers pushes calls this from its
 * communication facility, so the wire shape and the failure vocabulary are the same on each: a
 * dead endpoint is `WEB_PUSH_SUBSCRIPTION_GONE` and not retryable; the push service being down
 * is retryable; a malformed payload is the workspace's fault and neither.
 */
export const sendWebPush = (
	keys: WebPushKeys,
	payload: unknown
): Effect.Effect<void, WireError> => {
	const decoded = decodePayload(payload);
	if (decoded._tag === 'Failure')
		return Effect.fail({
			code: 'communication_payload_unrenderable',
			message: 'Send on webpush carried no push payload: expected { subscription, title, body }',
			retryable: false,
			outcome: 'known'
		});
	const { subscription, title, body, url } = decoded.success;
	return Effect.tryPromise({
		try: () =>
			webPush.sendNotification(subscription, JSON.stringify({ title, body, url }), {
				vapidDetails: keys,
				TTL: 60 * 60 * 24
			}),
		catch: (cause): WireError => {
			const status = Option.getOrUndefined(
				Option.map(pushServiceStatus(cause), ({ statusCode }) => statusCode)
			);
			const message = getErrorMessage(cause);
			if (status === 404 || status === 410)
				return {
					code: WEB_PUSH_SUBSCRIPTION_GONE,
					message: `push service no longer knows this browser (${status})`,
					retryable: false,
					outcome: 'known'
				};
			return {
				code: 'communication_send_rejected',
				message: `push service ${status === undefined ? 'unreachable' : `answered ${status}`}: ${message}`,
				retryable: status === undefined || status === 429 || status >= 500,
				outcome: status === undefined ? 'unknown' : 'known'
			};
		}
	}).pipe(Effect.asVoid);
};
