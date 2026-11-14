/// <reference types="node" />
// `bolt check`'s build rules over a manifest: model/label, model/instant-date, model/default, model/range,
// sync/*, kiosk/embed, app/embed, notify/via, automation/cron, automation/write, and the source rules check/*. The full compile pipeline is not run
// here: templates' `bolt check` gate runs it.
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { checkRules } from '../src/compiler/check/rules.ts';
import { sourceRules } from '../src/compiler/check/source.ts';
import { parse_cron } from '@norbital-ai/bolt/tooling';
import { evaluationCpuMs } from '../src/compiler/check/index.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { decode_projected_manifest } from '../../bolt/src/engine/manifest.ts';
const emptyManifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
describe('bolt check', () => {
	it('checks CEL label syntax and record field references', () => {
		const inspect = (record_label?: string) =>
			checkRules(
				{
					...emptyManifest,
					models: {
						orders: {
							description: 'Orders',
							...(record_label === undefined ? {} : { record_label }),
							fields: { code: { kind: 'text' }, name: { kind: 'text', optional: true } }
						}
					}
				},
				{ automations: [] },
				(_role, name) => name
			).filter((finding) => finding.code === 'model/label');
		expect(
			inspect("record.code + ' · ' + (record.name != null ? record.name : 'Unnamed')")
		).toEqual([]);
		expect(inspect('record.missing')).toEqual([
			expect.objectContaining({ message: expect.stringContaining('unknown field') })
		]);
		expect(inspect('record.code +')).not.toEqual([]);
		expect(inspect()).toEqual([]);
	});
	it('rejects invalid automation input metadata before it can break shell boot', () => {
		const valid = {
			description: 'Read a document',
			policies: ['treasury'],
			input: { document: { kind: 'ref', to: 'documents' } }
		};
		const decode = (input: unknown) =>
			decode_projected_manifest({
				...Object.fromEntries(Object.entries(emptyManifest).filter(([key]) => key !== 'needs')),
				policies: { treasury: { description: 'Treasury', grants: {} } },
				automations: { read_advice: { ...valid, input } }
			});
		// the manifest decoder itself refuses the malformed input, so no artifact carrying it reaches a shell
		const invalid = decode({ document: { kind: 'ref' } });
		if (Result.isSuccess(invalid)) throw new Error('A ref input without its target decoded.');
		expect(invalid.failure.issues.join('\n')).toContain('["automations"]["read_advice"]["input"]["document"]["to"]');
		expect(
			checkRules(Result.getOrThrow(decode(valid.input)), { automations: ['read_advice'] }, (_role, name) => name).filter(
				(finding) => finding.code === 'automation/input'
			)
		).toEqual([]);
	});
	it('a write listener names a template or system model (automation/write)', () => {
		const m: EngineManifest = {
			...emptyManifest,
			policies: { staff: { description: 'Staff', grants: {} } },
			automations: {
				greet: {
					description: 'Greets members',
					policies: ['staff'],
					on: [{ model: 'sys_user', verbs: ['create', 'update'] }, { model: 'sys_invitation', verbs: ['create'] }]
				},
				lost: { description: 'Listens to nothing', policies: ['staff'], on: [{ model: 'nowhere', verbs: ['create'] }] }
			}
		};
		expect(
			checkRules(m, { automations: ['greet', 'lost'] }, (_r, n) => n)
				.filter((f) => f.code === 'automation/write')
				.map((f) => f.message)
		).toEqual(["lost: on: there is no model 'nowhere'"]);
	});
	it.live(
		'refuses a label naming an id or a foreign key, and an instant named as a calendar day (model/label, model/instant-date)',
		() =>
			Effect.gen(function* () {
				const m: EngineManifest = {
					...emptyManifest,
					workspace: emptyManifest.workspace,
					models: {
						lines: {
							description: 'lines',
							record_label:
								"[record.order != null ? string(record.order) : '', record.title != null ? string(record.title) : ''].filter(part, part != '').join(' · ')",
							fields: {
								title: { kind: 'text' },
								shipped_on: { kind: 'instant' },
								due_date: { kind: 'instant' },
								paid_at: { kind: 'instant' },
								born_on: { kind: 'date' }
							}
						},
						orders: { description: 'orders', record_label: 'record.id', fields: {} },
						notes: {
							description: 'notes',
							record_label: 'record.code',
							fields: {},
							computed: { code: { kind: 'text', expr: { field: 'id' } } }
						}
					},
					relationships: { 'lines.order': { to: 'orders' } },
					automations: {},
					apps: {},
					policies: {},
					exposures: {},
					integrations: {}
				};
				const found = checkRules(m, { automations: [] }, (_r, n) => n).map(
					(f) => `${f.code} ${f.message}`
				);
				expect(found).toEqual([
					"model/instant-date lines: shipped_on: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
					"model/instant-date lines: due_date: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }",
					expect.stringContaining("model/label lines: label 'order' is a foreign key"),
					expect.stringContaining("model/label orders: label 'id' is the row id")
				]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it('refuses a date or instant default that is neither a literal nor a clock { var } (model/default)', () => {
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				tasks: {
					description: 'tasks',
					record_label: 'record.title',
					fields: {
						title: { kind: 'text' },
						due_on: { kind: 'date', default: { today: '' } },
						starts_at: { kind: 'instant', default: { var: 'tomorrow' } },
						opened_on: { kind: 'date', default: { var: 'today + days(1)' } },
						seen_at: { kind: 'instant', default: { var: 'now' } },
						fixed_on: { kind: 'date', default: '2026-01-01' }
					}
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n)
				.filter((f) => f.code === 'model/default')
				.map((f) => f.message.split(':')[1]?.trim())
		).toEqual(['due_on', 'starts_at']);
	});
	it('checks a custom search index: its width, its rerank page, its name and its vector field (model/range)', () => {
		const index = { description: 'x', input: {}, metric: 'l2' as const };
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				trials: {
					description: 'trials',
					record_label: 'record.name',
					fields: { name: { kind: 'text' }, lab: { kind: 'vector', dim: 3, metric: 'l2' } },
					search: {
						text: ['name'],
						indexes: {
							colour: { ...index, dim: 3, candidates: 4 },
							stored: { ...index, dim: 3, field: 'lab' },
							wide: { ...index, dim: 2001 },
							semantic: { ...index, dim: 3 },
							mismatched: { ...index, dim: 4, field: 'lab' },
							paged: { ...index, dim: 3, candidates: 1 }
						}
					}
				}
			}
		};
		expect(checkRules(m, { automations: [] }, (_r, n) => n).map((f) => f.message)).toEqual([
			'trials: search.indexes.wide: dim is 1 to 2,000',
			"trials: search.indexes.semantic: 'semantic' is the platform's meaning search; name the index",
			"trials: search.indexes.mismatched: vector 'lab' is a vector field of dim 4"
		]);
	});
	it("checks a sync: its definition, a file's parsers, a remote's cadence and partitions, and runtime account fanout (sync/*)", () => {
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				customers: {
					description: 'c',
					record_label: 'record.name',
					fields: { name: { kind: 'text' } }
				},
				events: {
					description: 'e',
					record_label: 'record.title',
					fields: { title: { kind: 'text' } }
				}
			},
			relationships: {
				'events.calendar': {
					to: 'sys_integration',
					where: { integration: { eq: 'calendar' } }
				}
			},
			integrations: {
				crm: { description: 'CRM', driver: 'http' },
				calendar: {
					description: 'Calendars',
					driver: 'calendar',
					configuration: { calendars: { kind: 'text', many: true } }
				}
			},
			exposures: {
				customers: {
					outputs: { default: { customers: { fields: 'all' } } },
					syncs: {
						sheet: { with: 'file', parser: ['xlsx', 'csv'] },
						ofx: {
							with: 'file',
							parser: ['numbers', { type: 'application/vnd.intu.qfx', extensions: ['ofx'] }],
							every: '1h'
						},
						crm: { with: 'crm', every: 'often', read: true, write: true },
						mirror: { with: 'crm', read: true },
						erp: { with: 'erp', read: true }
					}
				},
				events: {
					outputs: { default: { events: { fields: 'all' } } },
					syncs: {
						calendar: { with: 'calendar', partitions: 'calendars', read: true, write: true },
						typo: { with: 'calendar', partitions: 'calendar', read: true }
					}
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"sync/file customers.ofx: a file sync runs on upload and export; every and partitions are a remote sync's",
			"sync/parser customers.ofx: 'numbers' is no built-in parser (xlsx, csv, tsv, json, ics, txt)",
			"sync/parser customers.ofx: a custom parser lists its file extensions ('.ofx')",
			"sync/every customers.crm: 'often' is not a duration ('15min', '1h')",
			"sync/with customers.erp: with 'erp' is 'file' or an integration definition",
			"sync/partitions events.typo: 'calendar' is no configuration field of 'calendar'"
		]);
	});
	it('a declared driver holds together and a webhook handler holds declared policies (integration/*)', () => {
		const m: EngineManifest = {
			...emptyManifest,
			policies: { inbound: { description: 'i', grants: {} } },
			integrations: {
				line: {
					description: 'LINE',
					driver: { name: 'line', read: 'deliveries', conversation: { kind: 'chat', handle: null, address: '{}' } }
				},
				shadow: { description: 's', driver: { name: 'http', read: 'cursor', request: 'http' } },
				twice: { description: 't', driver: { name: 'whatsapp', read: 'deliveries', conversation: { kind: 'chat', handle: null } } },
				loose: {
					description: 'l',
					driver: { name: 'loose', read: 'cursor', credential: true, conversation: { kind: 'chat', handle: null, address: '@' } }
				},
				hook: {
					description: 'h',
					driver: 'http',
					webhook: { verify: { scheme: 'standard', secret: 's' }, policies: ['inbound', 'missing'], handle: true }
				},
				bare: { description: 'b', driver: 'http', webhook: { verify: { scheme: 'standard', secret: 's' }, handle: true } }
			}
		};
		expect(checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)).toEqual([
			"integration/driver shadow: driver: 'http' is one of Bolt's kinds; name it as a string or declare another name",
			"integration/driver twice: driver: 'whatsapp' is declared with another contract elsewhere; one name, one contract",
			"integration/driver loose: driver: a conversation is read as 'deliveries', and only a conversation is",
			'integration/driver loose: driver: a credential is sealed for requests; declare request or drop credential',
			"integration/driver loose: driver: a conversation's address names the handle as {}",
			"integration/webhook hook: webhook.policies: there is no policy 'missing'",
			'integration/webhook bare: webhook.handle holds declared policies: name them in webhook.policies'
		]);
	});
	it('an embedding origin is https://host[:port], for an app or kiosk (app/embed)', () => {
		const page = { title: 'P' };
		const m: EngineManifest = {
			...emptyManifest,
			policies: { lobby: { description: 'l', grants: {} } },
			apps: {
				lobby: {
					title: 'L',
					description: 'L',
					icon: 'x',
					shell: 'kiosk',
					policies: ['lobby'],
					pages: { home: page },
					embed: ['https://partner.example', 'https://partner.example:8443/path', 'https://a b']
				},
				shop: {
					title: 'S',
					description: 'S',
					icon: 'x',
					embed: ['https://*.example', 'https://partner.example'],
					pages: { home: page, open: page }
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"app/embed lobby: embed: 'https://partner.example:8443/path' is an origin, https://host[:port] (no path, no wildcard)",
			"app/embed lobby: embed: 'https://a b' is an origin, https://host[:port] (no path, no wildcard)",
			"app/embed shop: embed: 'https://*.example' is an origin, https://host[:port] (no path, no wildcard)"
		]);
	});
	it('a visitor or kiosk reads only named outputs that list their fields and the label; a run names declared policies (access/visitor-grant, access/kiosk-grant, automation/policies)', () => {
		const page = { title: 'P' };
		const shop = { title: 'S', description: 'S', icon: 'x', pages: { home: page } };
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				items: {
					description: 'items',
					record_label: 'record.name',
					fields: { name: { kind: 'text' }, cost: { kind: 'int' } }
				}
			},
			exposures: {
				items: {
					outputs: {
						default: { items: { fields: 'all' } },
						public: { items: { fields: ['name'] } },
						unlabelled: { items: { fields: ['cost'] } }
					},
					create: { columns: { items: ['name', 'cost'] } },
					delete: {}
				}
			},
			policies: {
				anyone: { description: 'a', grants: { items: { outputs: { public: {} } } } },
				wide: {
					description: 'w',
					grants: { items: { outputs: { default: {}, unlabelled: {} } } }
				},
				desk: {
					description: 'd',
					grants: { items: { outputs: { public: {} }, create: {}, delete: {} } }
				}
			},
			apps: {
				shop: { ...shop, audience: { public: ['anyone', 'wide'] } },
				lobby: {
					title: 'L',
					description: 'L',
					icon: 'x',
					shell: 'kiosk',
					policies: ['desk'],
					pages: { home: page }
				}
			},
			automations: {
				orphan: { description: 'o', policies: ['nobody'] }
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n)
				.filter((f) => /^(access\/(visitor|kiosk)-grant|automation\/policies)$/.test(f.code))
				.map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"automation/policies orphan: policies: there is no policy 'nobody'",
			"access/visitor-grant wide: public in app 'shop': items: output 'default' reads every field; a visitor reads a named output that lists its fields",
			"access/visitor-grant wide: public in app 'shop': items: output 'unlabelled' lists the label (name)",
			"access/kiosk-grant desk: kiosk 'lobby': items.create lists its fields explicitly; a kiosk takes no open grant",
			"access/kiosk-grant desk: kiosk 'lobby': items: a kiosk never deletes"
		]);
	});
	it.live('parses cron strings at build', () =>
		Effect.gen(function* () {
			for (const ok of [
				'0 2 * * *',
				'*/15 * * * *',
				'0 9-17 * * 1-5',
				'5,35 0 1 1,6 0',
				' @daily '
			])
				expect(Result.isSuccess(parse_cron(ok))).toBe(true);
			for (const bad of [
				'61 * * * *',
				'* * * *',
				'0 0 0 * *',
				'*/0 * * * *',
				'0 0 * 13 *',
				'5-1 * * * *',
				'*/60 * * * *',
				'@often'
			])
				expect(Result.isSuccess(parse_cron(bad))).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it('refuses an automation holding a policy scoped by actor.* (check/actor-scoped-automation)', () => {
		const scoped = (v: string) => ({
			description: 'Own notes',
			grants: { notes: { outputs: { default: { scopes: { notes: { owner: { eq: { var: v } } } } } } } }
		});
		const m: EngineManifest = {
			...emptyManifest,
			policies: { own: scoped('actor.id'), all: scoped('today') },
			automations: {
				mine: { description: 'Scoped', policies: ['own'] },
				every: { description: 'Unscoped', policies: ['all'] }
			}
		};
		expect(
			checkRules(m, { automations: ['mine', 'every'] }, (_r, n) => n)
				.filter((f) => f.code === 'check/actor-scoped-automation')
				.map((f) => f.message)
		).toEqual([
			"mine: policies: 'own' scopes by actor.*; an automation runs as the system identity; actor.* matches nothing"
		]);
	});
	describe('source rules', () => {
		const codes = (
			sources: Record<string, string>,
			m: EngineManifest = emptyManifest,
			files: Parameters<typeof sourceRules>[2] = []
		) => sourceRules(m, new Map(Object.entries(sources)), files).map((f) => `${f.code} ${f.path}:${f.line}`);
		it('a try around a yield* (check/try-yield)', () => {
			expect(
				codes({
					'src/lib/bad.ts': 'export const f = function* (ctx) {\n\ttry {\n\t\tyield* ctx.query({});\n\t} catch {}\n};',
					'src/lib/good.ts':
						'export const f = function* (ctx) {\n\tyield* ctx.query({}).pipe(Effect.catch(() => Effect.void));\n\ttry { JSON.parse(s); } catch {}\n\ttry { run(function* () { yield* x; }); } catch {}\n};'
				})
			).toEqual(['check/try-yield src/lib/bad.ts:2']);
		});
		it('a read inside a row loop of a model, policy or sync body (check/read-in-loop)', () => {
			const loop =
				'export default model("o", { update: function* (changes, ctx) {\n\tfor (const c of changes) yield* ctx.query({});\n\tchanges.map(function* () { yield* ctx\n\t\t.query({}); });\n} });';
			const once =
				'export default model("o", { update: function* (changes, ctx) {\n\tconst all = yield* ctx.query({});\n\tfor (const c of yield* ctx.query({})) c;\n} });';
			expect(
				codes({
					'src/data/model/o/+model.ts': loop,
					'src/data/model/p/+model.ts': once,
					'src/lib/helper.ts': loop
				})
			).toEqual(['check/read-in-loop src/data/model/o/+model.ts:2', 'check/read-in-loop src/data/model/o/+model.ts:3']);
		});
		it('set ?? before (check/set-before)', () => {
			expect(
				codes({
					'src/lib/bad.ts': 'const x = c.set.total ?? c.before.total;',
					'src/lib/good.ts': 'const x = c.after.total; const y = c.set.total ?? d.before.total; const z = c.set.a ?? c.before.b;'
				})
			).toEqual(['check/set-before src/lib/bad.ts:1']);
		});
		it("a retried run's act without a key (check/act-retry-key)", () => {
			const body = 'export default automation({ run: function* (_, ctx) {\n\tyield* ctx.act({});\n\tyield* ctx.progress({});\n\tyield* ctx.act({}, { key: "k" });\n} });';
			const m: EngineManifest = {
				...emptyManifest,
				automations: {
					retried: { description: 'r', policies: ['p'], retry: { attempts: 3 } },
					once: { description: 'o', policies: ['p'] }
				}
			};
			expect(
				codes(
					{ 'src/automation/+retried.automation.ts': body, 'src/automation/+once.automation.ts': body },
					m,
					[
						{ role: 'automation', name: 'retried', path: 'src/automation/+retried.automation.ts' },
						{ role: 'automation', name: 'once', path: 'src/automation/+once.automation.ts' }
					]
				)
			).toEqual(['check/act-retry-key src/automation/+retried.automation.ts:2']);
		});
		it('two acts with nothing yielded between them, not two arms of one if or ?: nor after an exiting branch (check/act-split)', () => {
			expect(
				codes({
					'src/lib/bad.ts':
						'export const f = function* (ctx) {\n\tif (a) yield* ctx.act({ x: [] });\n\tif (b) yield* ctx.act({ y: [] });\n};',
					'src/lib/good.ts':
						'export const f = function* (ctx) {\n\tyield* ctx.act({ x: [], y: [] });\n\tyield* ctx.query({});\n\tif (a) yield* ctx.act({ x: [] });\n\telse yield* ctx.act({ y: [] });\n\tyield* ctx.query({});\n\tyield* ctx.act({ z: [] });\n};',
					'src/lib/either.ts':
						'export const f = function* (ctx) {\n\tconst r = a ? yield* ctx.act({ x: [] }) : yield* ctx.act({ y: [] });\n};',
					'src/lib/early.ts':
						'export const f = function* (ctx) {\n\tif (a) {\n\t\tyield* ctx.act({ x: [] });\n\t\treturn;\n\t}\n\tyield* ctx.act({ y: [] });\n};'
				})
			).toEqual(['check/act-split src/lib/bad.ts:3']);
		});
		it('ctx.wait outside a job automation (check/wait-job)', () => {
			const body = 'export default automation({ run: function* (_, ctx) {\n\tyield* ctx.wait({ until: "2026-01-01T00:00:00Z" });\n} });';
			const m: EngineManifest = {
				...emptyManifest,
				automations: {
					job: { description: 'j', policies: ['p'] },
					call: { description: 'c', policies: ['p'], mode: 'call' }
				}
			};
			expect(
				codes(
					{
						'src/automation/+job.automation.ts': body,
						'src/automation/+call.automation.ts': body,
						'src/data/model/x/+model.ts': 'const e = function* (_, ctx) {\n\tyield* ctx.wait({ until: u });\n};'
					},
					m,
					[
						{ role: 'automation', name: 'job', path: 'src/automation/+job.automation.ts' },
						{ role: 'automation', name: 'call', path: 'src/automation/+call.automation.ts' }
					]
				)
			).toEqual(['check/wait-job src/automation/+call.automation.ts:2', 'check/wait-job src/data/model/x/+model.ts:2']);
		});
		it('an import past the author contract, in modules and components (check/author-import)', () => {
			expect(
				codes({
					'src/lib/bad.ts': "import type { Json } from '@norbital-ai/bolt/engine';",
					'src/app/a/+home.page.svelte':
						'<div></div>\n<script lang="ts">\n\timport { dynamic_read } from \'@norbital-ai/bolt/protocol\';\n</script>',
					'src/lib/good.ts':
						"import { model } from '@norbital-ai/bolt';\nimport { Refusal } from '@norbital-ai/bolt/errors';\nimport { PageBolt } from '@norbital-ai/bolt/page';",
					'src/app/a/+good.page.svelte': "<script lang=\"ts\">\n\timport { model } from '@norbital-ai/bolt';\n</script>"
				})
			).toEqual(['check/author-import src/lib/bad.ts:1', 'check/author-import src/app/a/+home.page.svelte:3']);
		});
	});
	it('grades evaluation CPU at reference speed: a thread slowed by load is not over budget', () => {
		// unloaded: the reference ran at speed, the module's CPU stands
		expect(evaluationCpuMs(80, 7)).toBe(80);
		expect(evaluationCpuMs(120, 7)).toBe(120);
		// a busy machine ran the same thread 2.5× slower: the same module still measures 80 ms
		expect(evaluationCpuMs(200, 17.5)).toBe(80);
		// a faster thread than the reference is never graded up
		expect(evaluationCpuMs(80, 3)).toBe(80);
	});
});
