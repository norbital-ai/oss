// WhatsApp Business Cloud, Meta's own API. Webhooks only: it offers no message history and no dedupe key on a send. Its
// typing indicator answers one inbound message, which would take a message id per thread, so it is left out.
import { download, parse as parseJson } from '../http.ts';
import { Schema } from 'effect';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { appFields, graph, pieces, verified } from '../meta.ts';

const API = 'https://graph.facebook.com/v25.0';
const LIMIT = 4096;
const MEDIA = ['image', 'document', 'audio', 'video', 'voice', 'sticker'] as const;
/** Where a media URL may point: the access token is sent to it. */
const MEDIA_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com)$|^graph\.facebook\.com$/;
/** A business-scoped user id, for someone who shares no phone number. */
const SCOPED_USER = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
const Media = Schema.Struct({
	id: Schema.String,
	mime_type: Schema.String,
	caption: Schema.optionalKey(Schema.String),
	filename: Schema.optionalKey(Schema.String)
});
type Media = typeof Media.Type;
const Inbound = Schema.Struct({
	image: Schema.optionalKey(Media),
	document: Schema.optionalKey(Media),
	audio: Schema.optionalKey(Media),
	video: Schema.optionalKey(Media),
	voice: Schema.optionalKey(Media),
	sticker: Schema.optionalKey(Media),
	id: Schema.String,
	timestamp: Schema.String,
	from: Schema.optionalKey(Schema.String),
	from_user_id: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.Struct({ body: Schema.String })),
	context: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) }))
});
type Inbound = typeof Inbound.Type;
const Contact = Schema.Struct({
	wa_id: Schema.optionalKey(Schema.String),
	user_id: Schema.optionalKey(Schema.String),
	profile: Schema.optionalKey(
		Schema.Struct({
			name: Schema.optionalKey(Schema.String)
		})
	)
});
type Contact = typeof Contact.Type;
const Hook = Schema.Struct({
	entry: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				changes: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							field: Schema.String,
							value: Schema.Struct({
								metadata: Schema.optionalKey(
									Schema.Struct({ phone_number_id: Schema.optionalKey(Schema.String) })
								),
								contacts: Schema.optionalKey(Schema.Array(Contact)),
								messages: Schema.optionalKey(Schema.Array(Inbound))
							})
						})
					)
				)
			})
		)
	)
});

const parse = (
	message: Inbound,
	contacts: readonly Contact[],
	content: (id: string) => Promise<Uint8Array>
): Incoming | null => {
	const user = message.from ?? message.from_user_id;
	const media = MEDIA.flatMap((kind) => {
		const one = message[kind];
		return one === undefined ? [] : [{ ...one, kind }];
	});
	const text = message.text?.body ?? media[0]?.caption ?? '';
	if (user === undefined || (text === '' && media.length === 0)) return null;
	const contact = contacts.find((one) => one.wa_id === user || one.user_id === user),
		reply_to = message.context?.id;
	return {
		id: message.id,
		thread: user,
		sent_at: new Date(Number(message.timestamp) * 1000).toISOString(),
		from: { handle: user, name: contact?.profile?.name ?? null },
		text,
		...(reply_to === undefined ? {} : { reply_to }),
		files: media.map((one) => ({
			name: one.filename ?? one.kind,
			mime: one.mime_type,
			fetch: () => content(one.id)
		}))
	};
};

export const whatsappCloud: ChatPlatform = {
	id: 'whatsapp-cloud',
	driver: 'whatsapp',
	name: { en: 'WhatsApp Business Cloud', zh: 'WhatsApp Business Cloud' },
	description: { en: "Meta's official WhatsApp API", zh: 'Meta 官方 WhatsApp API' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:whatsapp',
	guide: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
	fields: [
		{ name: 'accessToken', label: { en: 'Access token', zh: '访问令牌' }, secret: true },
		...appFields,
		{ name: 'phoneNumberId', label: { en: 'Phone number ID', zh: '电话号码 ID' } }
	],
	async connect({ accessToken = '', appSecret = '', verifyToken = '', phoneNumberId = '' }, host) {
		const auth = { authorization: `Bearer ${accessToken}` };
		const call = <A>(schema: Schema.Decoder<A>, path: string, body?: object) =>
			graph(schema, host.fetch, `${API}/${path}`, auth, body);
		await call(Schema.Json, `${phoneNumberId}/whatsapp_business_profile`);
		const content = async (id: string) => {
			const { url } = await call(
				Schema.Struct({
					url: Schema.String
				}),
				id
			);
			const target = new URL(url);
			if (target.protocol !== 'https:' || !MEDIA_HOST.test(target.hostname))
				throw new Error('a media URL off Meta’s hosts gets no token');
			return download(host.fetch, url, auth);
		};
		const connection: ChatConnection = {
			account: phoneNumberId,
			async deliver(request, body) {
				const handshake = verified(request, body, verifyToken, appSecret);
				if (handshake !== null) return handshake;
				const { entry = [] } = await parseJson(Hook, body);
				// one app can serve several numbers: another number's message is not this link's to answer
				const changes = entry
					.flatMap((one) => one.changes ?? [])
					.filter(
						({ field, value }) =>
							field === 'messages' && value.metadata?.phone_number_id === phoneNumberId
					);
				return {
					messages: changes.flatMap(({ value }) =>
						(value.messages ?? []).flatMap(
							(message) => parse(message, value.contacts ?? [], content) ?? []
						)
					)
				};
			},
			async send(thread, text) {
				let id: string | undefined;
				for (const piece of pieces(text, LIMIT)) {
					const sent = await call(
						Schema.Struct({
							messages: Schema.optionalKey(
								Schema.Array(
									Schema.Struct({
										id: Schema.String
									})
								)
							)
						}),
						`${phoneNumberId}/messages`,
						{
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...(SCOPED_USER.test(thread) ? { recipient: thread } : { to: thread }),
							type: 'text',
							text: { preview_url: false, body: piece }
						}
					);
					id = sent.messages?.[0]?.id;
				}
				if (id === undefined) throw new Error('WhatsApp answered no message id');
				return { id };
			}
		};
		return connection;
	}
};
