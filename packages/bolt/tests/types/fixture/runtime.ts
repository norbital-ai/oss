import { install } from '../../../src/decl/runtime/guest.ts';
install();
import { Effect, Result } from 'effect';
import { Instant } from '@norbital-ai/std/date';
// The runtime roles of the type corpus workspace: what a template puts in +workspace.ts, src/integration,
// src/automation, src/agent and collection-local pipelines.
import {
	automation,
	envoy,
	integration,
	mcp,
	pipeline,
	secrets,
	workspace
} from '../../../src/index.ts';
import type { DeliveryEvent, Row } from '../../../src/index.ts';

export const secretNames = secrets({
	ERP_URL: { label: 'ERP base URL' },
	ERP_TOKEN: { label: 'ERP API token' },
	MCP_URL: { label: 'Docs MCP server' },
	HOOK_SECRET: { label: 'Webhook signing secret', description: 'Signs inbound webhooks.' },
	CALENDAR_CLIENT: { label: 'Calendar OAuth client' },
	CALENDAR_SECRET: { label: 'Calendar OAuth secret' }
});

export const ws = workspace({
	tz: 'Asia/Singapore',
	locale: 'en-SG',
	currency: 'SGD',
	apps: ['sales', 'portal'],
	ai: { models: ['default', 'fast', 'strong'], default: 'default', embeddings: ['text_small'] },
	convert: { to: ['pdf', 'docx'] },
	csp: { connect: ['https://huggingface.co'] },
	connections: {
		erp: { integration: 'erp' },
		ledger_main: { integration: 'kingdee' },
		support: { integration: 'support_mail' },
		whatsapp: { integration: 'whatsapp', envoy: 'desk' },
		chat: { integration: 'company_chat' }
	}
});

export const desk = envoy({
	name: 'Norbius',
	audience: 'private',
	policies: ['sales_rep'],
	groupMessages: 'mention_or_reply',
	delegation: 'disabled',
	task: 'Keep orders up to date from what people report.'
});

// plain HTTP: a credential sealed at pairing, the base URL a literal
export const erp = integration('erp', {
	description: 'The ERP API.',
	driver: 'http',
	credential: { token: { kind: 'text', label: 'API token' } },
	http: { baseUrl: 'https://erp.example.com/api/', auth: { bearer: 'token' } }
});
erp.test(function* (ctx) {
	yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
});

// a database: a pulled feed into a keyed collection and a command for confirmed orders
export const kingdee = integration('kingdee', {
	description: 'An accounting database.',
	driver: 'sqlserver',
	credential: { connection: { kind: 'text', label: 'Connection string' } },
	configuration: {
		maxLagMinutes: { kind: 'int', min: 1, default: 15 },
		databases: { kind: 'text', many: true, default: [] }
	},
	feeds: {
		products: {
			into: 'products',
			key: ['external_code'],
			cron: '*/15 * * * *',
			removed: { active: false }
		}
	},
	outbound: {
		orders: {
			from: 'orders',
			on: 'update',
			when: { status: { eq: 'ordered' } },
			via: 'ledger',
			version: 'number'
		}
	}
});
kingdee.feed('products', {
	read: function* (cursor, ctx) {
		const { rows } = yield* ctx.request({
			statement: 'SELECT code, name FROM products',
			parameters: {}
		});
		return {
			changes: rows.map((r) => ({
				upsert: { external_code: String(r['code']), name: String(r['name']) }
			})),
			cursor,
			more: false
		};
	}
});
kingdee.outbound('orders', {
	build: (order) => ({ reference: order.number, note: order.note }),
	run: function* (payload, ctx) {
		yield* ctx.request({
			statement: 'EXEC submit @key, @reference',
			parameters: { key: ctx.key, reference: payload.reference }
		});
		return { id: ctx.key };
	}
});

// a mailbox: its messages mirrored into notices, and order confirmations sent with their delivery reports
export const support_mail = integration('support_mail', {
	description: 'The support mailbox.',
	driver: 'email',
	feeds: { notices: { into: 'notices', from: 'messages', key: ['message_id'] } },
	outbound: { confirmations: { from: 'orders', via: 'support' } }
});
support_mail.feed('notices', {
	map: function* (mails) {
		return mails.map((mail) =>
			mail.deleted
				? { delete: { message_id: mail.id } }
				: {
						upsert: {
							message_id: mail.id,
							subject: mail.subject || '(no subject)',
							received_at: mail.sentAt
						}
					}
		);
	}
});
export const confirmationBuild = (order: Pick<Row<'orders'>, 'number' | 'note' | 'id'>) => ({
	to: ['sales@example.com'],
	subject: `Order ${order.number}`,
	text: order.note ?? '',
	thread: order.id
});
export const confirmationBounced = ({ reason }: DeliveryEvent<'bounced', 'email'>) => ({
	note: reason
});
support_mail.outbound('confirmations', {
	build: confirmationBuild,
	events: {
		sent: ({ at }) => ({ placed_at: at }),
		bounced: confirmationBounced,
		replied: ({ reply }) => ({ note: reply.text.slice(0, 200) })
	}
});

