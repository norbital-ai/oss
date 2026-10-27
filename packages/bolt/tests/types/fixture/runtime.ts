import { install } from '../../../src/decl/runtime/guest.ts';
install();
import { Effect, Result } from 'effect';
// The runtime roles of the type corpus workspace: what a template puts in +workspace.ts, +secrets.ts, src/integration,
// src/automation and src/agent. Every body sits in its literal, typed from `../registry.ts` by its name.
import { automation, envoy, integration, mcp, secrets, workspace } from '../../../src/index.ts';
import { Refusal } from '../../../src/decl/errors.ts';

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
		whatsapp: { integration: 'whatsapp', envoy: 'desk' }
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

// HTTP: a configured base URL, a credential sealed at pairing, Standard Webhooks, a request rate and a pairing test
export const erp = integration('erp', {
	description: 'The ERP API.',
	driver: 'http',
	configuration: {
		baseUrl: { kind: 'text', format: 'url' },
		room: { kind: 'text', default: 'general' },
		topic: { kind: 'text', optional: true },
		mute: { kind: 'bool', optional: true, default: false }
	},
	credential: {
		token: { kind: 'text', label: 'API token' },
		signingSecret: { kind: 'text', label: 'Webhook signing secret' }
	},
	http: { baseUrl: 'baseUrl', auth: { bearer: 'token' } },
	webhook: { verify: { scheme: 'standard', secret: 'signingSecret' } },
	rate: '10/s',
	test: function* (ctx) {
		yield* ctx.request({ method: 'GET', path: 'me', output: { kind: 'json' } });
	}
});

// a database: products are read from it, ordered orders written to it (`model(…).syncs`)
export const kingdee = integration('kingdee', {
	description: 'An accounting database.',
	driver: 'sqlserver',
	credential: { connection: { kind: 'text', label: 'Connection string' } },
	configuration: {
		maxLagMinutes: { kind: 'int', min: 1, default: 15 },
		databases: { kind: 'text', many: true, default: [] }
	},
	test: function* (ctx) {
		yield* ctx.request({ op: 'values', values: { n: 1 } });
	}
});

// a mailbox: its messages reach `notices` as deliveries
export const support_mail = integration('support_mail', {
	description: 'The support mailbox.',
	driver: 'email'
});

// a member's calendar: the driver pushes events, one cursor per chosen calendar
export const calendar = integration('calendar', {
	description: "A member's calendar.",
	driver: 'calendar',
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' },
	configuration: { calendars: { kind: 'text', many: true, default: [] } }
});

export const erp_mcp = mcp({
	description: 'Product documentation',
	url: 'MCP_URL',
	tools: ['search_docs']
});

export const nightly = automation('nightly', {
	description: 'Nightly order digest',
	runAs: ['sales_rep'],
	on: { cron: '0 2 * * *' },
	output: { kind: 'int' },
	run: function* (_, ctx) {
		const open = yield* ctx.query({ orders: {
			where: { status: { eq: 'submitted' } },
			fields: ['number']
		} });
		return open.orders.rows.length;
	}
});

export const follow_up = automation('follow_up', {
	description: 'Chase an order three days after it is placed',
	runAs: ['sales_rep'],
	on: [
		{ created: 'orders', delay: '3d', where: { status: { eq: 'draft' } } },
		{ updated: 'orders', fields: ['status', 'total'] }
	],
	retry: { attempts: 3, backoff: '1min' },
	concurrency: { max: 1 },
	run: function* ({ ids }, ctx) {
		const orders = yield* ctx.query({ orders: {
			where: { id: { in: ids } },
			fields: ['number', 'owner']
		} });
		for (const o of orders.orders.rows)
			if (o.owner !== null)
				yield* ctx.notify({
					to: [{ user: o.owner }],
					title: `Order ${o.number} is still open`,
					link: { model: 'orders', id: o.id }
				});
		yield* ctx.schedule('nightly', {}, { at: { now: '+1d' }, key: 'chase' });
	}
});

