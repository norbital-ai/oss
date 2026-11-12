// Linear, through its GraphQL API with Linear's SDK. A thread is an issue, by its id. A comment takes an id of ours, so a
// send cannot post twice. Files are links in a comment's markdown, so none are parsed.
import { Schema } from 'effect';
import { parse as parseJson } from '../http.ts';
import { createHash } from 'node:crypto';
import type { ChatConnection, ChatPlatform } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const REPLAY_MS = 60_000;
const PAGES = 10;

const Hook = Schema.Struct({
	type: Schema.String,
	action: Schema.String,
	webhookTimestamp: Schema.Number,
	data: Schema.optionalKey(Schema.Unknown),
	updatedFrom: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
const Comment = Schema.Struct({
	id: Schema.String,
	body: Schema.String,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	issueId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	userId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String }))
	),
	issue: Schema.optionalKey(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
	parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	parent: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ userId: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
	),
	editedAt: Schema.optionalKey(Schema.NullOr(Schema.String))
});
type Failed = Error & { readonly status?: number; readonly retryAfter?: number };

/** A key as the UUID v4 Linear asks of a comment's id. */
const uuidOf = (key: string) => {
	const hex = createHash('sha256').update(key).digest('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** Only a rate limit carries `retryAfter`: Linear's own error says so whatever the HTTP status. */
const refused = (error: Failed): never => {
	if ('retryAfter' in error)
		throw new PlatformError(error.message, 429, (error.retryAfter ?? 0) * 1000 || undefined);
	throw error.status === undefined ? error : new PlatformError(error.message, error.status);
};
/** What a person wrote themselves: a mention in code or a quote invokes nobody. */
const prose = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`|^>.*$/gm, '');

export const linear: ChatPlatform = {
	id: 'linear',
	name: { en: 'Linear', zh: 'Linear' },
	description: { en: 'Issue comment threads', zh: '议题评论串' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	idempotent: true,
	icon: 'simple-icons:linear',
	guide: 'https://linear.app/developers/webhooks',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', webhookSecret = '' }) {
		const { LinearClient } = await import('@linear/sdk');
		const client = new LinearClient({ apiKey });
		const me = await client.viewer;
		const name = me.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const named = new RegExp(`(?<![\\w.-])@${name}(?![\\w-])`, 'i');
		const said = (text: string) => ({ text, group: true, mentioned: named.test(prose(text)) });
		const connection: ChatConnection = {
			account: me.displayName,
			async deliver(request, body) {
				signed(request.headers.get('linear-signature'), hmac(webhookSecret, body, 'hex'));
				const {
					type,
					action,
					data: raw,
					updatedFrom,
					webhookTimestamp
				} = await parseJson(Hook, body);
				if (!(Math.abs(Date.now() - webhookTimestamp) <= REPLAY_MS))
					throw new Unverified('stale delivery');
				if (type !== 'Comment') return nothing();
				const data = await Schema.decodeUnknownPromise(Comment)(raw);
				// a comment with no user is an app's, and one on anything but an issue has no thread here
				if (!data.issueId || !data.user || data.userId === me.id) return nothing();
				const base = {
					id: data.id,
					thread: data.issueId,
					sent_at: data.createdAt,
					from: { handle: data.user.id, name: data.user.name },
					...(data.issue?.title === undefined ? {} : { title: data.issue.title })
				};
				if (action === 'remove') return { messages: [{ ...base, text: '', deleted: true }] };
				// an update is also a resolve or a reaction: only a changed body is an edit
				const edited = action === 'update' && updatedFrom?.['body'] !== undefined;
				if (action !== 'create' && !edited) return nothing();
				return {
					messages: [
						{
							...base,
							...said(data.body),
							...(data.parentId ? { reply_to: data.parentId } : {}),
							replied_to: data.parent?.userId === me.id,
							...(edited ? { version: data.editedAt ?? data.updatedAt } : {})
						}
					]
				};
			},
			async send(thread, text, key) {
				const id = uuidOf(key);
				const sent = await client
					.createComment({ id, issueId: thread, body: text })
					.catch(async (error: Failed) => {
						// a resend of a comment that landed finds its id taken, and the comment is the answer
						if ((await client.comment({ id }).catch(() => null)) !== null) return null;
						return refused(error);
					});
				return { id: sent?.commentId ?? id };
			},
			async history(thread, since) {
				// the issue first: it fails when out of reach, where the filter below would answer empty and call all deleted
				await client.issue(thread);
				// every comment, replies too, and archived ones because they are not deleted ones
				const page = await client.comments({
					filter: { issue: { id: { eq: thread } }, updatedAt: { gte: since } },
					first: 100,
					includeArchived: true
				});
				// only one response is one read: what a longer listing lacks may have moved under a delete between its pages
				const whole = !page.pageInfo.hasNextPage;
				for (let more = 1; page.pageInfo.hasNextPage && more < PAGES; more++)
					await page.fetchNext();
				return {
					messages: page.nodes.flatMap((comment) =>
						comment.userId === undefined || comment.userId === me.id
							? []
							: [
									{
										id: comment.id,
										thread,
										sent_at: comment.createdAt.toISOString(),
										from: { handle: comment.userId, name: null },
										...said(comment.body),
										...(comment.parentId ? { reply_to: comment.parentId } : {}),
										...(comment.editedAt ? { version: comment.editedAt.toISOString() } : {})
									}
								]
					),
					complete: whole
				};
			}
		};
		return connection;
	}
};
