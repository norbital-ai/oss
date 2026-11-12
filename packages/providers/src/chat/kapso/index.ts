// WhatsApp through Kapso's REST proxy of the Cloud API, called directly: its client is not installed here. Every thread is
// the person's WhatsApp ID. Kapso's own webhooks only, not Meta's forwarded format. No dedupe key on a send, no edit or
// delete event, and typing needs the last inbound message of each thread, which an adapter may not hold.
import { Schema } from 'effect';
import { parse as parseJson, json, request as requestHttp } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const Media = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	mime_type: Schema.optionalKey(Schema.String),
	filename: Schema.optionalKey(Schema.String),
	caption: Schema.optionalKey(Schema.String)
});
type Media = typeof Media.Type;
const MediaData = Schema.Struct({
	content_type: Schema.optionalKey(Schema.String),
	contentType: Schema.optionalKey(Schema.String),
	filename: Schema.optionalKey(Schema.String),
	byte_size: Schema.optionalKey(Schema.Number),
	byteSize: Schema.optionalKey(Schema.Number)
});
type MediaData = typeof MediaData.Type;
const Named = Schema.Struct({
	contact_name: Schema.optionalKey(Schema.String),
	contactName: Schema.optionalKey(Schema.String)
});
type Named = typeof Named.Type;
const Raw = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	timestamp: Schema.String,
	from: Schema.optionalKey(Schema.String),
	context: Schema.optionalKey(
		Schema.Struct({
			id: Schema.optionalKey(Schema.String)
		})
	),
	text: Schema.optionalKey(
		Schema.Struct({
			body: Schema.optionalKey(Schema.String)
		})
	),
	image: Schema.optionalKey(Media),
	video: Schema.optionalKey(Media),
	audio: Schema.optionalKey(Media),
	document: Schema.optionalKey(Media),
	sticker: Schema.optionalKey(Media),
	location: Schema.optionalKey(
		Schema.Struct({
			name: Schema.optionalKey(Schema.String),
			address: Schema.optionalKey(Schema.String)
		})
	),
	interactive: Schema.optionalKey(
		Schema.Struct({
			button_reply: Schema.optionalKey(
				Schema.Struct({
					title: Schema.optionalKey(Schema.String)
				})
			),
			list_reply: Schema.optionalKey(
				Schema.Struct({
					title: Schema.optionalKey(Schema.String)
				})
			)
		})
	),
	kapso: Schema.optionalKey(
		Schema.Struct({
			...Named.fields,
			direction: Schema.optionalKey(Schema.String),
			content: Schema.optionalKey(Schema.Unknown),
			media_data: Schema.optionalKey(MediaData),
			mediaData: Schema.optionalKey(MediaData)
		})
	)
});
type Raw = typeof Raw.Type;
const Conversation = Schema.Struct({
	phone_number: Schema.optionalKey(Schema.String),
	phone_number_id: Schema.optionalKey(Schema.String),
	kapso: Schema.optionalKey(Named)
});
type Conversation = typeof Conversation.Type;
const Event = Schema.Struct({
	message: Schema.optionalKey(Raw),
	conversation: Schema.optionalKey(Conversation),
	phone_number_id: Schema.optionalKey(Schema.String)
});
type Event = typeof Event.Type;
const Page = Schema.Struct({
	data: Schema.Array(Raw),
	paging: Schema.optionalKey(
		Schema.Struct({
			cursors: Schema.optionalKey(
				Schema.Struct({
					after: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]))
				})
			)
		})
	)
});

const API = 'https://api.kapso.ai/meta/whatsapp/v23.0',
	RECEIVED = 'whatsapp.message.received',
	FIELDS = 'kapso(direction,media_data,contact_name)',
	PAGE = 100,
	HISTORY_PAGES = 20,
	KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const;

const textOf = (raw: Raw) =>
	raw.text?.body ??
	raw.image?.caption ??
	raw.video?.caption ??
	raw.document?.caption ??
	raw.interactive?.button_reply?.title ??
	raw.interactive?.list_reply?.title ??
	(raw.location === undefined
		? undefined
		: [raw.location.name, raw.location.address].filter(Boolean).join('\n')) ??
	(typeof raw.kapso?.content === 'string' ? raw.kapso.content : '');

