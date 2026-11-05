// GitLab, through its REST API. A thread is a merge request or an issue, named by its API path: `42/merge_requests/7` or
// `42/issues/7`. Its comment hook carries new and edited notes and no deleted one, so a delete shows only as an id gone
// from `history`. A note says its discussion and not what it answers, so no `replyTo`; files are links in its markdown.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, same } from '../verify.ts';

const API = 'https://gitlab.com/api/v4';
const THREAD = /^\d+\/(merge_requests|issues)\/\d+$/;
const SIGNING_KEY = /^[A-Za-z0-9+/]{43}=$/;
const TOLERANCE_S = 5 * 60;

type Written = {
	readonly id: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly system?: boolean;
	readonly internal?: boolean;
	readonly confidential?: boolean;
};
type User = { readonly id: number; readonly name: string };
type Note = Written & { readonly body: string; readonly author: User };
type Hook = {
	readonly event_type?: string;
	readonly project_id?: number;
	readonly project: { readonly id: number };
	readonly user: User;
	readonly object_attributes: Written & {
		readonly note: string;
		readonly noteable_type: string;
		readonly action?: 'create' | 'update';
	};
	readonly merge_request?: { readonly iid: number; readonly title: string };
	readonly issue?: {
		readonly iid: number;
		readonly title: string;
		readonly confidential?: boolean;
	};
};

/** Standard Webhooks: an HMAC of `id.timestamp.body` under the decoded key, its timestamp recent. */
const verify = (headers: Headers, body: string, key: Buffer) => {
	const id = headers.get('webhook-id'),
		at = headers.get('webhook-timestamp'),
		want = `v1,${hmac(key, `${id}.${at}.${body}`, 'base64')}`;
	const fresh = Math.abs(Date.now() / 1000 - Number(at)) <= TOLERANCE_S;
	if (
		id === null ||
		!fresh ||
		!headers
			.get('webhook-signature')
			?.split(' ')
			.some((one) => same(one, want))
	)
		throw new Unverified('bad signature');
};
/** A system note is GitLab's own, and an internal one is not for a bot to repeat. */
const hidden = (note: Written) =>
	note.system === true || note.internal === true || note.confidential === true;
/** What a person wrote themselves: a mention in code or a quote invokes nobody. */
const prose = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`|^>.*$/gm, '');
const instant = (at: string) => new Date(at).toISOString();

export const gitlab: ChatPlatform = {
	id: 'gitlab',
	name: { en: 'GitLab', zh: 'GitLab' },
	description: { en: 'Merge request and issue comments', zh: '合并请求和议题评论' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:gitlab',
	guide: 'https://docs.gitlab.com/user/project/integrations/webhooks/',
	fields: [
		{ name: 'token', label: { en: 'Access token', zh: '访问令牌' }, secret: true },
		{
			name: 'webhookSigningToken',
			label: { en: 'Webhook signing token (whsec_…)', zh: 'Webhook 签名令牌 (whsec_…)' },
			secret: true
		}
	],
	async connect({ token = '', webhookSigningToken = '' }, host) {
		const encoded = webhookSigningToken.replace(/^whsec_/, '');
		if (!SIGNING_KEY.test(encoded)) throw new Error('that is not a GitLab webhook signing token');
		const key = Buffer.from(encoded, 'base64');
		const call = async (path: string, init: RequestInit = {}) => {
			const response = await host.fetch(`${API}${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
			});
			if (response.ok) return response;
			const wait = Number(response.headers.get('retry-after'));
			throw new PlatformError(
				`${path} answered ${response.status}`,
				response.status,
				wait > 0 ? wait * 1000 : undefined
			);
		};
		const notes = (thread: string) => {
			if (!THREAD.test(thread)) throw new PlatformError(`not a GitLab thread: ${thread}`, 400);
			return `/projects/${thread}/notes`;
		};
		const me = (await (await call('/user')).json()) as {
			readonly id: number;
			readonly username: string;
		};
		const named = new RegExp(`(?<![\\w.-])@${me.username.replaceAll('.', '\\.')}(?![\\w-])`, 'i');
		const parse = (note: Written, text: string, from: User, thread: string): Incoming => ({
			id: String(note.id),
			thread,
			sentAt: instant(note.created_at),
			from: { handle: String(from.id), name: from.name },
			text,
			group: true,
			mentioned: named.test(prose(text)),
			...(note.updated_at === note.created_at ? {} : { version: instant(note.updated_at) })
		});
		const connection: ChatConnection = {
			account: me.username,
			async deliver(request, body) {
				verify(request.headers, body, key);
				if (request.headers.get('x-gitlab-event') !== 'Note Hook') return nothing();
				const hook = JSON.parse(body) as Hook;
				const attributes = hook.object_attributes;
				const mergeRequest = attributes.noteable_type === 'MergeRequest';
				const on = mergeRequest
					? hook.merge_request
					: attributes.noteable_type === 'Issue'
						? hook.issue
						: undefined;
				if (
					on === undefined ||
					hidden(attributes) ||
					hook.issue?.confidential === true ||
					hook.event_type === 'confidential_note' ||
					hook.user.id === me.id
				)
					return nothing();
				const project = hook.project_id ?? hook.project.id;
				const thread = `${project}/${mergeRequest ? 'merge_requests' : 'issues'}/${on.iid}`;
				return {
					messages: [{ ...parse(attributes, attributes.note, hook.user, thread), title: on.title }]
				};
			},
			async send(thread, text) {
				const response = await call(notes(thread), {
					method: 'POST',
					body: JSON.stringify({ body: text })
				});
				return { id: String(((await response.json()) as Note).id) };
			},
			// the newest page, which is what a missed note most likely is. One response is one read, and page numbers shift
			// under a delete, so what it lacks proves a delete only when it reaches past `since` or holds the whole thread
			async history(thread, since) {
				const response = await call(`${notes(thread)}?order_by=created_at&sort=desc&per_page=100`);
				const page = (await response.json()) as readonly Note[];
				const window = page.filter((note) => Date.parse(note.created_at) >= Date.parse(since));
				return {
					messages: window
						.filter((note) => !hidden(note) && note.author.id !== me.id)
						.map((note) => parse(note, note.body, note.author, thread))
						.reverse(),
					complete: window.length < page.length || !response.headers.get('x-next-page')
				};
			}
		};
		return connection;
	}
};
