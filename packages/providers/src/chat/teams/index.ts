// Microsoft Teams, as a Bot Framework bot. The Teams SDK validates each activity's token. Its own clients reach the
// network through axios and MSAL, past the host's fetch, so the token and the Connector are plain calls here. Teams has
// no dedupe key on a send. Nothing installed names a Graph delta endpoint, and reading a chat back takes a Graph
// permission a bot does not hold by default and per-thread ids a delivery does not leave here, so this is webhook-only.
import { loadToken, tokenCache } from '../token.ts';
import { Effect, Schema } from 'effect';
import { parse as parseJson, json } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

const BOT_SCOPE = 'https://api.botframework.com/.default';
const DEFAULT_TENANT = 'botframework.com';
const DEFAULT_SERVICE = 'https://smba.trafficmanager.net/teams';
const TOKEN_EARLY_MS = 300_000;
const DOWNLOAD = 'application/vnd.microsoft.teams.file.download.info';
/** The only hosts a bot token is sent to: a thread's service URL is otherwise whatever a caller names. */
const CONNECTORS = new Set([
	'msteams.botframework.azure.cn',
	'smba.infra.dod.teams.microsoft.us',
	'smba.infra.gcc.teams.microsoft.com',
	'smba.infra.gov.teams.microsoft.us',
	'smba.trafficmanager.net'
]);
const Account = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.String)
});
type Account = typeof Account.Type;
const Activity = Schema.Struct({
	type: Schema.optionalKey(Schema.String),
	id: Schema.optionalKey(Schema.String),
	timestamp: Schema.optionalKey(Schema.String),
	serviceUrl: Schema.optionalKey(Schema.String),
	from: Schema.optionalKey(Account),
	recipient: Schema.optionalKey(Account),
	conversation: Schema.optionalKey(
		Schema.Struct({
			id: Schema.String,
			name: Schema.optionalKey(Schema.String),
			isGroup: Schema.optionalKey(Schema.Boolean),
			conversationType: Schema.optionalKey(Schema.String)
		})
	),
	text: Schema.optionalKey(Schema.String),
	replyToId: Schema.optionalKey(Schema.String),
	entities: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				type: Schema.String,
				mentioned: Schema.optionalKey(Account)
			})
		)
	),
	attachments: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				contentType: Schema.optionalKey(Schema.String),
				contentUrl: Schema.optionalKey(Schema.String),
				name: Schema.optionalKey(Schema.String),
				content: Schema.optionalKey(Schema.Json)
			})
		)
	)
});
type Activity = typeof Activity.Type;

/** A thread keeps its service URL: a Connector call needs it, and only a delivery says it. */
const threadOf = (serviceUrl: string, conversation: string) => `${serviceUrl}|${conversation}`;
/** An activity's id is only unique in its conversation; a channel thread's conversation names its root too. */
const idOf = (conversation: string, id: string) =>
	`${conversation.replace(/;messageid=\d+/, '')}:${id}`;