const parse = (
	raw: Raw,
	conversation: Conversation | undefined,
	download: (id: string) => Promise<Uint8Array>
): Incoming | null => {
	const from = raw.from ?? conversation?.phone_number?.replace(/\D/g, '');
	if (from === undefined || raw.type === 'reaction' || raw.kapso?.direction === 'outbound')
		return null;
	const seconds = Number(raw.timestamp),
		data = raw.kapso?.media_data ?? raw.kapso?.mediaData,
		bytes = data?.byte_size ?? data?.byteSize;
	return {
		id: raw.id,
		thread: from,
		sent_at: new Date(Number.isFinite(seconds) ? seconds * 1000 : raw.timestamp).toISOString(),
		from: {
			handle: from,
			name:
				raw.kapso?.contact_name ??
				raw.kapso?.contactName ??
				conversation?.kapso?.contact_name ??
				conversation?.kapso?.contactName ??
				null
		},
		text: textOf(raw),
		reply_to: raw.context?.id ?? null,
		files: KINDS.flatMap((kind): IncomingFile[] => {
			const media = raw[kind],
				id = media?.id;
			if (id === undefined) return [];
			return [
				{
					name: media?.filename ?? data?.filename ?? `${kind}-${id}`,
					mime:
						media?.mime_type ??
						data?.content_type ??
						data?.contentType ??
						'application/octet-stream',
					...(bytes === undefined ? {} : { bytes }),
					fetch: () => download(id)
				}
			];
		})
	};
};

export const kapso: ChatPlatform = {
	id: 'kapso',
	driver: 'whatsapp',
	name: { en: 'WhatsApp (Kapso)', zh: 'WhatsApp（Kapso）' },
	description: { en: 'WhatsApp through Kapso', zh: '通过 Kapso 使用 WhatsApp' },
	via: { en: 'Via Kapso', zh: '通过 Kapso' },
	consistency: 'history',
	icon: 'simple-icons:whatsapp',
	guide: 'https://docs.kapso.ai',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'phoneNumberId', label: { en: 'Phone number ID', zh: '电话号码 ID' } },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', phoneNumberId = '', webhookSecret = '' }, host) {
		const call = async <A>(schema: Schema.Decoder<A>, path: string, init: RequestInit = {}) => {
			const response = await requestHttp(host.fetch, `${API}/${path}`, {
				...init,
				headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }
			});
			return json(schema, response);
		};
		await call(Schema.Json, `${phoneNumberId}/conversations?limit=1`);
		// the key goes only to Kapso's own host: the link can also be a CDN's
		const download = async (id: string) => {
			const { url, download_url: direct } = await call(
				Schema.Struct({
					url: Schema.String,
					download_url: Schema.optionalKey(Schema.String)
				}),
				`${id}?phone_number_id=${phoneNumberId}`
			);
			const target = direct ?? url;
			const response = await host.fetch(
				target,
				new URL(target).hostname.endsWith('kapso.ai') ? { headers: { 'x-api-key': apiKey } } : {}
			);
			if (!response.ok) throw new PlatformError('Kapso media', response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const connection: ChatConnection = {
			account: phoneNumberId,
			async deliver(request, body) {
				signed(
					request.headers.get('x-webhook-signature')?.replace(/^sha256=/, '') ?? null,
					hmac(webhookSecret, body, 'hex')
				);
				const name = request.headers.get('x-webhook-event');
				if (name !== null && name !== RECEIVED) return nothing();
				const payload = await parseJson(
					Schema.Struct({
						...Event.fields,
						data: Schema.optionalKey(Schema.Array(Event))
					}),
					body
				);
				// a project's webhook carries all its numbers
				return {
					messages: (payload.data ?? [payload]).flatMap(
						({ message, conversation, phone_number_id: line }) =>
							message !== undefined &&
							(line ?? conversation?.phone_number_id ?? phoneNumberId) === phoneNumberId
								? (parse(message, conversation, download) ?? [])
								: []
					)
				};
			},
			async send(thread, text, key) {
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
						method: 'POST',
						body: JSON.stringify({
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							to: thread,
							type: 'text',
							text: { body: text }
						})
					}
				);
				return { id: sent.messages?.[0]?.id ?? key };
			},
			// the query filters by number, not person, and spans a person's conversations
			async history(thread, since) {
				const messages: Incoming[] = [];
				let after = '';
				for (let page = 0; page < HISTORY_PAGES; page++) {
					const query = new URLSearchParams({
						direction: 'inbound',
						since,
						limit: String(PAGE),
						fields: FIELDS,
						...(after === '' ? {} : { after })
					});
					const { data, paging } = await call(Page, `${phoneNumberId}/messages?${query}`);
					messages.push(
						...data.flatMap((raw) =>
							raw.from === thread ? (parse(raw, undefined, download) ?? []) : []
						)
					);
					after = paging?.cursors?.after ?? '';
					if (data.length < PAGE || after === '') return { messages, complete: true };
				}
				return { messages, complete: false };
			}
		};
		return connection;
	}
};
