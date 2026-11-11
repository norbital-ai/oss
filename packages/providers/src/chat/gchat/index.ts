// Google Chat, through its own client and Google's auth library, every request over the host's fetch. A Chat app's HTTP
// endpoint hears direct messages and @mentions only, and neither edits nor deletes: the rest is Workspace Events over
// Pub/Sub, left out. Reading a space back needs a Workspace administrator's approval, and without it `history` answers
// an incomplete nothing. The endpoint's audience is either the project number or its URL, so both tokens are accepted.
import { Predicate, Schema } from 'effect';
import { parse as parseJson, json } from '../http.ts';
import { createHash } from 'node:crypto';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { PlatformError, nothing, Unverified } from '../adapter.ts';

const CHAT_ACCOUNT = 'chat@system.gserviceaccount.com';
const CERTS = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ACCOUNT}`;
const CERTS_TTL_MS = 3_600_000;
const SEND_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const READ_SCOPE = 'https://www.googleapis.com/auth/chat.app.messages.readonly';
const THREADS = '/threads/';
const PAGES = 10;
const Message = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	createTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
	lastUpdateTime: Schema.optionalKey(Schema.NullOr(Schema.String)),
	text: Schema.optionalKey(Schema.NullOr(Schema.String)),
	argumentText: Schema.optionalKey(Schema.NullOr(Schema.String)),
	sender: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				name: Schema.optionalKey(Schema.NullOr(Schema.String)),
				type: Schema.optionalKey(Schema.NullOr(Schema.String)),
				displayName: Schema.optionalKey(Schema.NullOr(Schema.String))
			})
		)
	),
	thread: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
	),
	quotedMessageMetadata: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
	),
	attachment: Schema.optionalKey(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					contentName: Schema.optionalKey(Schema.NullOr(Schema.String)),
					contentType: Schema.optionalKey(Schema.NullOr(Schema.String)),
					attachmentDataRef: Schema.optionalKey(
						Schema.NullOr(
							Schema.Struct({ resourceName: Schema.optionalKey(Schema.NullOr(Schema.String)) })
						)
					)
				})
			)
		)
	)
});
type Message = typeof Message.Type;
const Space = Schema.Struct({
	displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	type: Schema.optionalKey(Schema.NullOr(Schema.String)),
	spaceType: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const Event = Schema.Struct({
	type: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Message),
	space: Schema.optionalKey(Space),
	chat: Schema.optionalKey(
		Schema.Struct({
			messagePayload: Schema.optionalKey(
				Schema.Struct({ message: Schema.optionalKey(Message), space: Schema.optionalKey(Space) })
			)
		})
	)
});

const spaceOf = (thread: string) => thread.split(THREADS)[0] ?? thread;
const statusOf = (error: unknown) =>
	Predicate.hasProperty(error, 'status') && typeof error.status === 'number'
		? error.status
		: undefined;
/** A Google API call, with its refusal as a `PlatformError`. */
const answered = async <A>(work: Promise<A>) =>
	work.catch((error: unknown) => {
		const status = statusOf(error);
		throw status === undefined ? error : new PlatformError(`Google answered ${status}`, status);
	});

export const gchat: ChatPlatform = {
	id: 'gchat',
	name: { en: 'Google Chat', zh: 'Google Chat' },
	description: { en: 'Google Chat spaces and direct messages', zh: 'Google Chat 空间与私信' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	idempotent: true,
	icon: 'simple-icons:googlechat',
	guide: 'https://developers.google.com/workspace/chat/quickstart/gcf-app',
	fields: [
		{
			name: 'credentials',
			label: { en: 'Service account JSON', zh: '服务账号 JSON' },
			secret: true
		},
		{ name: 'projectNumber', label: { en: 'Project number', zh: '项目编号' } }
	],
	async connect({ credentials = '', projectNumber = '' }, host) {
		const { client_email: email, private_key: key } = await parseJson(
			Schema.Struct({
				client_email: Schema.String,
				private_key: Schema.String
			}),
			credentials
		);
		const [{ chat }, { JWT, OAuth2Client }] = await Promise.all([
			import('@googleapis/chat'),
			import('google-auth-library')
		]);
		const transporterOptions = { fetchImplementation: host.fetch };
		const authorized = (scope: string) =>
			new JWT({ email, key, scopes: [scope], transporterOptions });
		const auth = authorized(SEND_SCOPE);
		await auth.authorize();
		const api = chat({ version: 'v1', auth });
		const verifier = new OAuth2Client({ transporterOptions });
		const addOn = `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
		let certs: { readonly keys: Record<string, string>; readonly at: number } | null = null;
		const chatCerts = async () => {
			if (certs !== null && Date.now() - certs.at < CERTS_TTL_MS) return certs.keys;
			const response = await host.fetch(CERTS);
			if (!response.ok)
				throw new PlatformError(`Google answered ${response.status}`, response.status);
			certs = {
				keys: await json(Schema.Record(Schema.String, Schema.String), response),
				at: Date.now()
			};
			return certs.keys;
		};
		const verified = async (header: string | null) => {
			const token = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : '';
			const keys = await chatCerts();
			const byNumber = await verifier
				.verifySignedJwtWithCertsAsync(token, keys, projectNumber, [CHAT_ACCOUNT])
				.catch(() => null);
			if (byNumber !== null) return;
			const ticket = await verifier
				.verifyIdToken({ idToken: token, audience: host.webhookUrl })
				.catch(() => null);
			const claims = ticket?.getPayload();
			if (
				claims?.email_verified !== true ||
				(claims.email !== CHAT_ACCOUNT && claims.email !== addOn)
			)
				throw new Unverified('bad token');
		};
		const download = async (resourceName: string) => {
			const { data } = await answered(
				auth.request<ArrayBuffer>({
					url: `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`,
					responseType: 'arraybuffer'
				})
			);
			return new Uint8Array(data);
		};
		const parse = (message: Message, thread: string, group: boolean): Incoming | null => {
			const { name, sender, createTime } = message;
			if (!name || !createTime || !sender?.name || sender.type === 'BOT') return null;
			return {
				id: name,
				thread,
				sentAt: createTime,
				from: { handle: sender.name, name: sender.displayName ?? null },
				text: message.argumentText?.trim() ?? message.text ?? '',
				group,
				replyTo: message.quotedMessageMetadata?.name ?? null,
				...(message.lastUpdateTime ? { version: message.lastUpdateTime } : {}),
				files: (message.attachment ?? []).map((file) => {
					const resource = file.attachmentDataRef?.resourceName;
					return {
						name: file.contentName ?? 'attachment',
						mime: file.contentType ?? 'application/octet-stream',
						...(resource ? { fetch: () => download(resource) } : {})
					};
				})
			};
		};
		const connection: ChatConnection = {
			account: email,
			async deliver(request, body) {
				await verified(request.headers.get('authorization'));
				const event = await parseJson(Event, body);
				const { message, space } =
					event.chat?.messagePayload ?? (event.type === 'MESSAGE' ? event : {});
				if (!message || !space?.name) return nothing();
				const direct = space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE';
				const thread = direct ? space.name : (message.thread?.name ?? space.name);
				const parsed = parse(message, thread, !direct);
				// this endpoint only hears a group's @mentions
				return parsed === null
					? nothing()
					: {
							messages: [{ ...parsed, mentioned: !direct, title: space.displayName ?? null }]
						};
			},
			// Chat answers a repeated `requestId` with the message it already made
			async send(thread, text, key) {
				const threaded = thread.includes(THREADS);
				const sent = await answered(
					api.spaces.messages.create({
						parent: spaceOf(thread),
						requestId: createHash('sha256').update(key).digest('hex'),
						...(threaded ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
						requestBody: { text, ...(threaded ? { thread: { name: thread } } : {}) }
					})
				);
				return { id: sent.data.name ?? key };
			},
			async openDirect(user) {
				if (user.startsWith('spaces/')) return user;
				const found = await answered(api.spaces.findDirectMessage({ name: user }));
				return found.data.name ?? user;
			},
			async history(thread, since) {
				const threaded = thread.includes(THREADS);
				// a token of its own, so that pairing never depends on the approval
				const reader = chat({ version: 'v1', auth: authorized(READ_SCOPE) }),
					messages: Incoming[] = [];
				let pageToken: string | undefined;
				for (let page = 0; page < PAGES; page++) {
					const listed = await reader.spaces.messages
						.list({
							parent: spaceOf(thread),
							filter: `create_time > "${since}"${threaded ? ` AND thread.name = ${thread}` : ''}`,
							showDeleted: true,
							...(pageToken === undefined ? {} : { pageToken })
						})
						.catch((error: unknown) => {
							if (statusOf(error) === 403) return null;
							throw error;
						});
					if (listed === null) return { messages: [], complete: false };
					for (const message of listed.data.messages ?? []) {
						const parsed = parse(message, thread, threaded);
						if (parsed !== null)
							messages.push(
								message.deleteTime ? { ...parsed, text: '', deleted: true, files: [] } : parsed
							);
					}
					pageToken = listed.data.nextPageToken ?? undefined;
					if (pageToken === undefined) return { messages, complete: true };
				}
				return { messages, complete: false };
			}
		};
		return connection;
	}
};
