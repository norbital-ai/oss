// Type corpus for the runtime roles (§3.3.1, §3.3.5, §3.3.6, §3.3.8, §3.4, rules 50–63b). Each `@ts-expect-error` line
// is a planted mistake; a clean tsc proves every valid line compiles and every mistake is refused at its literal.
import {
	app,
	automation,
	channel,
	collection,
	connection,
	group,
	integration,
	mcp,
	pipeline,
	workspace
} from '../../src/index.ts';
import { currency } from '@norbital-ai/std/decimal';
import type { CurrencyCode, FileRef, Id, Instant } from '../../src/index.ts';
import type { RunInput, RunOutput } from '../../src/decl/runtime/automation.ts';
import type { SkillFrontmatter } from '../../src/decl/runtime/agent.ts';
import type { StartInput } from '../../src/decl/runtime/facilities.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

// ── run inputs and outputs, from the literal ──
is<
	Eq<
		RunInput<typeof rt.follow_up.spec>,
		{ readonly collection: 'orders'; readonly ids: readonly Id<'orders'>[] }
	>
>(); // event triggers only
is<Eq<RunInput<typeof rt.render.spec>, { readonly order: Id<'orders'> }>>(); // declared input
is<Eq<RunInput<typeof rt.nightly.spec>, {}>>(); // cron: nothing
is<Eq<RunOutput<typeof rt.nightly.spec>, number>>();
is<Eq<RunOutput<typeof rt.render.spec>, FileRef>>();
is<Eq<StartInput<'customers.integration'>, { mode: 'pull' | 'push' | 'reconcile' }>>();
const mixed = automation({
	description: 'x',
	runAs: ['sales_rep'],
	on: [{ cron: '@daily' }, { deleted: 'orders' }]
});
is<Eq<RunInput<typeof mixed.spec>['ids'], readonly Id<'orders'>[] | undefined>>(); // cron runs carry no ids
is<Eq<NonNullable<RunInput<typeof mixed.spec>['rows']>[number]['number'], string>>(); // deleted pre-images
declare const ref0: FileRef;
mixed.run(async ({ ids = [] }, ctx) => {
	is<Eq<typeof ctx.actor.kind, 'system'>>();
	await ctx.act('orders.update', { target: ids, set: { note: 'swept' } });
	await ctx.schedule('render', { order: ids[0] as Id<'orders'> });
	await ctx.schedule('nightly', {});
	await ctx.ai.sys_2.infer({ prompt: 'x', tools: ['browser'] });
	const n: number = await ctx.ai.sys_2.infer({
		prompt: 'count',
		model: 'fast',
		output: { kind: 'int' }
	});
	// ctx.ai.sys_1.decide (P36, P37): each answer typed from its question literal; the state is text only
	const { answers } = await ctx.ai.sys_1.decide({
		state: { subject: 'Invoice twice', photo: { name: ref0.name, mime: ref0.mime } },
		questions: {
			queue: {
				type: 'choice',
				instructions: 'Which queue?',
				criteria: { billing: 'money', technical: 'broken', accounts: 'login' }
			},
			blocked: {
				type: 'noul',
				instructions: 'Blocked?',
				criteria: { true: 'cannot work', false: 'can work' }
			},
			urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] }
		}
	});
	is<Eq<typeof answers.queue.choice, 'billing' | 'technical' | 'accounts'>>();
	is<Eq<keyof typeof answers.queue.probabilities, 'billing' | 'technical' | 'accounts'>>();
	is<Eq<typeof answers.urgency.level, 'low' | 'medium' | 'high'>>();
	void (answers.blocked.noul satisfies number);
	// @ts-expect-error — a choice answer compared with a key outside its criteria
	void (answers.queue.choice === 'sales');
	// @ts-expect-error — a noul carries no confidence
	void answers.blocked.confidence;
	await ctx.ai.sys_1.decide({
		state: {},
		// @ts-expect-error — `yesno` is `noul` (P37)
		questions: { q: { type: 'yesno', instructions: 'x', criteria: { true: 'a', false: 'b' } } }
	});
	await ctx.ai.sys_1.decide({
		// @ts-expect-error — a sys_1 state is text only: no FileRef (P37 (3))
		state: { photo: ref0 },
		questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }
	});
	// ctx.ai.embed takes text and files (P39)
	void ((await ctx.ai.embed(['a caption', ref0])) satisfies readonly (readonly number[])[]);
	const hits = await ctx.geo.search('Kismis');
	if (!('kind' in hits)) void hits.map((h) => h.point.lat);
	const ref: FileRef = await ctx.files.put(new Uint8Array(), {
		name: 'a.txt',
		mime: 'text/plain',
		for: 'sites.photos'
	});
	await ctx.files.image(ref, { jpeg: { maxEdge: 1024 } });
	await ctx.send('support', { to: ['a@b.co'], subject: 'x', text: String(n) });
	void (ctx.now satisfies Instant);
});
rt.render.run; // attached in the fixture

