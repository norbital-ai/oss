// GitHub, through its REST API with Octokit. A thread is an issue or a pull request, named as on github.com:
// `owner/repo/issues/1` or `owner/repo/pull/1`. Files are links in a comment's markdown, so none are parsed. GitHub
// reports a deleted comment by webhook; a missed one shows only as an id gone from `history`.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

type Comment = {
	readonly id: number;
	readonly body?: string | undefined;
	readonly user: { readonly id: number; readonly login: string } | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly in_reply_to_id?: number | undefined;
};
type Hook = {
	readonly action: string;
	readonly comment: Comment;
	readonly repository: { readonly full_name: string };
	readonly issue?: {
		readonly number: number;
		readonly title: string;
		readonly pull_request?: object;
	};
	readonly pull_request?: { readonly number: number; readonly title: string };
};
type Failed = Error & {
	readonly status?: number;
	readonly response?: { readonly headers: { readonly 'retry-after'?: string } };
};

const parts = (thread: string) => {
	const [owner = '', repo = '', kind, number = ''] = thread.split('/');
	if ((kind !== 'issues' && kind !== 'pull') || !/^\d+$/.test(number))
		throw new PlatformError(`not a GitHub thread: ${thread}`, 400);
	return { owner, repo, kind, number: Number(number) };
};
/** A refusal naming when to return is a rate limit, whatever its status says: GitHub answers 403 to some. */
const refused = (error: Failed): never => {
	if (error.status === undefined) throw error;
	const wait = error.response?.headers['retry-after'];
	throw wait === undefined
		? new PlatformError(error.message, error.status)
		: new PlatformError(error.message, 429, Number(wait) * 1000);
};
/** What a person wrote themselves: a mention in code or a quote invokes nobody. */
const prose = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`|^>.*$/gm, '');

export const github: ChatPlatform = {
	id: 'github',
	name: { en: 'GitHub', zh: 'GitHub' },
	description: { en: 'Pull request and issue comments', zh: '拉取请求和议题评论' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:github',
	guide: 'https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks',
	fields: [
		{ name: 'token', label: { en: 'Personal access token', zh: '个人访问令牌' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ token = '', webhookSecret = '' }, host) {
		const { Octokit } = await import('@octokit/rest');
		const octokit = new Octokit({ auth: token, request: { fetch: host.fetch } });
		const { data: me } = await octokit.users.getAuthenticated();
		const named = new RegExp(`(?<![\\w-])@${me.login}(?![\\w-])`, 'i');
		// a review comment's id is from another sequence than an issue comment's, and ids dedupe across both
		const parse = (comment: Comment, thread: string, review: boolean): Incoming => ({
			id: review ? `review:${comment.id}` : String(comment.id),
			thread,
			sentAt: comment.created_at,
			from: { handle: String(comment.user?.id ?? ''), name: comment.user?.login ?? null },
			text: comment.body ?? '',
			group: true,
			mentioned: named.test(prose(comment.body ?? '')),
			...(comment.in_reply_to_id === undefined
				? {}
				: { replyTo: `review:${comment.in_reply_to_id}` }),
			...(comment.updated_at === comment.created_at ? {} : { version: comment.updated_at })
		});
		const others = (comment: Comment) => comment.user?.id !== me.id;
		const connection: ChatConnection = {
			account: me.login,
			async deliver(request, body) {
				signed(
					request.headers.get('x-hub-signature-256'),
					`sha256=${hmac(webhookSecret, body, 'hex')}`
				);
				const event = request.headers.get('x-github-event');
				if (event !== 'issue_comment' && event !== 'pull_request_review_comment') return nothing();
				const { action, comment, issue, pull_request, repository } = JSON.parse(body) as Hook;
				const on = issue ?? pull_request;
				if (!['created', 'edited', 'deleted'].includes(action) || on === undefined)
					return nothing();
				if (!others(comment)) return nothing();
				const kind = issue !== undefined && issue.pull_request === undefined ? 'issues' : 'pull';
				const thread = `${repository.full_name}/${kind}/${on.number}`;
				const message = parse(comment, thread, event === 'pull_request_review_comment');
				return {
					messages: [
						{
							...message,
							title: on.title,
							...(action === 'deleted' ? { text: '', deleted: true } : {})
						}
					]
				};
			},
			async send(thread, text) {
				const { owner, repo, number } = parts(thread);
				const { data } = await octokit.issues
					.createComment({ owner, repo, issue_number: number, body: text })
					.catch(refused);
				return { id: String(data.id) };
			},
			async history(thread, since) {
				const { owner, repo, kind, number } = parts(thread);
				// `since` excludes the instant and a comment's time is whole seconds: start a second early to keep it
				const start = new Date(Date.parse(since) - 1000).toISOString().replace(/\.\d+/, '');
				const window = { owner, repo, since: start, per_page: 100 };
				let pages = 0;
				const rows = <A>({ data }: { readonly data: A[] }) => {
					pages += 1;
					return data;
				};
				const said = await octokit.paginate(
					octokit.issues.listComments,
					{ ...window, issue_number: number },
					rows
				);
				const reviewed =
					kind === 'pull'
						? await octokit.paginate(
								octokit.pulls.listReviewComments,
								{ ...window, pull_number: number },
								rows
							)
						: [];
				return {
					messages: [
						...said.filter(others).map((comment) => parse(comment, thread, false)),
						...reviewed.filter(others).map((comment) => parse(comment, thread, true))
					],
					// a comment made in the window was updated in it, so the listing covers it. One response is one read; page
					// numbers shift under a delete between two reads, so a longer listing proves nothing about what it lacks
					complete: pages === (kind === 'pull' ? 2 : 1)
				};
			}
		};
		return connection;
	}
};
