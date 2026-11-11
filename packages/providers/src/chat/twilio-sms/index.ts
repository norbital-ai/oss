// SMS and MMS through Twilio. A delivery carries no time of its own, so `sentAt` is its arrival. A thread is the other
// party's number, and only their messages come back: what the account sent is not an inbound message.
import { Schema } from 'effect';
import { json, request as requestHttp } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { twilioSignature } from '../../twilio/whatsapp.ts';
import { signed } from '../verify.ts';

const API = 'https://api.twilio.com';
const LIMIT = 1600;
const PAGE = 100;
const TWIML = () => new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
const Resource = Schema.Struct({
	sid: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	date_sent: Schema.optionalKey(Schema.NullOr(Schema.String)),
	date_created: Schema.optionalKey(Schema.NullOr(Schema.String)),
	direction: Schema.optionalKey(Schema.String),
	from: Schema.optionalKey(Schema.NullOr(Schema.String))
});
type Resource = typeof Resource.Type;

const message = (
	id: string,
	from: string,
	text: string,
	sentAt: string,
	files: readonly IncomingFile[] = []
): Incoming => ({ id, thread: from, sentAt, from: { handle: from, name: null }, text, files });

export const twilioSms: ChatPlatform = {
	id: 'twilio-sms',
	name: { en: 'SMS (Twilio)', zh: '短信（Twilio）' },
	description: {
		en: 'SMS and MMS through a Twilio number',
		zh: '通过 Twilio 号码收发短信和彩信'
	},
	via: { en: 'Via Twilio', zh: '通过 Twilio' },
	consistency: 'history',
	icon: 'simple-icons:twilio',
	guide: 'https://www.twilio.com/docs/messaging/guides/webhook-request',
	fields: [
		{ name: 'accountSid', label: { en: 'Account SID', zh: '账号 SID' } },
		{ name: 'authToken', label: { en: 'Auth token', zh: 'Auth Token' }, secret: true },
		{ name: 'phoneNumber', label: { en: 'Twilio number', zh: 'Twilio 号码' }, optional: true },
		{
			name: 'messagingServiceSid',
			label: { en: 'Messaging Service SID', zh: 'Messaging Service SID' },
			optional: true
		}
	],
	async connect(
		{ accountSid = '', authToken = '', phoneNumber = '', messagingServiceSid = '' },
		host
	) {
		const sender = messagingServiceSid || phoneNumber;
		if (sender === '') throw new PlatformError('name a Twilio number or Messaging Service', 400);
		const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
			account = `${API}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
		const call = async (url: string, form?: URLSearchParams) => {
			return requestHttp(host.fetch, url, {
				method: form === undefined ? 'GET' : 'POST',
				headers: { authorization },
				...(form === undefined ? {} : { body: form })
			});
		};
		await call(`${account}.json`);
		const media = async (url: string) => {
			// the signed payload names this URL, but the account's credentials go only to Twilio
			if (new URL(url).origin !== API) throw new PlatformError('media is not on Twilio', 400);
			return new Uint8Array(await (await call(url)).arrayBuffer());
		};
		const connection: ChatConnection = {
			account: phoneNumber || messagingServiceSid,
			async deliver(request, body) {
				const params = new URLSearchParams(body);
				signed(
					request.headers.get('x-twilio-signature'),
					twilioSignature(
						authToken,
						host.webhookUrl + new URL(request.url).search,
						Object.fromEntries(params)
					)
				);
				const id = params.get('MessageSid') ?? params.get('SmsMessageSid'),
					from = params.get('From'),
					text = params.get('Body') ?? '',
					count = Number(params.get('NumMedia') ?? 0);
				// a status callback carries neither a body nor media
				if (id === null || from === null || (text === '' && count === 0)) return nothing(TWIML());
				const files = Array.from({ length: count }, (_, index): IncomingFile | null => {
					const url = params.get(`MediaUrl${index}`);
					return url === null
						? null
						: {
								name: `twilio-${id}-${index}`,
								mime: params.get(`MediaContentType${index}`) ?? 'application/octet-stream',
								fetch: () => media(url)
							};
				}).filter((file) => file !== null);
				return {
					messages: [message(id, from, text, new Date().toISOString(), files)],
					response: TWIML()
				};
			},
			async send(thread, text, _key, files) {
				const form = new URLSearchParams({ To: thread, Body: text.slice(0, LIMIT) });
				if (messagingServiceSid !== '') form.set('MessagingServiceSid', messagingServiceSid);
				else form.set('From', phoneNumber);
				for (const file of files)
					form.append(
						'MediaUrl',
						await file.url(86_400).catch(() => {
							throw new PlatformError(`${file.name}: this host serves no file link`, 400);
						})
					);
				const sent = await json(Resource, await call(`${account}/Messages.json`, form));
				return { id: sent.sid };
			},
			async history(thread, since) {
				const query = new URLSearchParams({ From: thread, PageSize: String(PAGE) });
				if (phoneNumber !== '') query.set('To', phoneNumber);
				const { messages = [] } = await json(
					Schema.Struct({
						messages: Schema.optionalKey(Schema.Array(Resource))
					}),
					await call(`${account}/Messages.json?${query}`)
				);
				const from = Date.parse(since),
					at = (row: Resource) => Date.parse(row.date_sent ?? row.date_created ?? '');
				return {
					messages: messages
						.filter((row) => row.direction === 'inbound' && at(row) >= from)
						.map((row) =>
							message(row.sid, thread, row.body ?? '', new Date(at(row)).toISOString())
						),
					// one page, newest first: it holds the window once it is short or reaches past it
					complete: messages.length < PAGE || messages.some((row) => at(row) < from)
				};
			}
		};
		return connection;
	}
};
