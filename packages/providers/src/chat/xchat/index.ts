// XChat, X's end-to-end encrypted messaging, with X's own chat-xdk doing the crypto and the same Activity webhooks and
// OAuth 1.0a keys as X. The bot account's encryption keys are registered once with chat-xdk; `connect` recovers them from
// Juicebox with the PIN. No conversation key is kept: each call reads them from the conversation, which is one more API
// call for each message but holds nothing per conversation. A message's id is its sequence id, the id edits, deletes and
// replies name it by. Group quote replies, read receipts and opening a conversation are left out.
import { Schema } from 'effect';
import { parse as parseJson } from '../http.ts';
import type {
	ChatWithJuicebox,
	ConversationKeyMap,
	Event,
	SigningKeyEntry
} from '@xdevplatform/chat-xdk';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { xAccount, xApi, xChallenge, xFields } from '../x/index.ts';

const PAGE = 50;
const EVENT_FIELDS =
	'conversation_id,conversation_token,created_at,encoded_event,id,sender_id,message_event_signature';
const SIGNING_FIELDS =
	'public_key_version,public_key,signing_public_key,identity_public_key_signature';
const MessageIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const PublicKey = Schema.Struct({
	public_key_version: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
	public_key: Schema.optionalKey(Schema.String),
	signing_public_key: Schema.optionalKey(Schema.String),
	identity_public_key_signature: Schema.optionalKey(Schema.String),
	juicebox_config: Schema.optionalKey(
		Schema.Struct({
			key_store_token_map_json: Schema.optionalKey(Schema.String),
			token_map: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						key: Schema.String,
						value: Schema.Struct({
							token: Schema.String
						})
					})
				)
			)
		})
	)
});
type PublicKey = typeof PublicKey.Type;
const Row = Schema.Struct({
	sender_id: Schema.optionalKey(Schema.String),
	encoded_event: Schema.optionalKey(Schema.String),
	conversation_token: Schema.optionalKey(Schema.String),
	created_at: Schema.optionalKey(Schema.String)
});
type Row = typeof Row.Type;
const Page = Schema.Struct({
	data: Schema.optionalKey(Schema.Array(Row)),
	meta: Schema.optionalKey(
		Schema.Struct({
			conversation_key_events: Schema.optionalKey(Schema.Array(Schema.String)),
			next_token: Schema.optionalKey(Schema.String)
		})
	)
});
const Payload = Schema.Struct({
	conversation_id: Schema.optionalKey(Schema.String),
	encoded_event: Schema.optionalKey(Schema.String),
	sender_id: Schema.optionalKey(Schema.String),
	conversation_key_version: Schema.optionalKey(Schema.String),
	conversation_key_change_event: Schema.optionalKey(Schema.String),
	encrypted_conversation_key: Schema.optionalKey(Schema.String)
});
type Payload = typeof Payload.Type;
const Activity = Schema.Struct({
	...Payload.fields,
	event_type: Schema.optionalKey(Schema.String),
	payload: Schema.optionalKey(Payload)
});
type Activity = typeof Activity.Type;

const versionOf = (key: PublicKey) => key.public_key_version ?? key.version;
/** A one-to-one's id names both people; its API path names the other one. */
const pathOf = (conversation: string, me: string) =>
	encodeURIComponent(
		conversation.startsWith('g')
			? conversation
			: (conversation.split(/[-:]/).find((id) => /^\d+$/.test(id) && id !== me) ?? conversation)
	);
const dashed = (conversation: string) =>
	encodeURIComponent(conversation.startsWith('g') ? conversation : conversation.replace(':', '-'));
const mimeOf = (media: string) =>
	media === 'image' || media === 'gif' || media === 'svg'
		? 'image/*'
		: media === 'video' || media === 'audio'
			? `${media}/*`
			: 'application/octet-stream';

// ponytail: Juicebox reads its token callback from one process-wide global, so unlocks queue across all tenants here
let unlocks: Promise<unknown> = Promise.resolve();
const oneAtATime = <A>(work: () => Promise<A>) => {
	const turn = unlocks.then(work);
	unlocks = turn.catch(() => undefined);
	return turn;
};