export const teams: ChatPlatform = {
	id: 'teams',
	name: { en: 'Microsoft Teams', zh: 'Microsoft Teams' },
	description: { en: 'Team chats and direct messages', zh: '团队聊天与私信' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:microsoftteams',
	guide:
		'https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams',
	fields: [
		{ name: 'appId', label: { en: 'App ID', zh: '应用 ID' } },
		{ name: 'appPassword', label: { en: 'App password', zh: '应用密码' }, secret: true },
		{ name: 'appTenantId', label: { en: 'Tenant ID', zh: '租户 ID' }, optional: true }
	],
	async connect({ appId = '', appPassword = '', appTenantId = '' }, host) {
		const { InboundActivityTokenValidator } =
			await import('@microsoft/teams.apps/dist/middleware/auth/inbound-activity-token-validator.js');
		const validator = new InboundActivityTokenValidator(appId, appTenantId || undefined);
		const tokens = await Effect.runPromise(
			tokenCache(() =>
				loadToken(async () => {
					const response = await host.fetch(
						`https://login.microsoftonline.com/${encodeURIComponent(appTenantId || DEFAULT_TENANT)}/oauth2/v2.0/token`,
						{
							method: 'POST',
							headers: { 'content-type': 'application/x-www-form-urlencoded' },
							body: new URLSearchParams({
								client_id: appId,
								client_secret: appPassword,
								grant_type: 'client_credentials',
								scope: BOT_SCOPE
							})
						}
					);
					const answer = await Schema.decodeUnknownPromise(
						Schema.Struct({
							access_token: Schema.optionalKey(Schema.String),
							expires_in: Schema.optionalKey(Schema.Number)
						})
					)(await response.json().catch(() => ({})));
					if (!response.ok || answer.access_token === undefined)
						throw new PlatformError(`Teams token answered ${response.status}`, response.status);
					return { token: answer.access_token, ttl: (answer.expires_in ?? 0) * 1000 - TOKEN_EARLY_MS };
				})
			)
		);
		const accessToken = () => Effect.runPromise(tokens.get());
		await accessToken();
		const connector = async <A>(
			schema: Schema.Decoder<A>,
			serviceUrl: string,
			path: string,
			body: object
		) => {
			const url = new URL(path, serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`);
			if (url.protocol !== 'https:' || !CONNECTORS.has(url.hostname))
				throw new PlatformError(`${url.hostname} is not a Teams service`, 400);
			const response = await host.fetch(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${await accessToken()}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			});
			if (!response.ok)
				throw new PlatformError(`Teams answered ${response.status}`, response.status);
			return json(schema, response);
		};
		const activities = (thread: string, activity: object) => {
			const [serviceUrl = '', conversation = ''] = thread.split('|');
			return connector(
				Schema.Struct({
					id: Schema.optionalKey(Schema.String)
				}),
				serviceUrl,
				`v3/conversations/${encodeURIComponent(conversation)}/activities`,
				activity
			);
		};
		const filesOf = ({ attachments, serviceUrl = '' }: Activity): IncomingFile[] =>
			(attachments ?? []).flatMap((file) => {
				const download = file.contentType === DOWNLOAD,
					info = Schema.decodeUnknownOption(Schema.Struct({ downloadUrl: Schema.String }))(
						file.content
					),
					url = download
						? info._tag === 'Some'
							? info.value.downloadUrl
							: undefined
						: file.contentUrl;
				if (url === undefined) return [];
				return {
					name: file.name ?? 'attachment',
					mime: download
						? 'application/octet-stream'
						: (file.contentType ?? 'application/octet-stream'),
					// a download link is pre-authorized; only the bot's own Connector gets its token
					fetch: async () => {
						const own = !download && new URL(url).origin === new URL(serviceUrl).origin;
						const response = await host.fetch(
							url,
							own ? { headers: { authorization: `Bearer ${await accessToken()}` } } : {}
						);
						if (!response.ok)
							throw new PlatformError(`Teams answered ${response.status}`, response.status);
						return new Uint8Array(await response.arrayBuffer());
					}
				};
			});
		const parse = (activity: Activity): Incoming | null => {
			const { id, type, from, recipient, conversation, serviceUrl, entities } = activity;
			if (
				id === undefined ||
				from === undefined ||
				conversation === undefined ||
				serviceUrl === undefined ||
				from.id === recipient?.id
			)
				return null;
			const kind = conversation.conversationType,
				group = kind === undefined ? conversation.isGroup === true : kind !== 'personal',
				sent_at = activity.timestamp ?? new Date().toISOString();
			const base = {
				id: idOf(conversation.id, id),
				thread: threadOf(serviceUrl, conversation.id),
				sent_at,
				from: { handle: from.id, name: from.name ?? null },
				group,
				title: conversation.name ?? null
			};
			if (type === 'messageDelete') return { ...base, text: '', deleted: true };
			const message = {
				...base,
				text: (activity.text ?? '').replace(/<at>([^<]*)<\/at>/g, '@$1').trim(),
				mentioned:
					entities?.some((one) => one.type === 'mention' && one.mentioned?.id === recipient?.id) ===
					true,
				reply_to:
					activity.replyToId === undefined ? null : idOf(conversation.id, activity.replyToId),
				files: filesOf(activity)
			};
			if (type === 'messageUpdate') return { ...message, version: sent_at };
			return type === 'message' ? message : null;
		};
		const connection: ChatConnection = {
			account: appId,
			async deliver(request, body) {
				let activity: Activity;
				try {
					activity = await parseJson(Activity, body);
					await validator.check(request.headers.get('authorization') ?? '', {
						...(activity.serviceUrl === undefined ? {} : { serviceUrl: activity.serviceUrl })
					});
				} catch {
					throw new Unverified('bad token');
				}
				const message = parse(activity);
				return message === null ? nothing() : { messages: [message] };
			},
			async send(thread, text, key) {
				const sent = await activities(thread, { type: 'message', text, textFormat: 'markdown' });
				return { id: idOf(thread.split('|')[1] ?? '', sent.id ?? key) };
			},
			async typing(thread, on) {
				if (on) await activities(thread, { type: 'typing' });
			},
			async openDirect(user) {
				if (user.includes('|')) return user;
				const made = await connector(
					Schema.Struct({
						id: Schema.String
					}),
					DEFAULT_SERVICE,
					'v3/conversations',
					{
						bot: { id: appId },
						isGroup: false,
						members: [{ id: user }],
						...(appTenantId === ''
							? {}
							: { tenantId: appTenantId, channelData: { tenant: { id: appTenantId } } })
					}
				);
				return threadOf(DEFAULT_SERVICE, made.id);
			}
		};
		return connection;
	}
};
