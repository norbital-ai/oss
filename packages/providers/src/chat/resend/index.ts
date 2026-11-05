// Resend, through its Inboxes API with Resend's own SDK. An inbox keeps threads: Resend threads a reply itself, so no
// message-id map of ours exists, and a thread can be read back. Receiving alone keeps neither, so it is not offered. The
// inbox API names no way to read an attachment's bytes, so a file arrives as its name and size.
import type { InboxMessage, Response as Answer } from 'resend';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

// ponytail: entities stay encoded in an HTML-only email; html-to-text if they matter
const TAGS = /<(style|script)\b[\s\S]*?<\/\1>|<[^>]+>/gi;

const person = (from: string) => {
	const named = /^(.*)<([^<>]+)>\s*$/.exec(from);
	return {
		handle: (named?.[2] ?? from).trim().toLowerCase(),
		name: named?.[1]?.trim().replace(/^"|"$/g, '') || null
	};
};
const handles = (list: readonly string[]) => list.map((one) => person(one).handle);
/** The answer, or the platform's refusal; no status means the call never landed, which a send may retry. */
const answered = async <A>(call: Promise<Answer<A>>) => {
	const { data, error, headers } = await call;
	if (error === null) return data;
	if (error.statusCode === null) throw new Error(error.message);
	throw new PlatformError(
		error.message,
		error.statusCode,
		Number(headers?.['retry-after'] ?? Number.NaN) * 1000 || undefined
	);
};

export const resend: ChatPlatform = {
	id: 'resend',
	name: { en: 'Resend', zh: 'Resend' },
	description: { en: 'A Resend inbox, as conversations', zh: '以会话形式使用 Resend 收件箱' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	idempotent: true,
	icon: 'simple-icons:resend',
	guide: 'https://resend.com/docs/api-reference/inboxes/create-inbox',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{
			name: 'webhookSecret',
			label: { en: 'Webhook signing secret', zh: 'Webhook 签名密钥' },
			secret: true
		},
		{ name: 'inbox', label: { en: 'Inbox ID or address', zh: '收件箱 ID 或地址' } }
	],
	async connect({ apiKey = '', webhookSecret = '', inbox = '' }) {
		const { Resend } = await import('resend');
		const client = new Resend(apiKey);
		const box = await answered(client.inboxes.get(inbox));
		const account = box.email_address.toLowerCase();
		const own = (email: InboxMessage) =>
			email.direction !== 'inbound' || person(email.from).handle === account;
		const parse = (email: InboxMessage, thread: string): Incoming => {
			const to = handles(email.to);
			return {
				id: email.id,
				thread,
				sentAt: new Date(email.received_at).toISOString(),
				from: person(email.from),
				text: (email.text || (email.html ?? '').replace(TAGS, '')).trim(),
				group: [...to, ...handles(email.cc)].some((one) => one !== account),
				mentioned: to.includes(account),
				...(email.subject ? { title: email.subject } : {}),
				files: email.attachments.map((file) => ({
					name: file.filename ?? 'attachment',
					mime: 'application/octet-stream',
					...(file.size === null ? {} : { bytes: file.size })
				}))
			};
		};
		/** A thread's emails, oldest first. */
		const emails = async (threadId: string) => {
			const found: InboxMessage[] = [];
			for (let after: string | undefined; ;) {
				const page = await answered(
					client.inboxes.threads.emails.list({
						inboxId: box.id,
						threadId,
						limit: 100,
						...(after === undefined ? {} : { after })
					})
				);
				found.push(...page.data);
				after = page.data.at(-1)?.id;
				if (!page.has_more || after === undefined) return found;
			}
		};
		const connection: ChatConnection = {
			account,
			async deliver(request, body) {
				const header = (name: string) => request.headers.get(name) ?? '';
				const verified = () => {
					try {
						return client.webhooks.verify({
							payload: body,
							headers: {
								id: header('svix-id'),
								timestamp: header('svix-timestamp'),
								signature: header('svix-signature')
							},
							webhookSecret
						});
					} catch {
						throw new Unverified('bad signature');
					}
				};
				const event = verified();
				if (event.type !== 'inbox.email.received' || event.data.inbox_id !== box.id)
					return nothing();
				const { thread_id: threadId, email_id: emailId } = event.data;
				const email = await answered(
					client.inboxes.threads.emails.get({ inboxId: box.id, threadId, emailId })
				);
				return own(email) ? nothing() : { messages: [parse(email, threadId)] };
			},
			// Resend dedupes on the idempotency key, so a resend after an unknown outcome is safe. A thread with an @ is an
			// address, for a first message: that one goes out from the inbox's address but is not an inbox thread until answered
			async send(thread, text, key, files) {
				const attachments =
					files.length === 0
						? {}
						: {
								attachments: files.map((file) => ({
									filename: file.name,
									contentType: file.mime,
									content: Buffer.from(file.bytes)
								}))
							};
				if (thread.includes('@')) {
					const sent = await answered(
						client.emails.send(
							{
								from: box.from_name === null ? account : `${box.from_name} <${account}>`,
								to: thread,
								subject: text.slice(0, 78).split('\n')[0] ?? '',
								text,
								...attachments
							},
							{ idempotencyKey: key }
						)
					);
					return { id: sent.id };
				}
				const all = await emails(thread);
				const last = all.findLast((email) => !own(email)) ?? all.at(-1);
				if (last === undefined) throw new PlatformError('This Resend thread has no email', 404);
				const sent = await answered(
					client.inboxes.threads.emails.reply(
						{ inboxId: box.id, threadId: thread, emailId: last.id, text, ...attachments },
						{ idempotencyKey: key }
					)
				);
				return { id: sent.id };
			},
			// every email of the thread is read, so this is the whole window; a thread Resend no longer has is an empty one
			async history(thread, since) {
				const all = await emails(thread).catch((error: unknown) => {
					if (error instanceof PlatformError && error.status === 404) return [];
					throw error;
				});
				const from = Date.parse(since);
				return {
					messages: all
						.filter((email) => !own(email) && Date.parse(email.received_at) >= from)
						.map((email) => parse(email, thread)),
					complete: true
				};
			}
		};
		return connection;
	}
};
