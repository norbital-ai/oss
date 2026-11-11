// Personal Weixin through iLink, Tencent's bot gateway, long-polled: the cursor moves only after `host.receive` has
// stored a batch, so a refused one comes back. The cursor lives in memory, so a restart polls from the start and the
// host's dedupe absorbs what repeats. Its `getupdates` shows no deletes, so it is no change log, and it offers no history.
// A reply carries the `context_token` of the person's last message; after a restart iLink may refuse a send until they
// write again.
import { Schema } from 'effect';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { PlatformError, Unverified, recent } from '../adapter.ts';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const POLL_MS = 35_000;
const CALL_MS = 15_000;
/** How long a first poll may hold: a refused token answers at once, a good one waits for messages. */
const PROVE_MS = 3_000;
const BOT = 2;
const FINISHED = 2;
const TEXT = 1;
const Media = Schema.Struct({
	encrypt_query_param: Schema.optionalKey(Schema.String),
	aes_key: Schema.optionalKey(Schema.String),
	full_url: Schema.optionalKey(Schema.String)
});
type Media = typeof Media.Type;
const Item = Schema.Struct({
	type: Schema.optionalKey(Schema.Number),
	text_item: Schema.optionalKey(
		Schema.Struct({
			text: Schema.optionalKey(Schema.String)
		})
	),
	voice_item: Schema.optionalKey(
		Schema.Struct({
			media: Schema.optionalKey(Media),
			text: Schema.optionalKey(Schema.String)
		})
	),
	image_item: Schema.optionalKey(
		Schema.Struct({
			media: Schema.optionalKey(Media),
			aeskey: Schema.optionalKey(Schema.String),
			mid_size: Schema.optionalKey(Schema.Number),
			hd_size: Schema.optionalKey(Schema.Number)
		})
	),
	video_item: Schema.optionalKey(
		Schema.Struct({
			media: Schema.optionalKey(Media),
			video_size: Schema.optionalKey(Schema.Number)
		})
	),
	file_item: Schema.optionalKey(
		Schema.Struct({
			media: Schema.optionalKey(Media),
			file_name: Schema.optionalKey(Schema.String),
			len: Schema.optionalKey(Schema.String)
		})
	),
	ref_msg: Schema.optionalKey(
		Schema.Struct({
			message_item: Schema.optionalKey(
				Schema.Struct({
					msg_id: Schema.optionalKey(Schema.String)
				})
			)
		})
	)
});
type Item = typeof Item.Type;
const Raw = Schema.Struct({
	seq: Schema.optionalKey(Schema.Number),
	message_id: Schema.optionalKey(Schema.Number),
	client_id: Schema.optionalKey(Schema.String),
	from_user_id: Schema.optionalKey(Schema.String),
	context_token: Schema.optionalKey(Schema.String),
	create_time_ms: Schema.optionalKey(Schema.Number),
	message_type: Schema.optionalKey(Schema.Number),
	item_list: Schema.optionalKey(Schema.Array(Item))
});
type Raw = typeof Raw.Type;
const Answer = Schema.Struct({
	ret: Schema.optionalKey(Schema.Number),
	errcode: Schema.optionalKey(Schema.Number),
	errmsg: Schema.optionalKey(Schema.String),
	msgs: Schema.optionalKey(Schema.Array(Raw)),
	get_updates_buf: Schema.optionalKey(Schema.String),
	longpolling_timeout_ms: Schema.optionalKey(Schema.Number)
});
type Answer = typeof Answer.Type;

