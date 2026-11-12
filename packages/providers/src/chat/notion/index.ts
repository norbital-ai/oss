// Notion, through its public API. A thread is a page, by its id. An event names a comment and the comment is read back,
// so one gone by then stores nothing. Notion's list of a page's comments takes no time and leaves out comments on the
// blocks inside the page, so what it lacks proves nothing, and there is no `history`.
//
// A subscription starts with one unsigned delivery of its verification token. The connection's page shows it, and a
// person pastes it into Notion, which rejects a forged one, and into `verificationToken` here.
import { Schema } from 'effect';
import {
	parse as parseJson,
	json,
	download as downloadFile,
	request as requestHttp
} from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';
/** The longest comment, cut from what Notion accepts in one; the rest follows in its discussion. */
const PIECES = /[\s\S]{1,1900}/gu;

const Comment = Schema.Struct({
	id: Schema.String,
	discussion_id: Schema.String,
	created_by: Schema.Struct({
		id: Schema.String,
		name: Schema.optionalKey(Schema.String)
	}),
	created_time: Schema.String,
	last_edited_time: Schema.String,
	parent: Schema.Struct({
		page_id: Schema.optionalKey(Schema.String)
	}),
	rich_text: Schema.Array(
		Schema.Struct({
			plain_text: Schema.String,
			mention: Schema.optionalKey(
				Schema.Struct({
					user: Schema.optionalKey(
						Schema.Struct({
							id: Schema.String
						})
					)
				})
			)
		})
	),
	attachments: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				category: Schema.String,
				file: Schema.Struct({
					url: Schema.String
				})
			})
		)
	)
});
type Comment = typeof Comment.Type;
const Event = Schema.Struct({
	type: Schema.String,
	timestamp: Schema.String,
	entity: Schema.Struct({
		id: Schema.String
	}),
	data: Schema.optionalKey(
		Schema.Struct({
			page_id: Schema.optionalKey(Schema.String)
		})
	)
});

export const notion: ChatPlatform = {
	id: 'notion',
	name: { en: 'Notion', zh: 'Notion' },
	description: { en: 'Page and block comments', zh: '页面和块评论' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:notion',
	guide: 'https://developers.notion.com/reference/webhooks',
	fields: [
		{ name: 'token', label: { en: 'Integration token', zh: '集成令牌' }, secret: true },
		// optional: Notion sends it only to a webhook that is already connected
		{
			name: 'verificationToken',
			label: { en: 'Webhook verification token', zh: 'Webhook 验证令牌' },
			secret: true,
			optional: true
		}
	],
	async connect({ token = '', verificationToken = '' }, host) {
		const api = async (path: string, init: RequestInit = {}) => {
			return requestHttp(host.fetch, `${API}${path}`, {
				...init,
				headers: {
					authorization: `Bearer ${token}`,
					'notion-version': VERSION,
					'content-type': 'application/json'
				}
			});
		};
		const read = async (id: string) => {
			const response = await api(`/comments/${id}`).catch((error: unknown) => {
				if (error instanceof PlatformError && error.status === 404) return null;
				throw error;
			});
			return response === null ? null : await json(Comment, response);
		};
		const post = async (comment: object) =>
			await json(
				Schema.Struct({ id: Schema.String, discussion_id: Schema.String }),
				await api('/comments', { method: 'POST', body: JSON.stringify(comment) })
			);
		const download = (url: string) => downloadFile(host.fetch, url);
		const me = await json(
			Schema.Struct({
				id: Schema.String,
				name: Schema.Union([Schema.String, Schema.Null]),
				bot: Schema.optionalKey(
					Schema.Struct({
						workspace_name: Schema.optionalKey(Schema.String)
					})
				)
			}),
			await api('/users/me')
		);
		// a connection cannot be @-mentioned in Notion's composer, so a mention of it is usually only its name typed out
		const escaped = me.name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const named = escaped ? new RegExp(`(?<![\\w.-])@${escaped}(?![\\w-])`, 'i') : null;
		const parse = (comment: Comment, thread: string): Incoming => {
			const text = comment.rich_text.map((span) => span.plain_text).join('');
			return {
				id: comment.id,
				thread,
				sent_at: comment.created_time,
				from: { handle: comment.created_by.id, name: comment.created_by.name ?? null },
				text,
				group: true,
				mentioned:
					comment.rich_text.some((span) => span.mention?.user?.id === me.id) ||
					named?.test(text) === true,
				...(comment.last_edited_time > comment.created_time
					? { version: comment.last_edited_time }
					: {}),
				files: (comment.attachments ?? []).map(({ category, file }) => ({
					name: category,
					mime: 'application/octet-stream',
					fetch: () => download(file.url)
				}))
			};
		};
		const connection: ChatConnection = {
			account: me.bot?.workspace_name ?? me.name,
			async deliver(request, body) {
				const signature = request.headers.get('x-notion-signature');
				if (signature === null) {
					const shown = (
						await parseJson(
							Schema.Struct({
								verification_token: Schema.optionalKey(Schema.String)
							}),
							body
						)
					).verification_token;
					if (shown !== undefined) return { messages: [], about: { verificationToken: shown } };
				}
				// an HMAC under an empty key is one anybody can compute
				if (verificationToken === '') throw new Unverified('no verification token yet');
				signed(signature, `sha256=${hmac(verificationToken, body, 'hex')}`);
				const event = await parseJson(Event, body);
				if (event.type === 'comment.deleted')
					return {
						messages: [
							{
								id: event.entity.id,
								thread: event.data?.page_id ?? '',
								sent_at: event.timestamp,
								from: { handle: '', name: null },
								text: '',
								deleted: true
							}
						]
					};
				if (event.type !== 'comment.created' && event.type !== 'comment.updated') return nothing();
				const comment = await read(event.entity.id);
				if (comment === null || comment.created_by.id === me.id) return nothing();
				// ponytail: a block's comment with no `page_id` on its event fails here; walk `/blocks` up if Notion ever sends one
				const thread = event.data?.page_id ?? comment.parent.page_id;
				if (thread === undefined) throw new Error(`comment ${comment.id} names no page`);
				return { messages: [parse(comment, thread)] };
			},
			async send(thread, text) {
				const [head = '', ...rest] = text.match(PIECES) ?? [];
				const first = await post({ parent: { page_id: thread }, markdown: head });
				for (const markdown of rest) await post({ discussion_id: first.discussion_id, markdown });
				return { id: first.id };
			}
		};
		return connection;
	}
};
