// Velt, through its REST API. A thread is a comment annotation, which needs its organization and document to be reached:
// `organization:document:annotation`, each URI-encoded. An annotation reads back with every comment, which is its
// history. Webhooks are version 2 (Advanced, Standard Webhooks signed); the basic version sends only a shared token.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, same } from '../verify.ts';

const API = 'https://api.velt.dev';
/** A generated token's working life, as Velt's own adapter keeps one. */
const TOKEN_MS = 40 * 3_600_000;
const TOLERANCE_S = 5 * 60;
const COMMENT_EVENTS = new Set([
	'comment.add',
	'comment_annotation.add',
	'comment.update',
	'comment.delete'
]);

type At = number | string;
type User = { readonly userId: string; readonly name?: string };
type Comment = {
	readonly commentId: number;
	readonly commentText?: string;
	readonly commentHtml?: string;
	readonly from?: User;
	readonly to?: readonly User[];
	readonly taggedUserContacts?: readonly {
		readonly userId: string;
		readonly text?: string;
		readonly contact?: User;
	}[];
	readonly createdAt?: At;
	readonly lastUpdated?: At;
	readonly editedAt?: At;
	readonly isEdited?: boolean;
	readonly attachments?: readonly {
		readonly name?: string;
		readonly url?: string;
		readonly mimeType?: string;
		readonly size?: number;
	}[];
};
type Annotation = { readonly annotationId?: string; readonly comments?: readonly Comment[] };
type Hook = {
	readonly event?: string;
	readonly data: {
		readonly commentAnnotation?: Annotation;
		readonly targetComment?: Comment;
		readonly metadata?: {
			readonly organizationId?: string;
			readonly clientOrganizationId?: string;
			readonly organization?: { readonly organizationId?: string };
			readonly documentId?: string;
			readonly clientDocumentId?: string;
			readonly document?: { readonly documentId?: string };
		};
	};
};

/** Standard Webhooks: an HMAC of `id.timestamp.body` under the decoded key, its timestamp recent. */
const verify = (headers: Headers, body: string, key: Buffer) => {
	const id = headers.get('webhook-id'),
		at = headers.get('webhook-timestamp'),
		want = hmac(key, `${id}.${at}.${body}`, 'base64');
	const fresh = Math.abs(Date.now() / 1000 - Number(at)) <= TOLERANCE_S;
	const matches = headers
		.get('webhook-signature')
		?.split(' ')
		.some((one) => same(one.slice(one.indexOf(',') + 1), want));
	if (id === null || !fresh || matches !== true) throw new Unverified('bad signature');
};
const place = (thread: string) => {
	const [organizationId = '', documentId = '', annotationId = ''] = thread
		.split(':')
		.map((part) => decodeURIComponent(part));
	return { organizationId, documentId, annotationId };
};
const instant = (at: At | undefined) => new Date(at ?? Date.now()).toISOString();