// ── automation() ──
// @ts-expect-error A1 a cron with six fields
automation({ description: 'x', runAs: ['sales_rep'], on: { cron: '0 0 2 * * *' } });
// @ts-expect-error A2 a cron with four fields
automation({ description: 'x', runAs: ['sales_rep'], on: { cron: '0 2 * *' } });
// @ts-expect-error A3 a trigger on an unknown collection
automation({ description: 'x', runAs: ['sales_rep'], on: { created: 'ordres' } });
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A4 `fields` only on `updated`
	on: { created: 'orders', fields: ['status'] }
});
// @ts-expect-error A5 a delay that is not a Duration
automation({ description: 'x', runAs: ['sales_rep'], on: { created: 'orders', delay: '3 days' } });
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A6 a trigger where on a field orders lacks
	on: { updated: 'orders', where: { stauts: { eq: 'draft' } } }
});
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A7 `fields` names an unknown field
	on: { updated: 'orders', fields: ['stauts'] }
});
// @ts-expect-error A8 runAs 'trigger' on a triggered automation (rule 53)
automation({ description: 'x', runAs: 'trigger', on: { cron: '@daily' } });
// @ts-expect-error A9 an unknown policy in runAs
automation({ description: 'x', runAs: ['sales_rap'], on: { cron: '@daily' } });
// @ts-expect-error A10 retry attempts outside 2–8
automation({ description: 'x', runAs: ['sales_rep'], retry: { attempts: 9 } });
// @ts-expect-error A11 concurrency above 16
automation({ description: 'x', runAs: ['sales_rep'], concurrency: { max: 17 } });
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A12 an unknown webhook scheme
	on: { webhook: '/in', verify: { scheme: 'github', secret: 'HOOK_SECRET' } }
});
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A13 a webhook secret that is not a declared env name
	on: { webhook: '/in', verify: { scheme: 'svix', secret: 'hook-secret' } }
});
// @ts-expect-error A14 a ledger is never a trigger target (X-18)
automation({ description: 'x', runAs: ['sales_rep'], on: { created: 'sys_run' } });
// @ts-expect-error A15 a misspelt trigger arm
automation({ description: 'x', runAs: ['sales_rep'], on: { create: 'orders' } });
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A16 an operator the field's kind lacks, in the second trigger of an array
	on: [{ cron: '@daily' }, { updated: 'orders', where: { due: { like: '2026%' } } }]
});
// @ts-expect-error A17 an unknown key (runAs misspelt)
automation({ description: 'x', run_as: ['sales_rep'] });
// @ts-expect-error A18 an unknown input kind
automation({ description: 'x', runAs: ['sales_rep'], input: { n: { kind: 'integer' } } });
automation({
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A19 a webhook path without its leading slash
	on: { webhook: 'in', verify: { scheme: 'bearer', secret: 'HOOK_SECRET' } }
});