const keyOf = (item: Item, media: Media) => {
	const hex = item.image_item?.aeskey;
	if (hex !== undefined && /^[a-f0-9]{32}$/i.test(hex)) return Buffer.from(hex, 'hex');
	if (media.aes_key === undefined) return undefined;
	const raw = Buffer.from(media.aes_key, 'base64');
	return raw.length === 16 ? raw : Buffer.from(raw.toString('ascii'), 'hex');
};
const describe = (item: Item): Pick<IncomingFile, 'name' | 'mime' | 'bytes'> | null => {
	if (item.image_item !== undefined) {
		const bytes = item.image_item.hd_size ?? item.image_item.mid_size;
		return { name: 'image', mime: 'image/*', ...(bytes === undefined ? {} : { bytes }) };
	}
	if (item.video_item !== undefined) {
		const bytes = item.video_item.video_size;
		return { name: 'video.mp4', mime: 'video/mp4', ...(bytes === undefined ? {} : { bytes }) };
	}
	if (item.file_item !== undefined)
		return {
			name: item.file_item.file_name ?? 'file.bin',
			mime: 'application/octet-stream',
			...(item.file_item.len === undefined ? {} : { bytes: Number(item.file_item.len) })
		};
	// a voice message with a transcript is that text
	return item.voice_item === undefined || item.voice_item.text !== undefined
		? null
		: { name: 'voice.silk', mime: 'audio/silk' };
};
const fileOf = (
	item: Item,
	read: (url: string) => Promise<Uint8Array>
): readonly IncomingFile[] => {
	const media =
			item.image_item?.media ??
			item.video_item?.media ??
			item.file_item?.media ??
			item.voice_item?.media,
		file = describe(item);
	if (media?.encrypt_query_param === undefined || file === null) return [];
	const url =
		media.full_url ??
		`${CDN}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
	const key = keyOf(item, media);
	return [
		{
			...file,
			fetch: async () => {
				const bytes = await read(url);
				if (key === undefined) return bytes;
				const decipher = createDecipheriv('aes-128-ecb', key, null);
				return new Uint8Array(Buffer.concat([decipher.update(bytes), decipher.final()]));
			}
		}
	];
};
const parse = (raw: Raw, read: (url: string) => Promise<Uint8Array>): Incoming | null => {
	const id = raw.message_id ?? raw.client_id ?? raw.seq,
		user = raw.from_user_id,
		items = raw.item_list ?? [];
	if (raw.message_type === BOT || id === undefined || user === undefined || user === '')
		return null;
	const said = items.find((item) => item.text_item?.text ?? item.voice_item?.text),
		text = said?.text_item?.text ?? said?.voice_item?.text ?? '',
		replyTo = said?.ref_msg?.message_item?.msg_id,
		files = items.flatMap((item) => fileOf(item, read));
	if (text === '' && files.length === 0) return null;
	return {
		id: String(id),
		thread: user,
		sentAt: new Date(raw.create_time_ms ?? Date.now()).toISOString(),
		from: { handle: user, name: null },
		text,
		files,
		...(replyTo === undefined ? {} : { replyTo })
	};
};

export const weixin: ChatPlatform = {
	id: 'weixin',
	name: { en: 'Weixin', zh: '微信' },
	description: { en: 'Personal WeChat through iLink', zh: '通过 iLink 接入个人微信' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:wechat',
	guide: 'https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin',
	fields: [
		{ name: 'accountId', label: { en: 'Account ID', zh: '账号 ID' } },
		{ name: 'token', label: { en: 'iLink token', zh: 'iLink 令牌' }, secret: true },
		{ name: 'baseUrl', label: { en: 'iLink URL', zh: 'iLink 地址' }, optional: true }
	],
	async connect({ accountId = '', token = '', baseUrl = '' }, host) {
		const base = (baseUrl.trim() || BASE).replace(/\/$/, ''),
			closing = new AbortController();
		/** One iLink call. `idle` answers a deadline passing, which ends a long poll without being a failure. */
		const post = async (path: string, body: object, ms: number, idle = false): Promise<Answer> => {
			const deadline = new AbortController(),
				timer = setTimeout(() => deadline.abort(), ms);
			try {
				const response = await host.fetch(`${base}/ilink/bot/${path}`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'iLink-App-Id': 'bot',
						'iLink-App-ClientVersion': '1',
						AuthorizationType: 'ilink_bot_token',
						'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
						Authorization: `Bearer ${token.trim()}`
					},
					body: JSON.stringify({ ...body, base_info: { channel_version: '0.1.0' } }),
					signal: AbortSignal.any([closing.signal, deadline.signal])
				});
				const answer = await Schema.decodeUnknownPromise(Answer)(
					await response.json().catch(() => ({}))
				);
				if (!response.ok)
					throw new PlatformError(
						answer.errmsg ?? `iLink answered ${response.status}`,
						response.status
					);
				if ((answer.ret ?? 0) !== 0 || (answer.errcode ?? 0) !== 0)
					throw new PlatformError(
						answer.errmsg ?? `iLink answered ret=${answer.ret} errcode=${answer.errcode}`,
						502
					);
				return answer;
			} catch (error) {
				if (idle && deadline.signal.aborted) return {};
				throw error;
			} finally {
				clearTimeout(timer);
			}
		};
		const read = async (url: string) => {
			const response = await host.fetch(url);
			if (!response.ok) throw new PlatformError('file unavailable', response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const tokens = recent<string>();
		const poll = (cursor: string, ms: number) =>
			post('getupdates', { get_updates_buf: cursor }, ms, true);
		// no other call needs nothing but the token, and what it brings is the first batch
		let first: Answer | null = await poll('', PROVE_MS);
		const loop = async () => {
			let cursor = '',
				wait = POLL_MS,
				failures = 0;
			while (!closing.signal.aborted)
				try {
					const answer: Answer = first ?? (await poll(cursor, wait));
					first = null;
					for (const raw of answer.msgs ?? [])
						if (raw.from_user_id && raw.context_token)
							tokens.set(raw.from_user_id, raw.context_token);
					await host.receive((answer.msgs ?? []).flatMap((raw) => parse(raw, read) ?? []));
					cursor = answer.get_updates_buf || cursor;
					wait = answer.longpolling_timeout_ms || wait;
					failures = 0;
				} catch {
					failures += 1;
					await sleep(Math.min(500 * 2 ** failures, 30_000), undefined, {
						signal: closing.signal
					}).catch(() => undefined);
				}
		};
		const running = loop();
		const connection: ChatConnection = {
			account: accountId,
			async deliver() {
				throw new Unverified('Weixin arrives over its long poll');
			},
			async send(thread, text, key) {
				const context = tokens.get(thread);
				await post(
					'sendmessage',
					{
						msg: {
							from_user_id: '',
							to_user_id: thread,
							client_id: key,
							message_type: BOT,
							message_state: FINISHED,
							...(context === undefined ? {} : { context_token: context }),
							item_list: [{ type: TEXT, text_item: { text } }]
						}
					},
					CALL_MS
				);
				return { id: key };
			},
			async close() {
				closing.abort();
				await running;
			}
		};
		return connection;
	}
};
