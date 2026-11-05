// Mattermost, through its REST API and event socket: no Mattermost SDK is installed. Events arrive on the socket, which
// has no acknowledgement or replay: a store that refuses a post can only reconnect, and `history` finds what was missed.
// `deliver` refuses everything, since the server is never given a webhook.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { PlatformError, Unverified } from '../adapter.ts';

const PAGE = 200;
const PAGES = 10;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const PING_MS = 30_000,
	SILENT_MS = 90_000;
type Post = {
	readonly id: string;
	readonly channel_id: string;
	readonly root_id?: string;
	readonly user_id: string;
	readonly message: string;
	readonly type?: string;
	readonly create_at: number;
	readonly edit_at: number;
	readonly delete_at: number;
	readonly metadata?: {
		readonly files?: readonly {
			readonly id: string;
			readonly name: string;
			readonly mime_type?: string;
			readonly size?: number;
		}[];
	};
};
type Posts = { readonly order: readonly string[]; readonly posts: Readonly<Record<string, Post>> };
type Frame = {
	readonly seq_reply?: number;
	readonly status?: string;
	readonly event?: string;
	readonly data?: {
		readonly post?: string;
		readonly mentions?: string;
		readonly sender_name?: string;
		readonly channel_type?: string;
		readonly channel_display_name?: string;
	};
};

const threadOf = ({ channel_id, root_id }: Post) =>
	root_id ? `${channel_id}:${root_id}` : channel_id;
const inOrder = ({ order, posts }: Posts) => order.flatMap((id) => posts[id] ?? []);