const body = automation({
	description: 'x',
	runAs: ['sales_rep'],
	input: { n: { kind: 'int' } },
	output: { kind: 'text' }
});
// @ts-expect-error B1 the body returns what `output` does not declare
body.run(async ({ n }) => n);
const trig = automation({ description: 'x', runAs: 'trigger' });
trig.run(async (_, ctx) => {
	// @ts-expect-error B2 host tools only when runAs is a policy list (rule 58)
	await ctx.ai.sys_2.infer({ prompt: 'x', tools: ['browser'] });
	// @ts-expect-error B3 scheduling an unknown automation
	await ctx.schedule('nigthly', {});
	// @ts-expect-error B4 the scheduled input does not match the automation's
	await ctx.schedule('render', { order: 1 });
	// @ts-expect-error B5 an input for an automation that declares none
	await ctx.schedule('nightly', { force: true });
	// Runtime connection types are checked when sending.
	await ctx.send('whatsapp', { to: ['a@b.co'], subject: 'x' });
	const either = Math.random() > 0.5 ? ('whatsapp' as const) : ('support' as const);
	// @ts-expect-error B7 a union-typed channel (§3.3.9)
	await ctx.send(either, { to: '+65', text: 'x' });
	// @ts-expect-error B8 an unknown connection
	await ctx.http('billing').get('/x', { output: { kind: 'text' } });
	// @ts-expect-error B9 a file owner that is not a file field
	await ctx.convert.document({ markdown: '' }, { to: 'pdf', name: 'x.pdf', for: 'orders.note' });
	// a declared target with its own options: a docx takes a styling reference, a pdf its paper
	await ctx.convert.document(
		{ html: '<p>x</p>' },
		{ to: 'docx', reference: {} as FileRef, name: 'x.docx', for: 'render' }
	);
	// @ts-expect-error B9a a target the workspace does not declare under convert.to
	await ctx.convert.document({ markdown: '' }, { to: 'pptx', name: 'x.pptx', for: 'render' });
	await ctx.convert.document(
		{ markdown: '' },
		// @ts-expect-error B9b a pdf takes no reference document
		{ to: 'pdf', reference: {} as FileRef, name: 'x.pdf', for: 'render' }
	);
	await ctx.convert.document(
		{ markdown: '' },
		// @ts-expect-error B9c a docx has no paper size
		{ to: 'docx', page: 'A4', name: 'x.docx', for: 'render' }
	);
	// @ts-expect-error B9d the source is Markdown or HTML, nothing else
	await ctx.convert.document({ text: '' }, { to: 'pdf', name: 'x.pdf', for: 'render' });
	// @ts-expect-error B10 an automation ctx has no refuse (§3.4: a run fails by throwing)
	ctx.refuse('no');
	// @ts-expect-error B11 an http output of an unknown kind
	await ctx.http('erp').post('/x', { output: { kind: 'txt' } });
	// @ts-expect-error B12 a notice to an unknown team
	await ctx.notify({ to: { team: 'Finanse' }, title: 'x' });
	// @ts-expect-error B13 an AI model class that does not exist
	await ctx.ai.sys_2.infer({ prompt: 'x', model: 'gpt-5' });
	// @ts-expect-error B14 `at` is an instant or a relative operand, not a date string
	await ctx.schedule('nightly', {}, { at: '2026-10-01' });
});

