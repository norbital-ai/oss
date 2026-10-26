import { createHmac } from 'node:crypto';
import { Clock, Effect, Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type {
	DeliveryReport,
	DriverOpen,
	Json,
	OutboundAttachment
} from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { ProviderUnavailable, answerFailure } from '../errors.ts';
import {
	field,
	hostCall,
	linkOf,
	same,
	str,
	storedCredential,
	withFetch,
	type Obj
} from '../util.ts';
import { twilio } from './messages.ts';

const API = 'https://api.twilio.com/2010-04-01';
const MEDIA_MAX = 16 * 1024 * 1024;
const STATUS: { readonly [s: string]: DeliveryReport['kind'] } = {
	sent: 'sent',
	delivered: 'delivered',
	read: 'read',
	failed: 'failed',
	undelivered: 'bounced'
};
const TWIML = () => new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
const Credential = Schema.Struct({
	accountSid: Schema.NonEmptyString,
	authToken: Schema.NonEmptyString,
	from: Schema.NonEmptyString,
	account: Schema.String
});
const Account = Schema.Struct({ friendly_name: Schema.optionalKey(Schema.String) });
const Sent = Schema.Struct({ sid: Schema.NonEmptyString });
const Message = Schema.Struct({ to: Schema.NonEmptyString, text: Schema.String });
const Webhook = Schema.Record(Schema.String, Schema.String);
type Cred = typeof Credential.Type;

export function twilioWhatsapp(): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'whatsapp',
		id: 'twilio',
		label: { en: 'Official (Twilio)', zh: '官方（Twilio）' },
		setup: {
			kind: 'form',
			webhook: true,
			steps: [
				{
					text: {
						en: 'In the Twilio Console, register a WhatsApp sender for this account (Messaging → Senders → WhatsApp senders), or use the sandbox to try it.',
						zh: '在 Twilio 控制台为此渠道注册 WhatsApp 发送方（Messaging → Senders → WhatsApp senders），或先用沙盒试用。'
					},
					href: 'https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders'
				},
				{
					text: {
						en: 'On the sender, set "Webhook URL for incoming messages" to this URL (HTTP POST).',
						zh: '在该发送方上，将 “Webhook URL for incoming messages” 设为此 URL（HTTP POST）。'
					},
					copy: 'webhookUrl'
				},
				{
					text: {
						en: "Paste this account's SID and auth token and the sender's number below. They are this integration's own, sealed for it alone.",
						zh: '在下方粘贴此账号的 SID、Auth Token 和发送方号码。它们仅属于此集成，并为其单独加密保存。'
					}
				}
			],
			fields: [
				{ name: 'accountSid', label: { en: 'Account SID', zh: '账号 SID' }, hint: 'AC…' },
				{ name: 'authToken', label: { en: 'Auth token', zh: 'Auth Token' }, secret: true },
				{
					name: 'from',
					label: { en: 'WhatsApp sender number', zh: 'WhatsApp 发送方号码' },
					hint: { en: '+ and the digits, country code first', zh: '+ 加数字，国家代码在前' }
				}
			]
		},
		test: {
			to: {
				name: 'to',
				label: { en: 'Send to', zh: '发送至' },
				hint: { en: 'A WhatsApp number, + and the digits', zh: 'WhatsApp 号码，+ 加数字' }
			}
		},
		open: Effect.fn('TwilioWhatsApp.open')(function* (ctx: DriverOpen) {
			let cred: Cred | null = Option.getOrNull(yield* storedCredential(ctx, Credential));
			const connected = (value: Cred) =>
				hostCall('report WhatsApp status', () =>
					ctx.status({
						state: 'connected',
						account: value.from,
						about: { from: value.from, account: value.account }
					})
				);
			if (cred !== null) yield* connected(cred);
			return {
				pair: Effect.fn('TwilioWhatsApp.pair')(function* (input: Json) {
					const accountSid = yield* field(
						input,
						'accountSid',
						'The account SID',
						/^AC[0-9a-f]{32}$/i
					);
					const authToken = yield* field(input, 'authToken', 'The auth token', /^[0-9a-f]{32}$/i);
					const from = (yield* field(
						input,
						'from',
						'The sender number',
						/^\+?[1-9]\d{7,14}$/
					)).replace(/^\+?/, '+');
					const account = yield* withFetch(
						ctx,
						twilio({ accountSid, authToken }, Account, `${API}/Accounts/${accountSid}.json`)
					);
					const next = {
						accountSid,
						authToken,
						from,
						account: account.friendly_name ?? accountSid
					};
					yield* hostCall('store WhatsApp credential', () =>
						ctx.credentials.write(new Map([['credential', next]]))
					);
					cred = next;
					yield* connected(next);
				}),
				unpair: () =>
					Effect.sync(() => {
						cred = null;
					}),
				close: Effect.void,
				send: Effect.fn('TwilioWhatsApp.send')(function* (
					message: Json,
					files: readonly OutboundAttachment[] = []
				) {
					if (cred === null)
						return yield* Effect.fail(
							new ProviderUnavailable({ message: 'the WhatsApp (Twilio) account is not connected' })
						);
					const value = cred;
					const m = yield* Schema.decodeUnknownEffect(Message)(message).pipe(
						Effect.mapError(() => answerFailure('a WhatsApp message needs `to` and `text`', 400))
					);
					const to = m.to.startsWith('whatsapp:') ? m.to : `whatsapp:+${m.to.replace(/\D/g, '')}`;
					const links = yield* Effect.forEach(files, (file) => linkOf(file), {
						concurrency: 'unbounded'
					});
					const post = (body: { Body: string } | { MediaUrl: string }) =>
						withFetch(
							ctx,
							twilio(value, Sent, `${API}/Accounts/${value.accountSid}/Messages.json`, {
								From: `whatsapp:${value.from}`,
								To: to,
								...body,
								StatusCallback: ctx.webhookUrl
							})
						);
					const sent = yield* post({ Body: m.text });
					for (const MediaUrl of links) yield* post({ MediaUrl });
					return { providerId: sent.sid };
				}),
				webhook: Effect.fn('TwilioWhatsApp.webhook')(function* (request: Request) {
					if (cred === null) return new Response(null, { status: 404 });
					const value = cred;
					const body = yield* hostCall('read Twilio callback', () => request.text());
					const params = yield* Schema.decodeUnknownEffect(Webhook)(
						Object.fromEntries(new URLSearchParams(body))
					).pipe(Effect.mapError(() => answerFailure('Twilio callback is malformed', 400)));
					const url = ctx.webhookUrl + new URL(request.url).search;
					if (
						!same(
							request.headers.get('x-twilio-signature') ?? '',
							twilioSignature(value.authToken, url, params)
						)
					)
						return new Response(null, { status: 403 });
					const now = yield* Clock.currentTimeMillis,
						status = params['MessageStatus'];
					if (status !== undefined && params['Body'] === undefined) {
						const kind = STATUS[status],
							providerId = params['MessageSid'];
						if (kind !== undefined && providerId !== undefined)
							yield* hostCall('store Twilio report', () =>
								ctx.emit({ kind: 'delivery', providerId, report: twilioReport(kind, params, now) })
							);
						return TWIML();
					}
					const message = twilioInbound(params, now);
					if (message === null) return TWIML();
					const bins: Uint8Array[] = [],
						attachments: Json[] = [];
					for (let i = 0; i < Number(params['NumMedia'] ?? 0); i++) {
						const url = params[`MediaUrl${i}`],
							mime = params[`MediaContentType${i}`] ?? 'application/octet-stream';
						if (url === undefined) continue;
						yield* withFetch(
							ctx,
							Effect.gen(function* () {
								const response = yield* HttpClient.execute(
									HttpClientRequest.get(url, {
										headers: {
											authorization: `Basic ${Buffer.from(`${value.accountSid}:${value.authToken}`).toString('base64')}`
										}
									})
								).pipe(
									Effect.mapError(
										() => new ProviderUnavailable({ message: 'Twilio media request failed' })
									)
								);
								const bytes = new Uint8Array(
									yield* response.arrayBuffer.pipe(
										Effect.mapError(
											() => new ProviderUnavailable({ message: 'Twilio media read failed' })
										)
									)
								);
								if (response.status >= 400 || bytes.byteLength > MEDIA_MAX) return;
								attachments.push({
									name: `whatsapp-${i}.${mime.split('/')[1] ?? 'bin'}`,
									mime,
									bytes: bytes.byteLength,
									bin: bins.length
								});
								bins.push(bytes);
							})
						).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
					}
					yield* hostCall('store Twilio inbound', () =>
						ctx.emit({
							kind: 'messages',
							messages: [{ ...message, attachments }],
							...(bins.length === 0 ? {} : { bins })
						})
					);
					return TWIML();
				})
			};
		})
	};
}