// a custom chat: messages by signed webhook, replies posted to its API
export const company_chat = integration('company_chat', {
	description: 'A chat bot account.',
	driver: 'http',
	configuration: {
		baseUrl: { kind: 'text', format: 'url' },
		room: { kind: 'text', default: 'general' },
		topic: { kind: 'text', optional: true },
		mute: { kind: 'bool', optional: true, default: false }
	},
	credential: { token: { kind: 'text' }, signingSecret: { kind: 'text' } },
	http: { baseUrl: 'baseUrl', auth: { bearer: 'token' } },
	webhook: { scheme: 'hmac-sha256', secret: 'signingSecret' },
	conversation: { kind: 'chat', handle: 'phone' }
});
company_chat.receive(function* ({ body }) {
	return {
		messages: [
			{
				id: String(body),
				thread: 'room',
				sentAt: Instant('2026-10-14T00:00:00Z'),
				from: { handle: '+6590000000' },
				text: 'hi'
			}
		]
	};
});
company_chat.send(function* (message, ctx) {
	const sent = yield* ctx.request({
		method: 'POST',
		path: `rooms/${message.thread ?? ''}`,
		body: { text: message.text },
		headers: { 'Idempotency-Key': ctx.key },
		output: { kind: 'object', fields: { id: { kind: 'text' } } }
	});
	return { id: sent.id };
});

// a member's calendar: a driver feed with one cursor per chosen calendar
export const calendar = integration('calendar', {
	description: "A member's calendar.",
	driver: 'calendar',
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' },
	configuration: { calendars: { kind: 'text', many: true, default: [] } },
	feeds: {
		entries: {
			into: 'entries',
			from: 'driver',
			key: ['calendar_id', 'external_id'],
			partitions: 'calendars',
			removed: { event_status: 'cancelled' }
		}
	}
});
calendar.feed('entries', {
	map: function* (events, ctx) {
		return events.map((e) => ({
			upsert: {
				calendar_id: ctx.partition ?? '',
				external_id: e.id,
				subject: e.summary ?? '(untitled)',
				event_status: e.status
			}
		}));
	}
});

export const erp_mcp = mcp({
	description: 'Product documentation',
	url: 'MCP_URL',
	tools: ['search_docs']
});

export const nightly = automation({
	description: 'Nightly order digest',
	runAs: ['sales_rep'],
	on: { cron: '0 2 * * *' },
	output: { kind: 'int' }
});
nightly.run(function* (_, ctx) {
	const open = yield* ctx.read('orders', {
		where: { status: { eq: 'submitted' } },
		select: { number: true },
		all: true
	});
	return open.rows.length;
});

export const follow_up = automation({
	description: 'Chase an order three days after it is placed',
	runAs: ['sales_rep'],
	on: [
		{ created: 'orders', delay: '3d', where: { status: { eq: 'draft' } } },
		{ updated: 'orders', fields: ['status', 'total'] }
	],
	retry: { attempts: 3, backoff: '1min' },
	concurrency: { max: 1 }
});
follow_up.run(function* ({ ids }, ctx) {
	const orders = yield* ctx.read('orders', {
		where: { id: { in: ids } },
		select: { number: true, owner: true },
		all: true
	});
	for (const o of orders.rows)
		if (o.owner !== null)
			yield* ctx.notify({
				to: { user: o.owner },
				title: `Order ${o.number} is still open`,
				link: { collection: 'orders', id: o.id }
			});
	yield* ctx.schedule('follow_up', {}, { at: { now: '+1d' }, key: 'chase' });
});

export const render = automation({
	description: 'Render an order confirmation',
	runAs: 'trigger',
	input: { order: { kind: 'id', of: 'orders' } },
	output: { kind: 'file', accept: ['application/pdf'], max: '5MiB' }
});
render.run(function* ({ order }, ctx) {
	const o = yield* ctx.get('orders', order, { select: { number: true } });
	return yield* ctx.convert.document(
		{ markdown: `# Order ${o?.number ?? ''}` },
		{ to: 'pdf', page: 'A4', name: 'order.pdf', for: 'render' }
	);
});

export const inbound_hook = automation({
	description: 'Payment provider callback',
	runAs: ['sales_rep'],
	on: { webhook: '/payments', verify: { scheme: 'stripe', secret: 'HOOK_SECRET' } },
	input: { order: { kind: 'text' } }
});
inbound_hook.run(function* ({ order }, ctx) {
	const answer = yield* Effect.result(
		ctx.request('erp', {
			method: 'GET',
			path: 'orders',
			query: { order },
			output: { kind: 'object', fields: { paid: { kind: 'bool' } } }
		})
	);
	if (Result.isFailure(answer)) return;
	if (answer.success.paid)
		yield* ctx.send('whatsapp', { to: '+6590000000', text: `Order ${order} is paid` });
});

export const orders_pipeline = pipeline('orders', {
	import: {
		description: 'Orders from a CSV',
		input: {
			rows: {
				kind: 'list',
				of: {
					kind: 'object',
					fields: { customer: { kind: 'id', of: 'customers' }, note: { kind: 'text' } }
				}
			}
		},
		records: ({ rows }) => rows,
		map: (r) => ({ customer: r.customer, note: r.note })
	},
	export: {
		description: 'Open orders',
		select: ['number', 'status', 'total'],
		where: { status: { ne: 'ordered' } },
		format: 'csv'
	}
});