export const mattermost: ChatPlatform = {
	id: 'mattermost',
	name: { en: 'Mattermost', zh: 'Mattermost' },
	description: { en: 'Mattermost posts and threads', zh: 'Mattermost 消息与主题' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:mattermost',
	guide: 'https://developers.mattermost.com/integrate/reference/bot-accounts/',
	fields: [
		{ name: 'baseUrl', label: { en: 'Server URL', zh: '服务器地址' } },
		{ name: 'botToken', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true }
	],
	async connect({ baseUrl = '', botToken = '' }, host) {
		const base = baseUrl.trim().replace(/\/+$/, '');
		const request = async (path: string, body?: unknown) => {
			const response = await host.fetch(`${base}/api/v4/${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${botToken}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			if (response.ok) return response;
			throw new PlatformError(`Mattermost answered ${response.status}`, response.status);
		};
		const api = async <A>(path: string, body?: unknown) =>
			(await (await request(path, body)).json()) as A;
		const me = await api<{ id: string; username: string }>('users/me');
		const named = new RegExp(`(^|\\s)@${me.username.replace(/\./g, '\\.')}\\b`, 'i');
		const parse = (post: Post, group: boolean, name: string | null = null): Incoming => ({
			id: post.id,
			thread: threadOf(post),
			sentAt: new Date(post.create_at).toISOString(),
			from: { handle: post.user_id, name },
			text: post.message,
			group,
			replyTo: post.root_id || null,
			...(post.edit_at > 0 ? { version: new Date(post.edit_at).toISOString() } : {}),
			files: (post.metadata?.files ?? []).map((file) => ({
				name: file.name,
				mime: file.mime_type ?? 'application/octet-stream',
				...(file.size === undefined ? {} : { bytes: file.size }),
				fetch: async () => new Uint8Array(await (await request(`files/${file.id}`)).arrayBuffer())
			}))
		});
		const skipped = (post: Post) =>
			post.user_id === me.id || post.type?.startsWith('system_') === true;
		const receive = async ({ event, data }: Frame) => {
			if (
				(event !== 'posted' && event !== 'post_edited' && event !== 'post_deleted') ||
				!data?.post
			)
				return;
			const post = JSON.parse(data.post) as Post,
				group = data.channel_type !== 'D';
			if (skipped(post) || (event !== 'post_deleted' && post.delete_at > 0)) return;
			const message = parse(post, group, data.sender_name?.replace(/^@/, '') ?? null);
			if (event === 'post_deleted') {
				await host.receive([{ ...message, text: '', deleted: true, files: [] }]);
				return;
			}
			const root =
				group && post.root_id ? await api<Post>(`posts/${post.root_id}`).catch(() => null) : null;
			await host.receive([
				{
					...message,
					mentioned: data.mentions?.includes(me.id) === true || named.test(post.message),
					repliedTo: root?.user_id === me.id,
					...(data.channel_display_name ? { title: data.channel_display_name } : {})
				}
			]);
		};
		let closed = false,
			attempt = 0,
			heard = Date.now(),
			socket: WebSocket | null = null,
			timer: ReturnType<typeof setTimeout> | undefined;
		const open = () => {
			const opened = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v4/websocket`);
			socket = opened;
			opened.addEventListener('open', () =>
				opened.send(
					JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: botToken } })
				)
			);
			opened.addEventListener('message', ({ data }) => {
				heard = Date.now();
				const work = async () => {
					const frame = JSON.parse(String(data)) as Frame;
					if (frame.seq_reply === 1) {
						if (frame.status !== 'OK') throw new Error('Mattermost refused the socket');
						attempt = 0;
					} else await receive(frame);
				};
				work().catch(() => opened.close());
			});
			// a connection that fails closes too
			opened.addEventListener('close', () => {
				if (closed) return;
				const wait = BACKOFF_MS * 2 ** attempt++ + Math.random() * BACKOFF_MS;
				timer = setTimeout(open, Math.min(wait, BACKOFF_MAX_MS));
			});
		};
		open();
		// a socket that silently died sends no `close`: only a ping that goes unanswered shows it
		const heartbeat = setInterval(() => {
			if (Date.now() - heard > SILENT_MS) socket?.close();
			else if (socket?.readyState === WebSocket.OPEN)
				socket.send(JSON.stringify({ seq: 2, action: 'ping' }));
		}, PING_MS);
		const connection: ChatConnection = {
			account: me.username,
			deliver() {
				return Promise.reject(new Unverified('Mattermost delivers over its socket'));
			},
			// no dedupe key in what the source shows, so a send is not idempotent
			async send(thread, text) {
				const [channel_id, root_id] = thread.split(':');
				const sent = await api<{ id: string }>('posts', { channel_id, root_id, message: text });
				return { id: sent.id };
			},
			async typing(thread, on) {
				const [channel_id, parent_id] = thread.split(':');
				if (on) await request(`users/${me.id}/typing`, { channel_id, parent_id });
			},
			async openDirect(user) {
				return (await api<{ id: string }>('channels/direct', [me.id, user])).id;
			},
			// a thread comes whole; a channel comes newest first, so a page older than `since` ends it
			async history(thread, since) {
				const [channel = '', root] = thread.split(':');
				const from = Date.parse(since);
				const { type } = await api<{ type: string }>(`channels/${channel}`);
				const read = (posts: readonly Post[]) =>
					posts
						.filter((post) => post.create_at >= from && !skipped(post) && threadOf(post) === thread)
						.map((post) => parse(post, type !== 'D'));
				if (root !== undefined)
					return {
						messages: read(inOrder(await api<Posts>(`posts/${root}/thread`))),
						complete: true
					};
				const messages: Incoming[] = [];
				for (let page = 0; page < PAGES; page++) {
					const query = new URLSearchParams({
						page: String(page),
						per_page: String(PAGE),
						skipFetchThreads: 'true'
					});
					const posts = inOrder(await api<Posts>(`channels/${channel}/posts?${query}`));
					messages.push(...read(posts));
					const oldest = posts.at(-1);
					if (oldest === undefined || posts.length < PAGE || oldest.create_at < from)
						return { messages, complete: true };
				}
				return { messages, complete: false };
			},
			async close() {
				closed = true;
				clearInterval(heartbeat);
				clearTimeout(timer);
				socket?.close();
			}
		};
		return connection;
	}
};