/** A status callback → the report: Twilio's `ErrorCode` (e.g. 63016, outside the 24-hour window) and message as code and reason. */
function twilioReport(
	kind: DeliveryReport['kind'],
	p: { readonly [k: string]: string },
	now: number
): DeliveryReport {
	const code = str(p['ErrorCode']);
	return {
		kind,
		at: new Date(now).toISOString(),
		provider: 'twilio',
		raw: p,
		...(code === null
			? {}
			: { code, reason: str(p['ErrorMessage']) ?? `Twilio error ${code}`, permanent: true })
	};
}

/** `X-Twilio-Signature`: base64 HMAC-SHA1 under the auth token over the URL and each form parameter's name and value, sorted by name. */
export const twilioSignature = (
	authToken: string,
	url: string,
	params: { readonly [k: string]: string }
): string =>
	createHmac('sha1', authToken)
		.update(
			url +
				Object.keys(params)
					.sort()
					.map((k) => k + params[k])
					.join('')
		)
		.digest('base64');

/** One incoming-message webhook's form → the wire message, or `null` without a sender or a message id. */
function twilioInbound(p: { readonly [k: string]: string }, now: number): Obj | null {
	const from = str(p['From']),
		id = str(p['MessageSid']);
	if (from === null || id === null) return null;
	return {
		id,
		thread: from,
		sentAt: new Date(now).toISOString(),
		from: { handle: from, name: str(p['ProfileName']) },
		text: p['Body'] ?? '',
		group: false,
		invocation: 'direct',
		replyTo: str(p['OriginalRepliedMessageSid'])
	};
}
