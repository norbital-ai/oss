// The runtime roles of the type corpus workspace: what a template puts in +workspace.ts, src/channel, src/connection,
// src/automation, src/agent and the collections' +integration.ts / +pipeline.ts files.
import { automation, channel, connection, envoy, integration, mcp, pipeline, workspace } from '../../../src/index.ts';

export const ws = workspace({
	tz: 'Asia/Singapore', locale: 'en-SG', currency: 'SGD', apps: ['sales', 'portal'],
	env: {
		ERP_URL: { label: 'ERP base URL', secret: false, default: 'https://erp.example.com/api' },
		ERP_TOKEN: { label: 'ERP API token' },
		MCP_URL: { label: 'Docs MCP server', secret: false },
		HOOK_SECRET: { label: 'Webhook signing secret', secret: true },
	},
	ai: { models: ['default', 'fast', 'strong'], default: 'default', embeddings: ['text_small'] },
	csp: { connect: ['https://huggingface.co'] },
});

export const support = channel({
	transport: 'email', address: 'support', policies: ['sales_rep'],
	outbound: { confirmations: { from: 'orders', on: 'create',
		message: ({ record }) => ({ to: ['sales@example.com'], subject: `Order ${record.number}`, text: record.note ?? '', thread: record.id }) } },
	events: {
		sent: ({ at }) => ({ placed_at: at }),
		bounced: ({ reason }) => ({ note: reason }),
		replied: ({ mail }) => ({ note: mail.text.slice(0, 200) }),
	},
});
export const whatsapp = channel({ transport: 'whatsapp', policies: ['sales_rep'] });

export const erp = connection({ baseUrl: 'ERP_URL', auth: { bearer: 'ERP_TOKEN' } });
export const erp_mcp = mcp({ description: 'Product documentation', url: 'MCP_URL', tools: ['search_docs'] });

export const desk = envoy({ channel: 'whatsapp', audience: 'authenticated', policies: ['sales_rep'],
	groupMessages: 'mention_or_reply', delegation: 'disabled', task: 'Keep orders up to date from what people report.' });

export const nightly = automation({ description: 'Nightly order digest', runAs: ['sales_rep'], on: { cron: '0 2 * * *' },
	output: { kind: 'int' } });
nightly.run(async (_, ctx) => {
	const open = await ctx.read('orders', { where: { status: { eq: 'submitted' } }, select: { number: true }, all: true });
	return open.rows.length;
});

export const follow_up = automation({ description: 'Chase an order three days after it is placed', runAs: ['sales_rep'],
	on: [{ created: 'orders', delay: '3d', where: { status: { eq: 'draft' } } }, { updated: 'orders', fields: ['status', 'total'] }],
	retry: { attempts: 3, backoff: '1min' }, concurrency: { max: 1 } });
follow_up.run(async ({ ids }, ctx) => {
	const orders = await ctx.read('orders', { where: { id: { in: ids } }, select: { number: true, owner: true }, all: true });
	for (const o of orders.rows)
		if (o.owner !== null) await ctx.notify({ to: { user: o.owner }, title: `Order ${o.number} is still open`, link: { collection: 'orders', id: o.id } });
	await ctx.schedule('follow_up', {}, { at: { now: '+1d' }, key: 'chase' });
});

export const render = automation({ description: 'Render an order confirmation', runAs: 'trigger',
	input: { order: { kind: 'id', of: 'orders' } }, output: { kind: 'file', accept: ['application/pdf'], max: '5MiB' } });
render.run(async ({ order }, ctx) => {
	const o = await ctx.get('orders', order, { select: { number: true } });
	return ctx.files.pdf({ page: 'A4', blocks: [{ text: `Order ${o?.number ?? ''}`, bold: true }] }, { name: 'order.pdf', for: 'render' });
});

export const inbound_hook = automation({ description: 'Payment provider callback', runAs: ['sales_rep'],
	on: { webhook: '/payments', verify: { scheme: 'stripe', secret: 'HOOK_SECRET' } }, input: { order: { kind: 'text' } } });
inbound_hook.run(async ({ order }, ctx) => {
	const answer = await ctx.http('erp').get.try('/orders', { query: { order }, output: { kind: 'object', fields: { paid: { kind: 'bool' } } } });
	if ('kind' in answer) return;
	if (answer.paid) await ctx.send('whatsapp', { to: '+6590000000', text: `Order ${order} is paid` });
});

export const notices_integration = integration('notices', {
	direction: 'one_way', policies: ['sales_rep'], source: { channel: 'support', inbound: true }, identity: 'message_id',
	fields: { message_id: 'id', received_at: 'sentAt', subject: { in: (mail) => mail.subject || '(no subject)' } },
});

export const customers_integration = integration('customers', {
	direction: 'two_way', policies: ['sales_rep'],
	source: { connection: 'erp', list: { path: '/customers', records: 'customers', cursor: 'cursor',
		shape: { code: { kind: 'text' }, name: { kind: 'text' }, gold: { kind: 'bool' } } },
		create: { path: '/customers' }, update: { path: '/customers/{code}' }, pull: { cron: '*/30 * * * *' } },
	identity: 'name',
	resolve: async ({ read }) => (await read('customers', { select: { name: true }, limit: 100 })).rows.length,
	fields: { name: 'name', tier: { in: (r, { resolve }) => (r.gold && resolve > 0 ? 'gold' : 'basic') } },
	push: { name: 'name' },
	owns: { remote: ['tier'], local: ['name'] },
	conflicts: { default: 'remote_wins', fields: { name: 'latest' } },
});

export const orders_pipeline = pipeline('orders', {
	import: { description: 'Orders from a CSV', input: { rows: { kind: 'list', of: { kind: 'object', fields: { customer: { kind: 'id', of: 'customers' }, note: { kind: 'text' } } } } },
		records: ({ rows }) => rows, map: (r) => ({ customer: r.customer, note: r.note }) },
	export: { description: 'Open orders', select: ['number', 'status', 'total'], where: { status: { ne: 'ordered' } }, format: 'csv' },
});