// ── channel() ──
// @ts-expect-error CH1 an unknown transport
channel({ transport: 'sms' });
channel({
	transport: 'email',
	// @ts-expect-error CH2 outbound from an unknown collection
	outbound: { x: { from: 'ordres', on: 'create', message: () => ({ to: [], subject: 'x' }) } }
});
channel({
	transport: 'email',
	// @ts-expect-error CH3 an email message without a subject
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: ['a@b.co'] }) } }
});
channel({
	transport: 'email',
	outbound: {
		x: {
			from: 'sites',
			on: 'create',
			// @ts-expect-error CH4 a record field the collection does not expose
			message: ({ record }) => ({ to: [record.zone], subject: 'x' })
		}
	}
});
channel({
	transport: 'email',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: [], subject: 'x' }) } },
	// @ts-expect-error CH5 an event patch outside the update allowlist
	events: { sent: ({ at }) => ({ customer: at }) }
});
// @ts-expect-error CH6 events with no outbound to map onto
channel({ transport: 'email', events: { sent: () => ({}) } });
channel({
	transport: 'email',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: [], subject: 'x' }) } },
	// @ts-expect-error CH7 an unknown delivery event
	events: { clicked: () => ({}) }
});
// @ts-expect-error CH8 an unknown policy
channel({ transport: 'whatsapp', policies: ['sales'] });
channel({
	transport: 'email',
	// @ts-expect-error CH9 outbound is record-driven on create only
	outbound: { x: { from: 'orders', on: 'update', message: () => ({ to: [], subject: 'x' }) } }
});
channel({
	transport: 'telegram',
	// @ts-expect-error CH10 a chat message carries text, not a subject
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: 'x', subject: 'x' }) } }
});
channel({
	transport: 'inbox',
	// @ts-expect-error CH11 the inbox takes notices, not outbound messages
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: 'x', text: 'x' }) } }
});
channel({
	transport: 'whatsapp',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: 'x', text: 'x' }) } },
	events: { replied: ({ reply }) => ({ note: reply.text }) }
});
channel({
	transport: 'whatsapp',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: 'x', text: 'x' }) } },
	// @ts-expect-error CH12 a reply is `reply` on every transport, never `mail`
	events: { replied: ({ mail }) => ({ note: mail }) }
});
channel({
	transport: 'email',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: [], subject: 'x' }) } },
	events: {
		auto_replied: ({ reply }) => ({ note: reply.subject }),
		deferred: ({ code, reason }) => ({ note: `${code} ${reason}` })
	}
});
channel({
	transport: 'email',
	outbound: { x: { from: 'orders', on: 'create', message: () => ({ to: [], subject: 'x' }) } },
	// @ts-expect-error CH13 only a reply or an auto-reply carries `reply`
	events: { delivered: ({ reply }) => ({ note: reply }) }
});

// ── connection() ──
connection({
	baseUrl: 'ERP_URL',
	auth: {
		oauth2: {
			grant: 'authorization_code',
			per: 'user',
			authorizeUrl: 'ERP_URL',
			tokenUrl: 'ERP_URL',
			clientId: 'ERP_TOKEN',
			clientSecret: 'ERP_TOKEN',
			scopes: ['read']
		}
	}
});
// @ts-expect-error CO1 a literal URL where an env name belongs
connection({ baseUrl: 'https://erp.example.com' });
// @ts-expect-error CO2 an undeclared env name
connection({ baseUrl: 'ERP_URL', auth: { bearer: 'ERP_KEY' } });
connection({
	baseUrl: 'ERP_URL',
	auth: {
		// @ts-expect-error CO3 authorization_code needs `per` and scopes
		oauth2: {
			grant: 'authorization_code',
			authorizeUrl: 'ERP_URL',
			tokenUrl: 'ERP_URL',
			clientId: 'ERP_TOKEN',
			clientSecret: 'ERP_TOKEN'
		}
	}
});
connection({
	baseUrl: 'ERP_URL',
	auth: {
		oauth2: {
			grant: 'client_credentials',
			// @ts-expect-error CO4 client_credentials takes no `per`
			per: 'user',
			tokenUrl: 'ERP_URL',
			clientId: 'ERP_TOKEN',
			clientSecret: 'ERP_TOKEN'
		}
	}
});
// @ts-expect-error CO5 an unknown auth kind
connection({ baseUrl: 'ERP_URL', auth: { apiKey: 'ERP_TOKEN' } });