export const render = automation('render', {
	description: 'Render an order confirmation',
	runAs: 'trigger',
	input: { order: { kind: 'id', of: 'orders' } },
	output: { kind: 'file', accept: ['application/pdf'], max: '5MiB' },
	run: function* ({ order }, ctx) {
		const { orders } = yield* ctx.query({
			orders: { where: { id: { eq: order } }, limit: 1, fields: ['number'] }
		});
		return yield* ctx.convert.document(
			{ markdown: `# Order ${orders.rows[0]?.number ?? ''}` },
			{ to: 'pdf', page: 'A4', name: 'order.pdf', for: 'render' }
		);
	}
});

export const inbound_hook = automation('inbound_hook', {
	description: 'Payment provider callback',
	runAs: ['sales_rep'],
	on: { webhook: '/payments', verify: { scheme: 'stripe', secret: 'HOOK_SECRET' } },
	input: { order: { kind: 'text' } },
	run: function* ({ order }, ctx) {
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
	}
});

export const orders_submit = automation('orders_submit', {
	description: 'Submit this order',
	input: { target: { kind: 'id', of: 'orders' } },
	runAs: 'trigger',
	run: function* ({ target }, ctx) {
		const order = (yield* ctx.query({ orders: { where: { id: { eq: target } }, limit: 1 } })).orders
			.rows[0];
		if (order === undefined)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing order.' }));
		yield* ctx.act(
			'orders.update',
			[{ target: order.id, set: { status: 'submitted' } }],
			{ observed: { [order.id]: order.revision } }
		);
	}
});

export const orders_renote = automation('orders_renote', {
	description: 'Set a note on many orders',
	input: { ids: { kind: 'list', of: { kind: 'id', of: 'orders' } }, note: { kind: 'text' } },
	output: { kind: 'int' },
	runAs: 'trigger',
	run: function* ({ ids, note }, ctx) {
		const orders = yield* ctx.query({ orders: {
			where: { id: { in: ids } },
			fields: ['id', 'revision']
		} });
		yield* ctx.act(
			'orders.update',
			ids.map((id) => ({ target: id, set: { note } })),
			{
				observed: Object.fromEntries(
					orders.orders.rows.map((order): [string, number] => [order.id, order.revision])
				)
			}
		);
		const { customers } = yield* ctx.query({
			customers: { where: { tier: { eq: 'gold' } }, fields: ['name'] }
		});
		return customers.rows.length;
	}
});

export const order_lines_pay = automation('order_lines_pay', {
	description: 'Pay',
	input: {
		p: {
			kind: 'union',
			by: 'method',
			arms: { card: { last4: { kind: 'text' } }, bank: { iban: { kind: 'text' } } }
		},
		split: { kind: 'record', of: { kind: 'decimal', scale: 2 } }
	},
	output: { kind: 'text' },
	runAs: 'trigger',
	run: function* ({ p, split }) {
		return (p.method === 'card' ? p.last4 : p.iban) + Object.keys(split).join();
	}
});

export const order_lines_chase = automation('order_lines_chase', {
	description: 'Chase the lines',
	input: {},
	runAs: 'trigger',
	run: function* (_, ctx) {
		yield* ctx.schedule('nightly', {});
		yield* ctx.notify({ title: 'Chased', to: [{ policy: 'sales_rep' }] });
	}
});

export const customers_return_row = automation('customers_return_row', {
	description: 'One native row',
	input: {},
	output: { kind: 'row', of: 'customers' },
	runAs: 'trigger',
	run: function* (_, ctx) {
		const page = yield* ctx.query({ customers: { limit: 1 } });
		const customer = page.customers.rows[0];
		if (customer === undefined)
			return yield* Effect.fail(new Refusal({ message: 'Choose an existing customer.' }));
		return customer;
	}
});
