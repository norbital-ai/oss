import { Effect, Option, Schema } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import webPush from 'web-push';
import {
	WEB_PUSH_SUBSCRIPTION_GONE,
	type CommunicationRequest,
	type WireError
} from '@norbital-ai/bolt-protocol';

/** The VAPID identity a host sends pushes as; the public half is what browsers subscribe against. */
export type WebPushKeys = Readonly<{
	readonly publicKey: string;
	readonly privateKey: string;
	/** `mailto:` or `https:` — the push service's way to reach whoever runs this host. */
	readonly subject: string;
}>;

/** `web-push` rejects with a `WebPushError` carrying the push service's status; anything else has none. */
const pushServiceStatus = Schema.decodeUnknownOption(Schema.Struct({ statusCode: Schema.Number }));

/**
 * Sends one `inbox` transport push. Every host that offers pushes calls this from its
 * communication facility, so the failure vocabulary is the same on each: a dead endpoint is
 * `WEB_PUSH_SUBSCRIPTION_GONE` and not retryable; the push service being down is retryable.
 */
export const sendWebPush = (
	keys: WebPushKeys,
	push: Extract<CommunicationRequest, { readonly _tag: 'Push' }>
): Effect.Effect<void, WireError> => {
	const { subscription, title, body, url } = push;
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