// ── MCP source declarations (envoys are runtime records) ──
// @ts-expect-error MC1 a literal URL where an env name belongs
mcp({ description: 'x', url: 'https://mcp.example.com' });
// @ts-expect-error MC2 oauth credentials must be env names
mcp({ description: 'x', url: 'MCP_URL', auth: { oauth: { clientId: 'abc' } } });
// @ts-expect-error MC3 an unknown key
mcp({ description: 'x', url: 'MCP_URL', transport: 'sse' });
const skill: SkillFrontmatter = { description: 'Quote a customer' };
// @ts-expect-error SK1 a skill's frontmatter is its description only
const skill2: SkillFrontmatter = { description: 'x', tools: ['read'] };
void skill;
void skill2;

// ── integration() ──
integration('notices', {
	// @ts-expect-error I1 the direction differs from the one the names index records
	direction: 'two_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	fields: {}
});
integration('customers', {
	direction: 'two_way',
	policies: ['sales_rep'],
	// @ts-expect-error I2 two_way over a channel source (never writable)
	source: { channel: 'support' },
	identity: 'name',
	fields: {}
});
integration('customers', {
	direction: 'two_way',
	policies: ['sales_rep'],
	// @ts-expect-error I3 two_way needs `update` on the source
	source: {
		connection: 'erp',
		list: { path: '/c', shape: {} },
		create: { path: '/c' },
		pull: { cron: '@hourly' }
	},
	identity: 'name',
	fields: {}
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	// @ts-expect-error I4 a field the model lacks
	fields: { sender: 'from' }
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	// @ts-expect-error I5 a remote key whose value does not fit the field (text into an instant)
	fields: { received_at: 'subject' }
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	// @ts-expect-error I6 an `in` mapping returning the wrong kind
	fields: { received_at: { in: (mail) => mail.subject } }
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	fields: {},
	// @ts-expect-error I7 push on a one_way integration
	push: { subject: 'subject' }
});
integration('customers', {
	direction: 'two_way',
	policies: ['sales_rep'],
	source: rt.customers_integration.spec.source,
	identity: 'name',
	fields: {},
	// @ts-expect-error I8 a field owned by both sides never converges
	owns: { remote: ['tier'], local: ['tier'] }
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	// @ts-expect-error I9 identity must be a field of the collection
	identity: 'id',
	fields: {}
});
integration('notices', {
	direction: 'one_way',
	// @ts-expect-error I10 an unknown policy
	policies: ['integration'],
	source: { channel: 'support' },
	identity: 'message_id',
	fields: {}
});
integration('customers', {
	direction: 'two_way',
	policies: ['sales_rep'],
	source: {
		connection: 'erp',
		list: { path: '/c', shape: {} },
		create: { path: '/c' },
		update: { path: '/c' },
		// @ts-expect-error I11 a pull cron with the wrong field count
		pull: { cron: '*/30 * * *' }
	},
	identity: 'name',
	fields: {}
});
integration('orders', {
	// @ts-expect-error I12 no integration is recorded for orders
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'note',
	fields: {}
});
integration('customers', {
	direction: 'two_way',
	policies: ['sales_rep'],
	source: {
		connection: 'erp',
		// @ts-expect-error I13 an unknown kind in the remote shape
		list: { path: '/c', shape: { code: { kind: 'string' } } },
		create: { path: '/c' },
		update: { path: '/c' },
		pull: { cron: '@hourly' }
	},
	identity: 'name',
	fields: {}
});
integration('notices', {
	direction: 'one_way',
	policies: ['sales_rep'],
	source: { channel: 'support' },
	identity: 'message_id',
	// @ts-expect-error I14 a remote key the inbound mail lacks
	fields: { subject: 'title' }
});

