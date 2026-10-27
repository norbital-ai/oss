// Type corpus for the runtime roles (§3.3.1, §3.3.5, §3.3.6, §3.3.8, §3.4, rules 50–63b). Each `@ts-expect-error` line
// is a planted mistake; a clean tsc proves every valid line compiles and every mistake is refused at its literal.
import { app, automation, model, group, mcp, secrets, workspace } from '../../src/index.ts';
import { currency, Decimal } from '@norbital-ai/std/decimal';
import type { CurrencyCode, FileRef, Id, Instant } from '../../src/index.ts';
import type { RunInput, RunOutput } from '../../src/decl/runtime/automation.ts';
import type { SkillFrontmatter } from '../../src/decl/runtime/agent.ts';
import type { StartInput } from '../../src/decl/runtime/facilities.ts';
import type { SyncCtx } from '../../src/decl/runtime/sync.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// ── run inputs and outputs, from the literal ──
is<
	Eq<
		RunInput<typeof rt.follow_up.spec>,
		{ readonly model: 'orders'; readonly ids: readonly Id<'orders'>[] }
	>
>(); // event triggers only
is<Eq<RunInput<typeof rt.render.spec>, { readonly order: Id<'orders'> }>>(); // declared input
is<Eq<RunInput<typeof rt.nightly.spec>, {}>>(); // cron: nothing
is<Eq<RunOutput<typeof rt.nightly.spec>, number>>();
is<Eq<RunOutput<typeof rt.render.spec>, FileRef>>();
is<Eq<StartInput<'products.sync.ledger'>, { readonly [key: string]: never }>>(); // a remote sync read takes no input
const mixed = automation('follow_up', {
	...rt.follow_up.spec,
	description: 'x',
	runAs: ['sales_rep'],
	on: [{ cron: '@daily' }, { deleted: 'orders' }],
	run: function* ({ ids = [] }, ctx) {
		is<Eq<typeof ctx.actor.kind, 'system'>>();
		yield* ctx.act('orders.update', ids.map((id) => ({ target: id, set: { note: 'swept' } })));
		const id = ids[0];
		if (id !== undefined) {
			yield* ctx.act(
				'orders.update',
				[{ target: id, set: { note: 'observed' } }],
				{ observed: { [id]: 1 } }
			);
			yield* ctx.act(
				'orders.update',
				[{ target: id, set: { note: 'invalid' } }],
				// @ts-expect-error an observed revision is numeric
				{ observed: { [id]: '1' } }
			);
		}
		if (id !== undefined) yield* ctx.schedule('render', { order: id });
		yield* ctx.schedule('nightly', {});
		yield* ctx.ai.sys_2.infer({ prompt: 'x', tools: ['browser'] });
		yield* ctx.ai.sys_2.infer({ prompt: 'x', tools: ['read', 'browser'] });
		const n: number = yield* ctx.ai.sys_2.infer({
			prompt: 'count',
			model: 'fast',
			output: { kind: 'int' }
		});
		// ctx.ai.sys_1.decide (P36, P37): each answer typed from its question literal; the state is text only
		const { answers } = yield* ctx.ai.sys_1.decide({
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
		yield* ctx.ai.sys_1.decide({
			state: {},
			// @ts-expect-error — `yesno` is `noul` (P37)
			questions: { q: { type: 'yesno', instructions: 'x', criteria: { true: 'a', false: 'b' } } }
		});
		yield* ctx.ai.sys_1.decide({
			// @ts-expect-error — a sys_1 state is text only: no FileRef (P37 (3))
			state: { photo: ref0 },
			questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }
		});
		// ctx.ai.embed takes text and files (P39)
		void ((yield* ctx.ai.embed(['a caption', ref0])) satisfies readonly (readonly number[])[]);
		const hits = yield* ctx.geo.search('Kismis');
		if (!('kind' in hits)) void hits.map((h) => h.point.lat);
		const ref: FileRef = yield* ctx.files.put(new Uint8Array(), {
			name: 'a.txt',
			mime: 'text/plain',
			for: 'sites.photos'
		});
		yield* ctx.files.image(ref, { jpeg: { maxEdge: 1024 } });
		yield* ctx.send('support', { to: ['a@b.co'], subject: 'x', text: String(n) });
		void (ctx.now satisfies Instant);
	}
});
is<Eq<RunInput<typeof mixed.spec>['ids'], readonly Id<'orders'>[] | undefined>>(); // cron runs carry no ids
is<Eq<NonNullable<RunInput<typeof mixed.spec>['rows']>[number]['number'], string>>(); // deleted pre-images
declare const ref0: FileRef;

rt.render.body; // inline in the fixture

// ── automation('nightly', { ...rt.nightly.spec, ) ──
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A1 a cron with six fields
	on: { cron: '0 0 2 * * *' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A2 a cron with four fields
	on: { cron: '0 2 * *' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A3 a trigger on an unknown model
	on: { created: 'ordres' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A4 `fields` only on `updated`
	on: { created: 'orders', fields: ['status'] }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A5 a delay that is not a Duration
	on: { created: 'orders', delay: '3 days' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A6 a trigger where on a field orders lacks
	on: { updated: 'orders', where: { stauts: { eq: 'draft' } } }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A7 `fields` names an unknown field
	on: { updated: 'orders', fields: ['stauts'] }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	// @ts-expect-error A8 runAs 'trigger' on a triggered automation (rule 53)
	runAs: 'trigger',
	on: { cron: '@daily' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	// @ts-expect-error A9 an unknown policy in runAs
	runAs: ['sales_rap'],
	on: { cron: '@daily' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A10 retry attempts outside 2–8
	retry: { attempts: 9 }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A11 concurrency above 16
	concurrency: { max: 17 }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A12 an unknown webhook scheme
	on: { webhook: '/in', verify: { scheme: 'github', secret: 'HOOK_SECRET' } }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A13 a webhook secret that is not a declared secret name
	on: { webhook: '/in', verify: { scheme: 'standard', secret: 'hook-secret' } }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A14 a ledger is never a trigger target (X-18)
	on: { created: 'sys_run' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A15 a misspelt trigger arm
	on: { create: 'orders' }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A16 an operator the field's kind lacks, in the second trigger of an array
	on: [{ cron: '@daily' }, { updated: 'orders', where: { due: { like: '2026%' } } }]
});
// @ts-expect-error A17 an unknown key (runAs misspelt)
automation('nightly', { ...rt.nightly.spec, description: 'x', run_as: ['sales_rep'] });
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A18 an unknown input kind
	input: { n: { kind: 'integer' } }
});
automation('nightly', {
	...rt.nightly.spec,
	description: 'x',
	runAs: ['sales_rep'],
	// @ts-expect-error A19 a webhook path without its leading slash
	on: { webhook: 'in', verify: { scheme: 'bearer', secret: 'HOOK_SECRET' } }
});

automation('body', {
	description: 'x',
	runAs: ['sales_rep'],
	input: { n: { kind: 'int' } },
	output: { kind: 'text' },
	// @ts-expect-error B1 the body returns what `output` does not declare
	run: function* ({ n }) {
		return n;
	}
});

automation('trig', {
	description: 'x',
	runAs: 'trigger',
	run: function* (_, ctx) {
		// @ts-expect-error B2 host tools only when runAs is a policy list (rule 58)
		yield* ctx.ai.sys_2.infer({ prompt: 'x', tools: ['browser'] });
		// @ts-expect-error B2 nor record reads (rule 58)
		yield* ctx.ai.sys_2.infer({ prompt: 'x', tools: ['read'] });
		// @ts-expect-error B3 scheduling an unknown automation
		yield* ctx.schedule('nigthly', {});
		// @ts-expect-error B4 the scheduled input does not match the automation's
		yield* ctx.schedule('render', { order: 1 });
		// @ts-expect-error B5 an input for an automation that declares none
		yield* ctx.schedule('nightly', { force: true });
		// @ts-expect-error B6 an email message through a chat connection
		yield* ctx.send('whatsapp', { to: ['a@b.co'], subject: 'x' });
		const either = Math.random() > 0.5 ? ('whatsapp' as const) : ('support' as const);
		// @ts-expect-error B7 a union-typed connection (§3.3.9)
		yield* ctx.send(either, { to: '+65', text: 'x' });
		// @ts-expect-error B8 an unknown connection
		yield* ctx.request('billing', { method: 'GET', path: 'x', output: { kind: 'text' } });
		// @ts-expect-error B9 a file owner that is not a file field
		yield* ctx.convert.document({ markdown: '' }, { to: 'pdf', name: 'x.pdf', for: 'orders.note' });
		// a declared target with its own options: a docx takes a styling reference, a pdf its paper
		yield* ctx.convert.document(
			{ html: '<p>x</p>' },
			{ to: 'docx', reference: ref0, name: 'x.docx', for: 'render' }
		);
		// @ts-expect-error B9a a target the workspace does not declare under convert.to
		yield* ctx.convert.document({ markdown: '' }, { to: 'pptx', name: 'x.pptx', for: 'render' });
		yield* ctx.convert.document(
			{ markdown: '' },
			// @ts-expect-error B9b a pdf takes no reference document
			{ to: 'pdf', reference: ref0, name: 'x.pdf', for: 'render' }
		);
		yield* ctx.convert.document(
			{ markdown: '' },
			// @ts-expect-error B9c a docx has no paper size
			{ to: 'docx', page: 'A4', name: 'x.docx', for: 'render' }
		);
		// @ts-expect-error B9d the source is Markdown or HTML, nothing else
		yield* ctx.convert.document({ text: '' }, { to: 'pdf', name: 'x.pdf', for: 'render' });
		// @ts-expect-error B10 an automation ctx has no refuse (§3.4: a run fails by throwing)
		ctx.refuse('no');
		// @ts-expect-error B11 an http output of an unknown kind
		yield* ctx.request('erp', { method: 'POST', path: 'x', output: { kind: 'txt' } });
		// @ts-expect-error B12 a notice with a non-string team ID
		yield* ctx.notify({ to: [{ team: 42 }], title: 'x' });
		// @ts-expect-error B13 an AI model class that does not exist
		yield* ctx.ai.sys_2.infer({ prompt: 'x', model: 'gpt-5' });
		// @ts-expect-error B14 `at` is an instant or a relative operand, not a date string
		yield* ctx.schedule('nightly', {}, { at: '2026-10-01' });
	}
});

// ── MCP servers and skills ──
// @ts-expect-error MC1 a literal URL where a secret name belongs
mcp({ description: 'x', url: 'https://mcp.example.com' });
// @ts-expect-error MC2 oauth credentials must be secret names
mcp({ description: 'x', url: 'MCP_URL', auth: { oauth: { clientId: 'abc' } } });
// @ts-expect-error MC3 an unknown key
mcp({ description: 'x', url: 'MCP_URL', transport: 'sse' });
const skill: SkillFrontmatter = { description: 'Quote a customer' };
// @ts-expect-error SK1 a skill's frontmatter is its description only
const skill2: SkillFrontmatter = { description: 'x', tools: ['read'] };
void skill;
void skill2;

// ── file syncs: parsed records, context, findings, related rows and document exports ──
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			parser: ['csv'],
			schema: { code: { kind: 'text' }, note: { kind: 'text' } },
			context: { notice: { kind: 'id', of: 'notices' } },
			read: function* ({ records, context }, ctx) {
				is<Eq<typeof context.notice, Id<'notices'>>>();
				const notices = yield* ctx.db.query({ notices: {
					where: { id: { eq: context.notice } },
					limit: 1
				} });
				return {
					rows:
						notices.notices.rows.length === 0
							? []
							: records.map((r) => ({ notice: context.notice, note: r.note })),
					scope: { by: ['notice'] },
					findings: records.map((r) => ({
						at: r.$at,
						field: 'note',
						message: r.code,
						severity: 'warn' as const
					})),
					related: { notice_notes: records.map((r) => ({ notice: context.notice, note: r.code })) }
				};
			},
			write: function* ({ context }, ctx) {
				const bytes = yield* ctx.files.get(ref0);
				is<Eq<typeof bytes, Uint8Array>>();
				const image = yield* ctx.files.image(ref0, { jpeg: { maxEdge: 512 } });
				is<Eq<typeof image, FileRef>>();
				void ctx.files.image(ref0);
				// @ts-expect-error file exports cannot store arbitrary files
				void ctx.files.put;
				// @ts-expect-error file exports expose bytes and images only
				void ctx.files.text;
				// @ts-expect-error file exports have no AI facility
				void ctx.ai;
				return [{ code: String(context.notice), note: 'x' }];
			}
		}
	}
});
declare const remoteSync: SyncCtx<'kingdee'>;
// @ts-expect-error a remote sync writer has no file facilities
void remoteSync.files;
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			parser: [
				{
					type: 'text/plain',
					extensions: ['.note'],
					parse: function* (file, ctx) {
						return [{ $at: 1, code: file.name, note: yield* ctx.files.text(file) }];
					}
				}
			],
			schema: { code: { kind: 'text' }, note: { kind: 'text' } },
			context: { notice: { kind: 'id', of: 'notices' } },
			write: function* () {
				return { document: { markdown: '# Notes' }, name: 'notes' };
			}
		}
	}
});
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			// @ts-expect-error P1 unknown built-in parser
			parser: ['csvv']
		}
	}
});
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			// @ts-expect-error P2 unknown schema kind
			schema: { note: { kind: 'blob' } }
		}
	}
});
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			// @ts-expect-error P3 a read returns the model's field types
			read: function* () {
				return { rows: [{ note: 5 }] };
			}
		}
	}
});
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			// @ts-expect-error P4 an exported record follows the declared schema
			write: function* () {
				return [{ code: 5, note: 'x' }];
			}
		}
	}
});
model('notice_notes', {
	...m.notice_notes.spec,
	syncs: {
		sheet: {
			with: 'file',
			// @ts-expect-error P5 scope names writable model fields
			read: function* () {
				return {
					rows: [],
					scope: { by: ['nope'] }
				};
			}
		}
	}
});

// ── workspace(), app(), group() ──
// @ts-expect-error WS1 secret names are UPPER_SNAKE
secrets({ erpUrl: { label: 'x' } });
// @ts-expect-error WS2 a secret takes no default
secrets({ ERP_URL: { label: 'x', default: 'https://x' } });
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

// ── automation bodies can schedule, notify and request (§3.4); write callbacks and policy checks stay without I/O (g1) ──

automation('order_lines_chase', {
	...rt.order_lines_chase.spec,
	run: function* (_, ctx) {
		yield* ctx.schedule('nightly', {});
		yield* ctx.notify({ to: [{ policy: 'sales_rep' }], title: 'x' });
		yield* ctx.request('erp', { method: 'GET', path: 'x', output: { kind: 'json' } });
	}
});