export const velt: ChatPlatform = {
	id: 'velt',
	name: { en: 'Velt', zh: 'Velt' },
	description: { en: 'Anchored document comments', zh: '锚定在文档上的评论' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	guide: 'https://docs.velt.dev/webhooks/advanced',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true },
		{ name: 'organizationId', label: { en: 'Organization ID', zh: '组织 ID' } },
		{ name: 'botUserId', label: { en: 'Bot user ID', zh: '机器人用户 ID' } },
		{ name: 'botUserName', label: { en: 'Bot name', zh: '机器人名称' } }
	],
	async connect(
		{ apiKey = '', webhookSecret = '', organizationId = '', botUserId = '', botUserName = '' },
		host
	) {
		const key = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
		if (key.length === 0) throw new Error('that is not a Velt webhook secret');
		const post = async (path: string, data: object, token?: string) => {
			const response = await host.fetch(`${API}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-velt-api-key': apiKey,
					...(token === undefined ? {} : { 'x-velt-auth-token': token })
				},
				body: JSON.stringify({ data })
			});
			if (!response.ok) {
				const wait = Number(response.headers.get('retry-after'));
				throw new PlatformError(
					`${path} answered ${response.status}`,
					response.status,
					wait > 0 ? wait * 1000 : undefined
				);
			}
			const { result } = (await response.json()) as {
				readonly result?: {
					readonly status?: string;
					readonly message?: string;
					readonly data?: unknown;
				};
			};
			if (result?.status !== undefined && result.status !== 'success')
				throw new PlatformError(result.message ?? `${path} refused`, 400);
			return result?.data;
		};
		// one token, for the organization last asked of: a token is scoped to one
		let held: {
			readonly organization: string;
			readonly token: string;
			readonly until: number;
		} | null = null;
		const token = async (organization: string) => {
			if (held?.organization === organization && held.until > Date.now()) return held.token;
			const made = (await post('/v2/auth/generate_token', {
				userId: botUserId,
				userProperties: { name: botUserName },
				permissions: {
					resources: [{ type: 'organization', id: organization, accessRole: 'editor' }]
				}
			})) as { readonly token?: string } | undefined;
			if (made?.token === undefined) throw new Error('Velt answered no token');
			held = { organization, token: made.token, until: Date.now() + TOKEN_MS };
			return made.token;
		};
		const call = async <A extends { readonly organizationId: string }>(path: string, data: A) =>
			post(path, data, await token(data.organizationId)).catch(async (error: unknown) => {
				if (!(error instanceof PlatformError) || error.status !== 401) throw error;
				held = null;
				return post(path, data, await token(data.organizationId));
			});
		await token(organizationId);
		const download = async (url: string) => {
			const response = await host.fetch(url);
			if (!response.ok)
				throw new PlatformError(`a file answered ${response.status}`, response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const escaped = botUserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const named = new RegExp(`@${escaped}(?![\\w-])`, 'i');
		const parse = (comment: Comment, thread: string): Incoming => {
			const names = new Map([
				...(comment.taggedUserContacts ?? []).map(
					({ userId, text, contact }) => [userId, contact?.name ?? text?.replace(/^@/, '')] as const
				),
				...(comment.to ?? []).map(({ userId, name }) => [userId, name] as const)
			]);
			// a mention is stored as `{{userId}}` in the text
			const text = (
				comment.commentText ??
				comment.commentHtml?.replace(/<[^>]+>/g, '') ??
				''
			).replace(
				/\{\{([^}]+)\}\}/g,
				(_, id: string) => `@${id === botUserId ? botUserName : (names.get(id) ?? id)}`
			);
			const edited =
				comment.editedAt ?? (comment.isEdited === true ? comment.lastUpdated : undefined);
			return {
				// a comment id is a number within its annotation, and ids dedupe across all of them
				id: `${place(thread).annotationId}:${comment.commentId}`,
				thread,
				sentAt: instant(comment.createdAt),
				from: { handle: comment.from?.userId ?? '', name: comment.from?.name ?? null },
				text,
				group: true,
				mentioned:
					names.has(botUserId) ||
					comment.taggedUserContacts?.some((one) => one.contact?.userId === botUserId) === true ||
					named.test(text),
				...(edited === undefined ? {} : { version: instant(edited) }),
				files: (comment.attachments ?? []).flatMap(({ name, url, mimeType, size }) =>
					url === undefined
						? []
						: [
								{
									name: name ?? 'attachment',
									mime: mimeType ?? 'application/octet-stream',
									...(size === undefined ? {} : { bytes: size }),
									fetch: () => download(url)
								}
							]
				)
			};
		};
		const connection: ChatConnection = {
			account: botUserName,
			async deliver(request, body) {
				verify(request.headers, body, key);
				const { event, data } = JSON.parse(body) as Hook;
				if (event === undefined || !COMMENT_EVENTS.has(event)) return nothing();
				const { metadata, commentAnnotation, targetComment } = data;
				const organization =
					metadata?.organizationId ??
					metadata?.clientOrganizationId ??
					metadata?.organization?.organizationId ??
					organizationId;
				const document =
					metadata?.documentId ?? metadata?.clientDocumentId ?? metadata?.document?.documentId;
				const annotation = commentAnnotation?.annotationId;
				const comment = targetComment ?? commentAnnotation?.comments?.at(-1);
				if (
					document === undefined ||
					annotation === undefined ||
					comment === undefined ||
					comment.from?.userId === botUserId
				)
					return nothing();
				const thread = [organization, document, annotation].map(encodeURIComponent).join(':');
				const message = parse(comment, thread);
				return {
					messages: [event === 'comment.delete' ? { ...message, text: '', deleted: true } : message]
				};
			},
			async send(thread, text, key) {
				const where = place(thread);
				const ids = await call('/v2/commentannotations/comments/add', {
					...where,
					commentData: [{ commentText: text, from: { userId: botUserId, name: botUserName } }]
				});
				return { id: `${where.annotationId}:${Array.isArray(ids) ? (ids[0] ?? key) : key}` };
			},
			async history(thread, since) {
				const where = place(thread);
				const found = await call('/v2/commentannotations/get', {
					...where,
					annotationIds: [where.annotationId]
				});
				const annotation = (Array.isArray(found) ? found[0] : undefined) as Annotation | undefined;
				// no annotation is gone or out of reach, and the answer does not say which
				if (annotation === undefined) return { messages: [], complete: false };
				const from = Date.parse(since);
				return {
					messages: (annotation.comments ?? [])
						.filter(
							(comment) =>
								comment.from?.userId !== botUserId && Date.parse(instant(comment.createdAt)) >= from
						)
						.map((comment) => parse(comment, thread)),
					complete: true
				};
			}
		};
		return connection;
	}
};