export const xchat: ChatPlatform = {
	id: 'xchat',
	name: { en: 'XChat', zh: 'XChat' },
	description: { en: 'Encrypted conversations on X', zh: 'X 上的端到端加密会话' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:x',
	guide: 'https://docs.x.com/x-api/activity/introduction',
	fields: [
		...xFields,
		{ name: 'pin', label: { en: 'Encryption PIN', zh: '加密 PIN 码' }, secret: true }
	],
	async connect(settings, host) {
		const api = await xApi(settings, host),
			account = await xAccount(api),
			me = account.id;
		const publicKeys = async (user: string, fields: string) => {
			const { data } = await api.json(
				Schema.Struct({
					data: Schema.optionalKey(Schema.Union([PublicKey, Schema.Array(PublicKey)]))
				}),
				'GET',
				`/2/users/${encodeURIComponent(user)}/public_keys?public_key.fields=${fields}`
			);
			return [data ?? []].flat();
		};
		const own = (await publicKeys(me, 'public_key_version,juicebox_config')).reduce<
			PublicKey | undefined
		>(
			(newest, key) =>
				newest === undefined || BigInt(versionOf(key) ?? 0) > BigInt(versionOf(newest) ?? 0)
					? key
					: newest,
			undefined
		);
		const version = own === undefined ? undefined : versionOf(own),
			config = own?.juicebox_config?.key_store_token_map_json;
		if (version === undefined || config === undefined)
			throw new PlatformError('this account has no XChat keys registered', 400);
		const tokens = new Map(
			own?.juicebox_config?.token_map?.map((realm) => [realm.key, realm.value.token])
		);
		const { createChat } = await import('@xdevplatform/chat-xdk');
		const crypto: ChatWithJuicebox = await oneAtATime(async () => {
			const chat = await createChat({
				juiceboxConfig: config,
				getAuthToken: async (realm) => {
					const token = tokens.get(realm);
					if (token === undefined) throw new Error(`no Juicebox token for realm ${realm}`);
					return token;
				}
			});
			await chat.unlock(settings['pin'] ?? '').catch((error: unknown) => {
				chat.free();
				throw error;
			});
			return chat;
		});
		crypto.setIdentity(me, version);

		const signers = async (users: readonly string[]) =>
			(
				await Promise.all(
					[...new Set(users)].map(async (userId) =>
						(await publicKeys(userId, SIGNING_FIELDS)).flatMap((key): SigningKeyEntry[] => {
							const publicKeyVersion = versionOf(key),
								publicKey = key.signing_public_key,
								identityPublicKey = key.public_key,
								identityPublicKeySignature = key.identity_public_key_signature;
							return publicKeyVersion === undefined ||
								publicKey === undefined ||
								identityPublicKey === undefined ||
								identityPublicKeySignature === undefined
								? []
								: [
										{
											userId,
											publicKeyVersion,
											publicKey,
											identityPublicKey,
											identityPublicKeySignature
										}
									];
						})
					)
				)
			).flat();
		/** A page of a conversation, newest first, and the keys it holds. */
		const read = async (conversation: string, token?: string) => {
			const after = token === undefined ? '' : `&pagination_token=${encodeURIComponent(token)}`;
			const page = await api.json(
				Page,
				'GET',
				`/2/chat/conversations/${pathOf(conversation, me)}/events?max_results=${PAGE}&chat_message_event.fields=${EVENT_FIELDS}${after}`
			);
			const rows = page.data ?? [];
			return {
				rows,
				next: page.meta?.next_token,
				keys: crypto.extractConversationKeys([
					...(page.meta?.conversation_key_events ?? []),
					...rows.flatMap((row) => row.encoded_event ?? [])
				])
			};
		};
		/** Decrypted and its signature proved, or null: an event neither can be done for is not to be believed. */
		const open = (encoded: string, keys: ConversationKeyMap, signing: SigningKeyEntry[]) => {
			try {
				return crypto.decryptEvent(encoded, keys, signing);
			} catch {
				return null;
			}
		};
		const named = new RegExp(`(?<![A-Za-z0-9_.])@${account.username ?? me}(?![A-Za-z0-9_])`, 'i');
		const parse = (event: Event, thread: string, keys: ConversationKeyMap): readonly Incoming[] => {
			const sender = event.senderId ?? '';
			if (sender === me) return [];
			const sent_at = new Date(event.createdAtMsec ?? 0).toISOString();
			const base = {
				thread,
				sent_at,
				from: { handle: sender, name: null },
				group: thread.startsWith('g')
			};
			if (event.type === 'messageDeleted') {
				const ids = MessageIds(event['messageIds']);
				return event['deleteForAll'] === true && ids._tag === 'Some'
					? ids.value.map((id) => ({ ...base, id, text: '', deleted: true }))
					: [];
			}
			if (event.type !== 'message') return [];
			const content = event.content ?? {};
			if (content['content_type'] === 'edit')
				return [
					{
						...base,
						id: String(content['target_message_id']),
						text: String(content['new_text'] ?? ''),
						version: sent_at
					}
				];
			const key = keys[event.keyVersion ?? ''],
				text = content.text ?? '',
				preview: { senderId?: string; replyingToMessageSequenceId?: string } | undefined =
					content['replying_to_preview'] ?? undefined;
			const files = (event.attachments ?? []).flatMap(
				({ mediaHashKey, mediaType, filename, filesizeBytes }) =>
					mediaHashKey === undefined
						? []
						: [
								{
									name: filename ?? mediaHashKey,
									mime: mimeOf(mediaType ?? ''),
									...(typeof filesizeBytes === 'number' ? { bytes: filesizeBytes } : {}),
									fetch: async () => {
										if (key === undefined) throw new Error('no key for this file');
										const bytes = await api.raw(
											'GET',
											`/2/chat/media/${dashed(thread)}/${encodeURIComponent(mediaHashKey)}`
										);
										return crypto.decryptStream(new Uint8Array(await bytes.arrayBuffer()), key);
									}
								}
							]
			);
			// a reaction or a read mark is a message with nothing to read
			if (text.trim() === '' && files.length === 0) return [];
			return [
				{
					...base,
					id: event.sequenceId ?? event.id ?? '',
					text,
					mentioned: named.test(text),
					replied_to: preview?.senderId === me && event.replyPreviewValidation !== 'invalid',
					reply_to: preview?.replyingToMessageSequenceId ?? null,
					files
				}
			];
		};
		/** One Activity event. What arrives and cannot be read is not acknowledged, so X delivers it again. */
		const received = async (activity: Activity): Promise<readonly Incoming[]> => {
			const payload = activity.payload ?? activity,
				thread = payload.conversation_id,
				encoded = payload.encoded_event,
				sender = payload.sender_id,
				wrapped = payload.encrypted_conversation_key,
				keyVersion = payload.conversation_key_version;
			if (
				(activity.event_type ?? 'chat.received') !== 'chat.received' ||
				thread === undefined ||
				encoded === undefined ||
				sender === undefined ||
				sender === me
			)
				return [];
			const keys = {
				...(await read(thread)).keys.keys,
				...crypto.extractConversationKeys(
					[payload.conversation_key_change_event ?? [], encoded].flat()
				).keys,
				...(wrapped === undefined || keyVersion === undefined
					? {}
					: { [keyVersion]: crypto.decryptConversationKey(wrapped) })
			};
			const event = open(encoded, keys, await signers([sender, me]));
			if (event === null) throw new Error('an XChat event could not be decrypted and verified');
			return parse(event, thread, keys);
		};
		/** A disappearing conversation's time, from the last thing the other side wrote. */
		const ttlOf = async (rows: readonly Row[], keys: ConversationKeyMap) => {
			for (const { sender_id: sender, encoded_event: encoded } of rows) {
				if (sender === undefined || sender === me || encoded === undefined) continue;
				const event = open(encoded, keys, await signers([sender, me]));
				if (event?.content?.['content_type'] === 'text') return Number(event['ttlMsec']) || null;
			}
			return null;
		};
		const connection: ChatConnection = {
			account: account.username ?? me,
			async deliver(request, body) {
				const challenge = xChallenge(request, body, settings['apiSecret'] ?? '');
				if (challenge !== null) return nothing(challenge);
				const root = await parseJson(
					Schema.Struct({
						...Activity.fields,
						data: Schema.optionalKey(Schema.Union([Activity, Schema.Array(Activity)]))
					}),
					body
				);
				const events = await Promise.all([root.data ?? root].flat().map(received));
				return { messages: events.flat() };
			},
			async send(thread, text) {
				const { rows, keys } = await read(thread),
					latest = keys.latestVersion,
					key = latest === null ? undefined : keys.keys[latest];
				if (latest === null || key === undefined)
					throw new Error(`no conversation key for ${thread}`);
				const token = rows.find((row) => row.conversation_token)?.conversation_token;
				const payload = crypto.encryptMessage({
					conversationId: thread,
					text,
					conversationKey: key,
					conversationKeyVersion: latest,
					ttlMsec: await ttlOf(rows, keys.keys)
				});
				await api.raw('POST', `/2/chat/conversations/${pathOf(thread, me)}/messages`, {
					message_id: payload.messageId,
					encoded_message_create_event: payload.encryptedContent,
					encoded_message_event_signature: payload.encodedEventSignature,
					...(token === undefined ? {} : { conversation_token: token })
				});
				return { id: payload.messageId };
			},
			typing: async (thread, on) => {
				if (on) await api.raw('POST', `/2/chat/conversations/${pathOf(thread, me)}/typing`);
			},
			async history(thread, since) {
				const from = Date.parse(since),
					messages: Incoming[] = [];
				let whole = true;
				for (let token: string | undefined; ;) {
					const { rows, keys, next } = await read(thread, token);
					const signing = await signers([me, ...rows.flatMap((row) => row.sender_id ?? [])]);
					for (const row of rows) {
						if (Date.parse(row.created_at ?? '') < from) continue;
						const event = open(row.encoded_event ?? '', keys.keys, signing);
						if (event === null) whole = false;
						else messages.push(...parse(event, thread, keys.keys));
					}
					token = next;
					if (token === undefined || rows.some((row) => Date.parse(row.created_at ?? '') < from))
						return { messages, complete: whole };
				}
			},
			close: async () => crypto.free()
		};
		return connection;
	}
};