// ── pipeline() ──
pipeline('notice_notes', {
	import: {
		description: 'x',
		input: {},
		records: () => [] as const,
		map: () => null,
		onConflict: 'keep'
	}
});
pipeline('notices', {
	// @ts-expect-error P1 import into a one_way mirror (no create)
	import: { description: 'x', input: {}, records: () => [], map: () => null }
});
pipeline('notice_notes', {
	// @ts-expect-error P2 a keyed collection needs onConflict
	import: { description: 'x', input: {}, records: () => [], map: () => null }
});
pipeline('orders', {
	import: {
		description: 'x',
		input: { note: { kind: 'text' } },
		records: ({ note }) => [note],
		// @ts-expect-error P3 a mapped field outside the create allowlist
		map: (note) => ({ customer: 'c' as Id<'customers'>, note, status: 'ordered' })
	}
});
// @ts-expect-error P4 an export field the collection does not expose
pipeline('sites', { export: { description: 'x', select: ['zone'], format: 'csv' } });
// @ts-expect-error P5 an unknown export format
pipeline('orders', { export: { description: 'x', select: ['number'], format: 'pdf' } });
pipeline('orders', {
	// @ts-expect-error P6 an unknown import input kind
	import: { description: 'x', input: { f: { kind: 'blob' } }, records: () => [], map: () => null }
});

// ── workspace(), app(), group() ──
// @ts-expect-error WS1 env names are UPPER_SNAKE
workspace({ tz: 'UTC', locale: 'en', env: { erpUrl: { label: 'x' } } });
// @ts-expect-error WS2 a secret takes no default
workspace({ tz: 'UTC', locale: 'en', env: { ERP_URL: { label: 'x', default: 'https://x' } } });
// @ts-expect-error WS3 the default model class must be one the workspace declares
workspace({ tz: 'UTC', locale: 'en', ai: { models: ['fast'], default: 'strong' } });
// @ts-expect-error WS4 an unknown app in the launcher order
workspace({ tz: 'UTC', locale: 'en', apps: ['crm'] });
// @ts-expect-error WS5 an unknown key
workspace({ tz: 'UTC', locale: 'en', currency: 'SGD', seats: 5 });
const fromLiteral: CurrencyCode = 'SGD';
const fromStd: CurrencyCode = currency('SGD');
void fromLiteral;
void fromStd;
// @ts-expect-error WS6 currency codes are upper case or std's branded code
workspace({ tz: 'UTC', locale: 'en', currency: 'sgd' });
app('sales', {
	title: 'Sales',
	description: 'Orders',
	icon: 'lucide:store',
	banner: 'assets/sales.png',
	pages: { overview: { title: 'Overview' }, orders: { title: 'Orders', section: 'Work' } }
});
app('portal', {
	title: 'Portal',
	description: 'x',
	icon: 'lucide:life-buoy',
	audience: { public: ['sales_rep'], challenge: 'turnstile' },
	pages: { tickets: { title: 'Tickets', portal: true } }
});
// @ts-expect-error AP1 a page with no page file in the app's folder
app('sales', { title: 'x', description: 'x', icon: 'x', pages: { dashboard: { title: 'x' } } });
app('portal', {
	title: 'x',
	description: 'x',
	icon: 'x',
	// @ts-expect-error AP2 an unknown public policy
	audience: { public: ['applicant'] },
	pages: {}
});
// @ts-expect-error AP3 an app with no folder
app('crm', { title: 'x', description: 'x', icon: 'x', pages: {} });
// @ts-expect-error AP4 there is no thumbnail option (P4)
app('sales', { title: 'x', description: 'x', icon: 'x', thumbnail: 'x.svg', pages: {} });
group('ops', { label: 'Operations', icon: 'lucide:folder', defaultChild: 'sales' });
// @ts-expect-error GR1 defaultChild must be a child folder
group('ops', { label: 'x', icon: 'x', defaultChild: 'finance' });

// ── bodies in collection actions can schedule and notify (§3.4) ──
const acts = collection('order_lines', {
	read: { fields: 'all' },
	actions: { chase: { description: 'x', input: {} } }
});
acts.action('chase', async (_, ctx) => {
	await ctx.schedule('nightly', {});
	await ctx.notify({ to: [{ policy: 'sales_rep' }], title: 'x' });
	// @ts-expect-error B15 actions have no I/O facilities (rule 63)
	await ctx.http('erp');
});
