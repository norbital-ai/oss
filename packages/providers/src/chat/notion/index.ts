// Notion, through its public API. A thread is a page, by its id. An event names a comment and the comment is read back,
// so one gone by then stores nothing. Notion's list of a page's comments takes no time and leaves out comments on the
// blocks inside the page, so what it lacks proves nothing, and there is no `history`.
//
// A subscription starts with one unsigned delivery of its verification token. The connection's page shows it, and a
// person pastes it into Notion, which rejects a forged one, and into `verificationToken` here.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';
/** The longest comment, cut from what Notion accepts in one; the rest follows in its discussion. */
const PIECES = /[\s\S]{1,1900}/gu;

type Comment = {
	readonly id: string;
	readonly discussion_id: string;
	readonly created_by: { readonly id: string; readonly name?: string };
	readonly created_time: string;
	readonly last_edited_time: string;
	readonly parent: { readonly page_id?: string };
	readonly rich_text: readonly {
		readonly plain_text: string;
		readonly mention?: { readonly user?: { readonly id: string } };
	}[];
	readonly attachments?: readonly {
		readonly category: string;
		readonly file: { readonly url: string };
	}[];
};
type Event = {
	readonly type: string;
	readonly timestamp: string;
	readonly entity: { readonly id: string };
	readonly data?: { readonly page_id?: string };
};

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
			const response = await host.fetch(`${API}${path}`, {
				...init,
				headers: {
					authorization: `Bearer ${token}`,
					'notion-version': VERSION,
					'content-type': 'application/json'
				}
			});
			if (response.ok) return response;
			const wait = Number(response.headers.get('retry-after'));
			throw new PlatformError(
				`${path} answered ${response.status}`,
				response.status,
				wait > 0 ? wait * 1000 : undefined
			);
		};
		const read = async (id: string) => {
			const response = await api(`/comments/${id}`).catch((error: unknown) => {
				if (error instanceof PlatformError && error.status === 404) return null;
				throw error;
			});
			return response === null ? null : ((await response.json()) as Comment);
		};
		const post = async (comment: object) =>
			(await (
				await api('/comments', { method: 'POST', body: JSON.stringify(comment) })
			).json()) as Comment;
		const download = async (url: string) => {
			const response = await host.fetch(url);
			if (!response.ok)
				throw new PlatformError(`a file answered ${response.status}`, response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const me = (await (await api('/users/me')).json()) as {
			readonly id: string;
			readonly name: string | null;
			readonly bot?: { readonly workspace_name?: string };
		};
		// a connection cannot be @-mentioned in Notion's composer, so a mention of it is usually only its name typed out
		const escaped = me.name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const named = escaped ? new RegExp(`(?<![\\w.-])@${escaped}(?![\\w-])`, 'i') : null;
		const parse = (comment: Comment, thread: string): Incoming => {
			const text = comment.rich_text.map((span) => span.plain_text).join('');
			return {
				id: comment.id,
				thread,
				sentAt: comment.created_time,
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
					const shown = (JSON.parse(body) as { readonly verification_token?: string }).verification_token;
					if (shown !== undefined) return { messages: [], about: { verificationToken: shown } };
				}
				// an HMAC under an empty key is one anybody can compute
				if (verificationToken === '') throw new Unverified('no verification token yet');
				signed(signature, `sha256=${hmac(verificationToken, body, 'hex')}`);
				const event = JSON.parse(body) as Event;
				if (event.type === 'comment.deleted')
					return {
						messages: [
							{
								id: event.entity.id,
								thread: event.data?.page_id ?? '',
								sentAt: event.timestamp,
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
