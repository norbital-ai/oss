// Liveblocks, through its Node SDK. A thread is a comment thread in a room: `room:thread`, a room id holding colons of
// its own. An event names a comment and the comment is read back. A thread reads back whole, which is its history.
import type { CommentBody, CommentData, WebhookEvent } from '@liveblocks/node';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

type Failed = Error & { readonly status?: number };

const parts = (thread: string) => {
	const at = thread.lastIndexOf(':');
	return { roomId: thread.slice(0, at), threadId: thread.slice(at + 1) };
};
const refused = (error: Failed): never => {
	throw error.status === undefined ? error : new PlatformError(error.message, error.status);
};
const plain = (body: CommentBody) =>
	body.content
		.map(({ children }) =>
			children
				.map((inline) =>
					inline.type === 'mention'
						? `@${inline.id}`
						: inline.type === 'link'
							? (inline.text ?? inline.url)
							: inline.text
				)
				.join('')
		)
		.join('\n');

export const liveblocks: ChatPlatform = {
	id: 'liveblocks',
	name: { en: 'Liveblocks', zh: 'Liveblocks' },
	description: { en: 'Room comment threads', zh: '房间评论串' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	guide: 'https://liveblocks.io/docs/platform/webhooks',
	fields: [
		{ name: 'secretKey', label: { en: 'Secret key', zh: '密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true },
		{ name: 'botUserId', label: { en: 'Bot user ID', zh: '机器人用户 ID' } }
	],
	async connect({ secretKey = '', webhookSecret = '', botUserId = '' }, host) {
		const { Liveblocks, WebhookHandler, markdownToCommentBody } = await import('@liveblocks/node');
		const client = new Liveblocks({ secret: secretKey }),
			webhooks = new WebhookHandler(webhookSecret);
		await client.getRooms({ limit: 1 });
		const download = async (roomId: string, attachmentId: string) => {
			const { url } = await client.getAttachment({ roomId, attachmentId });
			const response = await host.fetch(url);
			if (!response.ok)
				throw new PlatformError(`a file answered ${response.status}`, response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const parse = (comment: CommentData): Incoming => ({
			id: comment.id,
			thread: `${comment.roomId}:${comment.threadId}`,
			sent_at: comment.createdAt.toISOString(),
			from: { handle: comment.userId, name: null },
			group: true,
			...(comment.editedAt === undefined ? {} : { version: comment.editedAt.toISOString() }),
			...(comment.body === undefined
				? { text: '', deleted: true }
				: {
						text: plain(comment.body),
						mentioned: comment.body.content.some(({ children }) =>
							children.some(
								(inline) =>
									inline.type === 'mention' && inline.kind === 'user' && inline.id === botUserId
							)
						),
						files: comment.attachments.map(({ id, name, mimeType, size }) => ({
							name,
							mime: mimeType,
							bytes: size,
							fetch: () => download(comment.roomId, id)
						}))
					})
		});
		const connection: ChatConnection = {
			account: botUserId,
			async deliver(request, body) {
				let event: WebhookEvent;
				try {
					event = webhooks.verifyRequest({ headers: request.headers, rawBody: body });
				} catch {
					throw new Unverified('bad signature');
				}
				if (event.type === 'commentDeleted')
					return {
						messages: [
							{
								id: event.data.commentId,
								thread: `${event.data.roomId}:${event.data.threadId}`,
								sent_at: event.data.deletedAt,
								from: { handle: '', name: null },
								text: '',
								deleted: true
							}
						]
					};
				if (event.type !== 'commentCreated' && event.type !== 'commentEdited') return nothing();
				const comment = await client.getComment(event.data).catch((error: Failed) => {
					if (error.status === 404) return null;
					throw error;
				});
				return comment === null || comment.userId === botUserId
					? nothing()
					: { messages: [parse(comment)] };
			},
			async send(thread, text) {
				const comment = await client
					.createComment({
						...parts(thread),
						data: { userId: botUserId, body: markdownToCommentBody(text) }
					})
					.catch(refused);
				return { id: comment.id };
			},
			// one read of the whole thread: a comment it lacks is gone, and one it keeps as deleted says so
			async history(thread, since) {
				const { comments } = await client.getThread(parts(thread));
				const from = Date.parse(since);
				return {
					messages: comments
						.filter(({ userId, createdAt }) => userId !== botUserId && createdAt.getTime() >= from)
						.map(parse),
					complete: true
				};
			}
		};
		return connection;
	}
};
