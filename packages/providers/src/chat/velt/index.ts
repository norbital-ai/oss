// Velt, through its REST API. A thread is a comment annotation, which needs its organization and document to be reached:
// `organization:document:annotation`, each URI-encoded. An annotation reads back with every comment, which is its
// history. Webhooks are version 2 (Advanced, Standard Webhooks signed); the basic version sends only a shared token.
import { Schema } from 'effect';
import { parse as parseJson, json, download as downloadFile } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { retry_after_ms } from '../../errors.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { standardWebhook } from '../verify.ts';

const API = 'https://api.velt.dev';
/** A generated token's working life, as Velt's own adapter keeps one. */
const TOKEN_MS = 40 * 3_600_000;
const COMMENT_EVENTS = new Set([
	'comment.add',
	'comment_annotation.add',
	'comment.update',
	'comment.delete'
]);

const At = Schema.Union([Schema.Number, Schema.String]);
type At = typeof At.Type;
const User = Schema.Struct({
	userId: Schema.String,
	name: Schema.optionalKey(Schema.String)
});
type User = typeof User.Type;
const Comment = Schema.Struct({
	commentId: Schema.Number,
	commentText: Schema.optionalKey(Schema.String),
	commentHtml: Schema.optionalKey(Schema.String),
	from: Schema.optionalKey(User),
	to: Schema.optionalKey(Schema.Array(User)),
	taggedUserContacts: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				userId: Schema.String,
				text: Schema.optionalKey(Schema.String),
				contact: Schema.optionalKey(User)
			})
		)
	),
	createdAt: Schema.optionalKey(At),
	lastUpdated: Schema.optionalKey(At),
	editedAt: Schema.optionalKey(At),
	isEdited: Schema.optionalKey(Schema.Boolean),
	attachments: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.optionalKey(Schema.String),
				url: Schema.optionalKey(Schema.String),
				mimeType: Schema.optionalKey(Schema.String),
				size: Schema.optionalKey(Schema.Number)
			})
		)
	)
});
type Comment = typeof Comment.Type;
const Annotation = Schema.Struct({
	annotationId: Schema.optionalKey(Schema.String),
	comments: Schema.optionalKey(Schema.Array(Comment))
});
type Annotation = typeof Annotation.Type;
const Hook = Schema.Struct({
	event: Schema.optionalKey(Schema.String),
	data: Schema.Struct({
		commentAnnotation: Schema.optionalKey(Annotation),
		targetComment: Schema.optionalKey(Comment),
		metadata: Schema.optionalKey(
			Schema.Struct({
				organizationId: Schema.optionalKey(Schema.String),
				clientOrganizationId: Schema.optionalKey(Schema.String),
				organization: Schema.optionalKey(
					Schema.Struct({
						organizationId: Schema.optionalKey(Schema.String)
					})
				),
				documentId: Schema.optionalKey(Schema.String),
				clientDocumentId: Schema.optionalKey(Schema.String),
				document: Schema.optionalKey(
					Schema.Struct({
						documentId: Schema.optionalKey(Schema.String)
					})
				)
			})
		)
	})
});

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
				throw new PlatformError(
					`${path} answered ${response.status}`,
					response.status,
					retry_after_ms(response.headers.get('retry-after'))
				);
			}
			const { result } = await json(
				Schema.Struct({
					result: Schema.optionalKey(
						Schema.Struct({
							status: Schema.optionalKey(Schema.String),
							message: Schema.optionalKey(Schema.String),
							data: Schema.optionalKey(Schema.Unknown)
						})
					)
				}),
				response
			);
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
			const made = await Schema.decodeUnknownPromise(
				Schema.Union([
					Schema.Struct({
						token: Schema.optionalKey(Schema.String)
					}),
					Schema.Undefined
				])
			)(
				await post('/v2/auth/generate_token', {
					userId: botUserId,
					userProperties: { name: botUserName },
					permissions: {
						resources: [{ type: 'organization', id: organization, accessRole: 'editor' }]
					}
				})
			);
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
		const download = (url: string) => downloadFile(host.fetch, url);
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
				sent_at: instant(comment.createdAt),
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
				standardWebhook(request.headers, body, key);
				const { event, data } = await parseJson(Hook, body);
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
				const annotations = await Schema.decodeUnknownPromise(
					Schema.optional(Schema.Array(Annotation))
				)(found);
				const annotation = annotations?.[0];
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
