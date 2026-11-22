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
import { messageRules } from '../src/compiler/check/messages.ts';
import type { Discovered } from '../src/compiler/discover.ts';
import { parse_cron } from '@norbital-ai/bolt/tooling';
import { evaluationCpuMs } from '../src/compiler/check/index.ts';
import { workspaceEntry } from '../src/compiler/artifact/client-boundary.ts';
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
	it('validates staff membership sources, expiry fields, group ordering and protected roots', () => {
		const base: EngineManifest = {
			...emptyManifest,
			models: { grants: { description: 'Entitlements', fields: {
				team: { kind: 'text' }, until: { kind: 'date', optional: true }
			} } },
			relationships: { 'grants.member': { to: 'sys_user' } },
			teams: { staff: { policies: [] } },
			workspace: { ...emptyManifest.workspace, memberships: { model: 'grants', teams: ['staff'] } }
		};
		const findings = (m: EngineManifest) => checkRules(m, { automations: [] }, (_role, name) => name)
			.filter(f => f.code === 'workspace/memberships');
		expect(findings(base)).toEqual([]);
		expect(findings({ ...base, relationships: {} })).toHaveLength(1);
		expect(findings({ ...base, relationships: { 'grants.member': { to: 'sys_user', owned: true } } })).toHaveLength(1);
		expect(findings({ ...base, workspace: { ...base.workspace, memberships: { model: 'grants',
			teams: ['staff'], staff_team: 'missing', groups: [['staff'], ['staff']] } } })).toHaveLength(2);
	});

	it('every locale carries every base message and nothing else', () => {
		const basePath = 'src/i18n/+messages.ts',
			zhPath = 'src/i18n/+zh.messages.ts';
		const files: Discovered[] = [
			{ role: 'messages', name: '', path: basePath },
			{ role: 'locale', name: 'zh', path: zhPath }
		];
		const base = `export default messages({ 'a': 'A', 'b': 'B' });`;
		const withOrders: EngineManifest = {
			...emptyManifest,
			models: { orders: { description: '', fields: { title: { kind: 'text' } } } }
		};
		const findings = (zh: string, m: EngineManifest = emptyManifest) =>
			messageRules(
				files,
				new Map([
					[basePath, base],
					[zhPath, zh]
				]),
				m
			);
		expect(findings(`export default messages({ 'a': '甲', 'b': '乙' });`)).toEqual([]);
		expect(findings(`export default messages({ 'a': '甲' });`).map((f) => f.code)).toEqual([
			'check/messages-missing'
		]);
		expect(
			findings(`export default messages({ 'a': '甲', 'b': '乙', 'c': '丙' });`).map((f) => f.code)
		).toEqual(['check/messages-extra']);
		// a native model caption may live only in the locale: the base humanizes it
		expect(
			findings(
				`export default messages({ 'a': '甲', 'b': '乙', 'models.orders.fields.title': '标题' });`,
				withOrders
			)
		).toEqual([]);
		// a locale-only native key must still name a declared model field
		expect(
			findings(
				`export default messages({ 'a': '甲', 'b': '乙', 'models.orders.fields.missing': '缺失' });`,
				withOrders
			).map((f) => f.code)
		).toEqual(['check/messages-extra']);
	});

	it('requires English as the workspace basis and catalogs for every declared language (check/messages-base-en, check/messages-locale-missing)', () => {
		const basePath = 'src/i18n/+messages.ts',
			zhPath = 'src/i18n/+zh.messages.ts';
		const files: Discovered[] = [
			{ role: 'workspace', name: '', path: 'src/+workspace.ts' },
			{ role: 'messages', name: '', path: basePath },
			{ role: 'locale', name: 'zh', path: zhPath }
		];
		const sources = new Map([
			[basePath, `export default messages({ 'app.title': 'App' });`],
			[zhPath, `export default messages({ 'app.title': '应用' });`]
		]);

		// Missing 'en' in declared languages -> check/messages-base-en
		expect(
			messageRules(files, sources, {
				...emptyManifest,
				workspace: { tz: 'UTC', locale: 'zh', languages: ['zh'] }
			}).map((f) => f.code)
		).toEqual(['check/messages-base-en']);

		// Declaring ['en', 'zh', 'ja'] without +ja.messages.ts -> check/messages-locale-missing
		expect(
			messageRules(files, sources, {
				...emptyManifest,
				workspace: { tz: 'UTC', locale: 'en', languages: ['en', 'zh', 'ja'] }
			})
		).toEqual([
			expect.objectContaining({
				code: 'check/messages-locale-missing',
				path: 'src/i18n/+ja.messages.ts'
			})
		]);

		// Declaring ['en', 'zh'] with no +messages.ts and no +zh.messages.ts -> both reported
		expect(
			messageRules(
				[{ role: 'workspace', name: '', path: 'src/+workspace.ts' }],
				new Map(),
				{
					...emptyManifest,
					workspace: { tz: 'UTC', locale: 'en', languages: ['en', 'zh'] }
				}
			).map((f) => `${f.code} ${f.path}`)
		).toEqual([
			'check/messages-locale-missing src/i18n/+messages.ts',
			'check/messages-locale-missing src/i18n/+zh.messages.ts'
		]);

		// English-only workspace without any i18n catalogs is valid
		expect(
			messageRules(
				[{ role: 'workspace', name: '', path: 'src/+workspace.ts' }],
				new Map(),
				{
					...emptyManifest,
					workspace: { tz: 'UTC', locale: 'en', languages: ['en'] }
				}
			)
		).toEqual([]);
	});

	it('flags static t()/ctx.t() calls referencing undeclared message keys (check/messages-undeclared-key)', () => {
		const basePath = 'src/i18n/+messages.ts';
		const files: Discovered[] = [
			{ role: 'messages', name: '', path: basePath },
			{ role: 'page', name: 'sales/home', path: 'src/app/sales/+home.page.svelte' }
		];
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				orders: {
					description: 'Orders',
					fields: { status: { kind: 'enum', values: ['open', 'closed'] } }
				}
			}
		};
		const sources = new Map([
			[basePath, `export default messages({ 'app.title': 'Sales', 'btn.go': 'Go' });`],
			[
				'src/app/sales/+home.page.svelte',
				[
					'<script lang="ts">',
					"\tconst ok = ctx.t('app.title');",
					"\tconst bad = ctx.t('missing.script_key');",
					"\tconst nativeOk = ctx.t('models.orders.fields.status.open');",
					"\tconst shellOk = ctx.t('Save');",
					'</script>',
					"<h1>{t('btn.go')}</h1>",
					"<p>{t('missing.markup_key')}</p>",
					'<!-- bolt-check:allow messages-undeclared-key -->',
					"<p>{t('missing.suppressed')}</p>"
				].join('\n')
			],
			[
				'src/lib/helper.ts',
				[
					"export const label = (t: (k: string) => string) => t('missing.lib_key');",
					"export const okLabel = (t: (k: string) => string) => t('app.title');",
					"export const refuseBad = (ctx: { refuse: (k: string) => void }) => ctx.refuse('Raw English refusal');"
				].join('\n')
			]
		]);
		expect(messageRules(files, sources, m).map((f) => `${f.code} ${f.path}:${f.line}`)).toEqual([
			'check/messages-undeclared-key src/app/sales/+home.page.svelte:3',
			'check/messages-undeclared-key src/app/sales/+home.page.svelte:8',
			'check/messages-undeclared-key src/lib/helper.ts:1',
			'check/messages-undeclared-key src/lib/helper.ts:3'
		]);
	});

	it('enforces placeholder parity, non-empty values, framework overrides and non-native locale completeness', () => {
		const basePath = 'src/i18n/+messages.ts';
		const zhPath = 'src/i18n/+zh.messages.ts';
		const jaPath = 'src/i18n/+ja.messages.ts';
		const files: Discovered[] = [
			{ role: 'messages', name: '', path: basePath },
			{ role: 'locale', name: 'zh', path: zhPath },
			{ role: 'locale', name: 'ja', path: jaPath }
		];
		const m: EngineManifest = {
			...emptyManifest,
			workspace: { tz: 'UTC', locale: 'en', languages: ['en', 'zh', 'ja'] }
		};
		const sources = new Map([
			[
				basePath,
				`export default messages({ 'a.greeting': 'Hello {name}', 'a.empty': '   ' });`
			],
			[
				zhPath,
				// Allows framework overrides ('Save', 'ui.save'), catches mismatched placeholder and empty value
				`export default messages({ 'a.greeting': '你好 {user}', 'a.empty': '', 'Save': '存储', 'ui.save': '存储' });`
			],
			[
				jaPath,
				// Non-native locale missing Bolt/UI framework keys -> check/messages-framework-missing
				`export default messages({ 'a.greeting': 'こんにちは {name}', 'a.empty': '空' });`
			]
		]);
		expect(messageRules(files, sources, m).map((f) => `${f.code} ${f.path}`)).toEqual([
			'check/messages-empty src/i18n/+messages.ts',
			'check/messages-placeholders src/i18n/+zh.messages.ts',
			'check/messages-empty src/i18n/+zh.messages.ts',
			'check/messages-framework-missing src/i18n/+ja.messages.ts'
		]);
	});

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
		expect(invalid.failure.issues.join('\n')).toContain(
			'["automations"]["read_advice"]["input"]["document"]["to"]'
		);
		expect(
			checkRules(
				Result.getOrThrow(decode(valid.input)),
				{ automations: ['read_advice'] },
				(_role, name) => name
			).filter((finding) => finding.code === 'automation/input')
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
					on: [
						{ model: 'sys_user', verbs: ['create', 'update'] },
						{ model: 'sys_invitation', verbs: ['create'] }
					]
				},
				lost: {
					description: 'Listens to nothing',
					policies: ['staff'],
					on: [{ model: 'nowhere', verbs: ['create'] }]
				}
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
	it("checks a sync: its definition, a file's parsers, a remote's cadence, partitions and policies, and runtime account fanout (sync/*)", () => {
		const scoped = (v: string) => ({
			description: 'Scoped customers',
			grants: {
				customers: { outputs: { default: { scopes: { customers: { name: { eq: { var: v } } } } } } }
			}
		});
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
			policies: {
				sync: { description: 'Sync', grants: { customers: { outputs: { default: {} } } } },
				instance: scoped('actor.instance'),
				own: scoped('actor.id')
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
						crm: { with: 'crm', policies: ['sync'], every: 'often', read: true, write: true },
						mirror: { with: 'crm', policies: ['sync', 'instance'], read: true },
						erp: { with: 'erp', policies: ['sync'], read: true },
						upload: { with: 'file', parser: ['csv'], policies: ['sync'] },
						bare: { with: 'crm', read: true },
						ghost: { with: 'crm', policies: ['ghost'], read: true },
						mine: { with: 'crm', policies: ['own'], read: true }
					}
				},
				events: {
					outputs: { default: { events: { fields: 'all' } } },
					syncs: {
						calendar: {
							with: 'calendar',
							policies: ['sync'],
							partitions: 'calendars',
							read: true,
							write: true
						},
						typo: { with: 'calendar', policies: ['sync'], partitions: 'calendar', read: true }
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
			"sync/file customers.upload: a file's rows enter as the member importing; policies are a remote sync's",
			'sync/policies customers.bare: policies: name at least one policy its pages are written as',
			"sync/policies customers.ghost: policies: there is no policy 'ghost'",
			"sync/policies customers.mine: policies: 'own' scopes by actor.*; a sync's pages are written as the system identity; only actor.instance matches",
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
					driver: {
						name: 'line',
						read: 'deliveries',
						conversation: { kind: 'chat', handle: null, address: '{}' }
					}
				},
				shadow: { description: 's', driver: { name: 'http', read: 'cursor', request: 'http' } },
				twice: {
					description: 't',
					driver: {
						name: 'whatsapp',
						read: 'deliveries',
						conversation: { kind: 'chat', handle: null }
					}
				},
				loose: {
					description: 'l',
					driver: {
						name: 'loose',
						read: 'cursor',
						credential: true,
						conversation: { kind: 'chat', handle: null, address: '@' }
					}
				},
				hook: {
					description: 'h',
					driver: 'http',
					webhook: {
						verify: { scheme: 'standard', secret: 's' },
						policies: ['inbound', 'missing'],
						handle: true
					}
				},
				bare: {
					description: 'b',
					driver: 'http',
					webhook: { verify: { scheme: 'standard', secret: 's' }, handle: true }
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
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
			grants: {
				notes: { outputs: { default: { scopes: { notes: { owner: { eq: { var: v } } } } } } }
			}
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
		) =>
			sourceRules(m, new Map(Object.entries(sources)), files).map(
				(f) => `${f.code} ${f.path}:${f.line}`
			);
		it('a try around a yield* (check/try-yield)', () => {
			expect(
				codes({
					'src/lib/bad.ts':
						'export const f = function* (ctx) {\n\ttry {\n\t\tyield* ctx.query({});\n\t} catch {}\n};',
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
			).toEqual([
				'check/read-in-loop src/data/model/o/+model.ts:2',
				'check/read-in-loop src/data/model/o/+model.ts:3'
			]);
		});
		it('set ?? before (check/set-before)', () => {
			expect(
				codes({
					'src/lib/bad.ts': 'const x = c.set.total ?? c.before.total;',
					'src/lib/good.ts':
						'const x = c.after.total; const y = c.set.total ?? d.before.total; const z = c.set.a ?? c.before.b;'
				})
			).toEqual(['check/set-before src/lib/bad.ts:1']);
		});
		it("a retried run's act without a key (check/act-retry-key)", () => {
			const body =
				'export default automation({ run: function* (_, ctx) {\n\tyield* ctx.act({});\n\tyield* ctx.progress({});\n\tyield* ctx.act({}, { key: "k" });\n} });';
			const m: EngineManifest = {
				...emptyManifest,
				automations: {
					retried: { description: 'r', policies: ['p'], retry: { attempts: 3 } },
					once: { description: 'o', policies: ['p'] }
				}
			};
			expect(
				codes(
					{
						'src/automation/+retried.automation.ts': body,
						'src/automation/+once.automation.ts': body
					},
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
			const body =
				'export default automation({ run: function* (_, ctx) {\n\tyield* ctx.wait({ until: "2026-01-01T00:00:00Z" });\n} });';
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
						'src/data/model/x/+model.ts':
							'const e = function* (_, ctx) {\n\tyield* ctx.wait({ until: u });\n};'
					},
					m,
					[
						{ role: 'automation', name: 'job', path: 'src/automation/+job.automation.ts' },
						{ role: 'automation', name: 'call', path: 'src/automation/+call.automation.ts' }
					]
				)
			).toEqual([
				'check/wait-job src/automation/+call.automation.ts:2',
				'check/wait-job src/data/model/x/+model.ts:2'
			]);
		});
		it('catches invalid <Chart of="model"> measures and bare-string order_by arrays', () => {
			const m: EngineManifest = {
				...emptyManifest,
				models: {
					invoices: {
						description: 'Invoices',
						fields: { amount: { kind: 'decimal', scale: 2 }, status: { kind: 'text' } }
					}
				}
			};
			expect(
				codes(
					{
						'src/app/finance/+dash.page.svelte':
							'<script lang="ts">\n\tconst q = { order_by: ["created_at"] };\n\tconst ok = { order_by: [{ created_at: "desc" }] };\n</script>\n<Chart {ctx} of="invoices" x="status" y="amount" />\n<Chart {ctx} of="invoices" x="status" y="sum.amount" />\n<Chart {ctx} of="invoices" x="status" y={["count", "bad"]} />'
					},
					m
				)
			).toEqual([
				'check/order-by-shape src/app/finance/+dash.page.svelte:2',
				'check/chart-measure src/app/finance/+dash.page.svelte:5',
				'check/chart-measure src/app/finance/+dash.page.svelte:7'
			]);
		});
		it('flags multiple simultaneous tables/boards in one region while allowing branches, snippets and overlays (check/single-data-view)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': [
						'<Stack>',
						'\t<Table of="a" />',
						'\t<Table of="b" />',
						'</Stack>'
					].join('\n'),
					'src/app/a/+split.page.svelte': [
						'<Split>',
						'\t<Table of="a" />',
						'\t<Board of="b" />',
						'</Split>'
					].join('\n'),
					'src/app/a/+seq-if.page.svelte': [
						'{#if showA}<Table of="a" />{/if}',
						'{#if showB}<Board of="b" />{/if}'
					].join('\n'),
					'src/app/a/+both-branches.page.svelte': [
						'{#if locked}',
						'\t<Table of="a" />',
						'\t<Table of="b" />',
						'{:else}',
						'\t<Table of="c" />',
						'\t<Board of="d" />',
						'{/if}'
					].join('\n'),
					'src/app/a/+good-branches.page.svelte': [
						'{#if locked}',
						'\t<Table of="snapshot" />',
						'{:else if boardMode}',
						'\t<Board of="live" />',
						'{:else}',
						'\t<Table of="live" />',
						'{/if}'
					].join('\n'),
					'src/app/a/+good-tabs.page.svelte': [
						'{#snippet first()}<Table of="a" />{/snippet}',
						'{#snippet second()}<Board of="b" />{/snippet}',
						'<Tabs items={[{ id: "a", content: first }, { id: "b", content: second }]} />'
					].join('\n'),
					'src/app/a/+good-overlay.page.svelte': [
						'<Table of="a">{#snippet row_detail()}<Table of="lines" />{/snippet}</Table>',
						'<Sheet open><Table of="picker" /></Sheet>',
						'<Dialog open><Board of="mini" /></Dialog>'
					].join('\n'),
					'src/app/a/+suppressed.page.svelte': [
						'<Table of="a" />',
						'<!-- repository-health:allow check/single-data-view -- intentional split comparison -->',
						'<Table of="b" />'
					].join('\n')
				})
			).toEqual([
				'check/single-data-view src/app/a/+bad.page.svelte:3',
				'check/single-data-view src/app/a/+split.page.svelte:3',
				'check/single-data-view src/app/a/+seq-if.page.svelte:2',
				'check/single-data-view src/app/a/+both-branches.page.svelte:3',
				'check/single-data-view src/app/a/+both-branches.page.svelte:6'
			]);
		});
		it('flags <Chart> inside <Bound size="viewport"> (check/chart-viewport)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': [
						'<Bound size="viewport">',
						'\t<Chart of="x" x="a" y="count" />',
						'</Bound>',
						'<Bound size="viewport">',
						'\t<Stack><Chart of="y" x="a" y="count" /></Stack>',
						'</Bound>'
					].join('\n'),
					'src/app/a/+good.page.svelte': [
						'<Bound size="fill"><Chart of="x" x="a" y="count" /></Bound>',
						'<Bound><Chart of="x" x="a" y="count" /></Bound>',
						'<Chart of="x" x="a" y="count" />',
						'<Bound size="viewport"><Sheet open><Chart of="x" x="a" y="count" /></Sheet></Bound>',
						'<!-- repository-health:allow check/chart-viewport -- full-bleed chart view -->',
						'<Bound size="viewport"><Chart of="x" x="a" y="count" /></Bound>'
					].join('\n')
				})
			).toEqual([
				'check/chart-viewport src/app/a/+bad.page.svelte:2',
				'check/chart-viewport src/app/a/+bad.page.svelte:5'
			]);
		});
		it('flags raw typography classes, bold tags outside prose, arbitrary sizes and role+leading pairs (check/typography-tokens)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': [
						'<p class="font-semibold">A</p>',
						'<p class="font-bold">B</p>',
						'<p>Total: <b>$100</b></p>',
						'<p>Note: <strong>Important</strong></p>',
						'<h2 class="text-lg">C</h2>',
						'<h2 class="text-2xl">D</h2>',
						'<span class="text-[13px]">E</span>',
						'<span class="text-meta leading-tight">F</span>',
						'<span class="leading-none text-heading">G</span>',
						'<span class:font-bold={active}>H</span>',
						'<span class={cn("text-xl", active && "text-foreground")}>I</span>',
						'<span class={{ "text-3xl": big }}>J</span>'
					].join('\n'),
					'src/app/a/+good.page.svelte': [
						'<p class="text-sm font-medium">A</p>',
						'<span class="text-meta text-muted-foreground">B</span>',
						'<span class="text-sm leading-5">C</span>',
						'<div class="prose"><p>Read <b>this</b> and <strong>that</strong>.</p></div>',
						'<Markdown><strong>Bold in markdown</strong></Markdown>',
						'<ReadonlyMarkdown><b>Bold in markdown</b></ReadonlyMarkdown>',
						'<!-- repository-health:allow typography-tokens -- intentional emphasis -->',
						'<p class="font-bold">Allowed</p>'
					].join('\n')
				})
			).toEqual([
				'check/typography-tokens src/app/a/+bad.page.svelte:1',
				'check/typography-tokens src/app/a/+bad.page.svelte:2',
				'check/typography-tokens src/app/a/+bad.page.svelte:3',
				'check/typography-tokens src/app/a/+bad.page.svelte:4',
				'check/typography-tokens src/app/a/+bad.page.svelte:5',
				'check/typography-tokens src/app/a/+bad.page.svelte:6',
				'check/typography-tokens src/app/a/+bad.page.svelte:7',
				'check/typography-tokens src/app/a/+bad.page.svelte:8',
				'check/typography-tokens src/app/a/+bad.page.svelte:9',
				'check/typography-tokens src/app/a/+bad.page.svelte:10',
				'check/typography-tokens src/app/a/+bad.page.svelte:11',
				'check/typography-tokens src/app/a/+bad.page.svelte:12'
			]);
		});
		it('flags raw indicator unicode glyphs in markup (check/raw-unicode-icons)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': [
						'<span>▲ 4.2%</span>',
						'<span>{up ? "▲" : "▼"}</span>',
						'<Badge label="⚠ Overdue" />',
						'<p>ℹ Info</p>'
					].join('\n'),
					'src/app/a/+good.page.svelte': [
						'<script lang="ts">// ▲ ▼ ℹ ⚠ in script comment</script>',
						'<!-- ▲ ▼ ℹ ⚠ in html comment -->',
						'<Icon icon="lucide:triangle-alert" />',
						'<!-- repository-health:allow check/raw-unicode-icons -- literal symbol legend -->',
						'<span>▲</span>'
					].join('\n')
				})
			).toEqual([
				'check/raw-unicode-icons src/app/a/+bad.page.svelte:1',
				'check/raw-unicode-icons src/app/a/+bad.page.svelte:2',
				'check/raw-unicode-icons src/app/a/+bad.page.svelte:2',
				'check/raw-unicode-icons src/app/a/+bad.page.svelte:3',
				'check/raw-unicode-icons src/app/a/+bad.page.svelte:4'
			]);
		});
		it('flags raw <select> elements in workspace markup (check/raw-select)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': '<select><option>A</option></select>',
					'src/app/a/+good.page.svelte': [
						'<!-- <select> -->',
						'<Select options={[]} />',
						'<Combobox options={[]} />',
						'<!-- repository-health:allow check/raw-select -- native file picker fallback -->',
						'<select><option>B</option></select>'
					].join('\n')
				})
			).toEqual(['check/raw-select src/app/a/+bad.page.svelte:1']);
		});
		it('flags fixed self-sizing classes on Input, Combobox, TimeInput and Bound (check/self-sized-control)', () => {
			expect(
				codes({
					'src/app/a/+bad.page.svelte': [
						'<Input class="w-40" />',
						'<Combobox class="min-w-48" />',
						'<TimeInput class="h-10" />',
						'<Bound class="h-[42rem]" />',
						'<Bound class="min-h-96 max-h-[80dvh]" />',
						'<Input class="w-[240px]" />',
						'<Input class="sm:w-32" />'
					].join('\n'),
					'src/app/a/+good.page.svelte': [
						'<Input class="min-w-0 w-full" />',
						'<Combobox class="max-w-96" />',
						'<Bound size="fill" clip class="relative rounded-md border" />',
						'<div class="w-40 h-10"><Icon class="h-4 w-4" /></div>',
						'<!-- repository-health:allow check/self-sized-control -- fixed pin box -->',
						'<Input class="w-24" />'
					].join('\n')
				})
			).toEqual([
				'check/self-sized-control src/app/a/+bad.page.svelte:1',
				'check/self-sized-control src/app/a/+bad.page.svelte:2',
				'check/self-sized-control src/app/a/+bad.page.svelte:3',
				'check/self-sized-control src/app/a/+bad.page.svelte:4',
				'check/self-sized-control src/app/a/+bad.page.svelte:5',
				'check/self-sized-control src/app/a/+bad.page.svelte:6',
				'check/self-sized-control src/app/a/+bad.page.svelte:7'
			]);
		});
		it('enforces scroll ownership and inset under AppShell variant="full" (check/scroll-ownership)', () => {
			expect(
				codes({
					'src/app/a/+wrap-tabs.page.svelte': [
						'<Scroll name="x" size="fill" inset>',
						'\t<Tabs items={[]} />',
						'</Scroll>'
					].join('\n'),
					'src/app/a/+wrap-form.page.svelte': [
						'<Scroll name="x" size="fill" inset>',
						'\t{#if ready}<Form of="a" />{/if}',
						'</Scroll>'
					].join('\n'),
					'src/app/a/+wrap-table.page.svelte': [
						'<Scroll name="x" size="fill" inset>',
						'\t<Stack><Table of="a" /></Stack>',
						'</Scroll>'
					].join('\n'),
					'src/app/a/+no-inset.page.svelte': [
						'<AppShell variant="full">',
						'\t{#snippet actions()}<Combobox />{/snippet}',
						'\t<Scroll name="x" size="fill"><Stack /></Scroll>',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+good-embedded.page.svelte': [
						'<AppShell variant="full">',
						'\t<Scroll name="x" size="fill" inset>',
						'\t\t<Stack>',
						'\t\t\t<Table of={rows} embedded />',
						'\t\t\t<Sheet open><Table of="b" /></Sheet>',
						'\t\t</Stack>',
						'\t</Scroll>',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+good-viewport.page.svelte': [
						'<AppShell variant="full">',
						'\t<Scroll name="x" size="fill" inset>',
						'\t\t<Stack>',
						'\t\t\t<Bound size="viewport"><Table of="a" /></Bound>',
						'\t\t</Stack>',
						'\t</Scroll>',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+good-axis-x.page.svelte': [
						'<Scroll name="wide" axis="x"><table></table></Scroll>',
						'<AppShell><Scroll name="y" size="fill"><Stack /></Scroll></AppShell>'
					].join('\n'),
					'src/app/a/+suppressed.page.svelte': [
						'<AppShell variant="full">',
						'\t<!-- repository-health:allow check/scroll-ownership -- edge-to-edge canvas -->',
						'\t<Scroll name="x" size="fill"><Stack /></Scroll>',
						'</AppShell>'
					].join('\n')
				})
			).toEqual([
				'check/scroll-ownership src/app/a/+wrap-tabs.page.svelte:2',
				'check/scroll-ownership src/app/a/+wrap-form.page.svelte:2',
				'check/scroll-ownership src/app/a/+wrap-table.page.svelte:2',
				'check/scroll-ownership src/app/a/+no-inset.page.svelte:3'
			]);
		});
		it('flags <AppShell variant="full"> wrapping a single <Table> body (check/app-shell-inset)', () => {
			expect(
				codes({
					'src/app/a/+bad-direct.page.svelte': [
						'<AppShell variant="full">',
						'\t{#snippet actions()}<Combobox />{/snippet}',
						'\t<Table of="orders" />',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+bad-if.page.svelte': [
						'<AppShell variant="full">',
						'\t{#if empty}<EmptyState />{:else}<Table of="orders" />{/if}',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+bad-key.page.svelte': [
						'<AppShell variant="full">',
						'\t{#key scope}<Table of="orders" />{/key}',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+good-default.page.svelte': '<AppShell><Table of="orders" /></AppShell>',
					'src/app/a/+good-page.page.svelte': '<AppShell variant="page"><Table of="orders" /></AppShell>',
					'src/app/a/+good-bound.page.svelte':
						'<AppShell variant="full"><Bound size="fill" inset><Table of="orders" /></Bound></AppShell>',
					'src/app/a/+good-tabs.page.svelte': [
						'<AppShell variant="full">',
						'\t{#snippet list()}<Table of="orders" />{/snippet}',
						'\t<Tabs items={[{ id: "list", content: list }]} />',
						'</AppShell>'
					].join('\n'),
					'src/app/a/+good-suppressed.page.svelte': [
						'<!-- repository-health:allow check/app-shell-inset -- custom full-bleed matrix -->',
						'<AppShell variant="full"><Table of="matrix" /></AppShell>'
					].join('\n')
				})
			).toEqual([
				'check/app-shell-inset src/app/a/+bad-direct.page.svelte:1',
				'check/app-shell-inset src/app/a/+bad-if.page.svelte:1',
				'check/app-shell-inset src/app/a/+bad-key.page.svelte:1'
			]);
		});
		it('flags raw untranslated text nodes and visible string props in multi-language workspaces (check/untranslated-text)', () => {
			const multi: EngineManifest = {
				...emptyManifest,
				workspace: { tz: 'UTC', locale: 'en', languages: ['en', 'zh'] }
			};
			const enOnly: EngineManifest = {
				...emptyManifest,
				workspace: { tz: 'UTC', locale: 'en', languages: ['en'] }
			};
			const page = {
				'src/app/a/+bad.page.svelte': [
					'<Section name="fx-overview" icon="lucide:globe" title="Raw English">',
					'\t<p>Visible raw text</p>',
					'\t<Input placeholder="Search orders" aria-label="Filter input" />',
					'\t<p>{ctx.t("orders.title")}</p>',
					'\t<p>USD / SGD · 100%</p>',
					'\t<p>42.5 ha · 400 nm · 12 ms</p>',
					'\t<Map label="name" rows={[]} />',
					'\t<code>Raw code example</code>',
					'\t<pre>Preformatted text</pre>',
					'\t<svg><text>SVG Label</text></svg>',
					'\t<span aria-hidden="true">Hidden label</span>',
					'\t<!-- bolt-check:allow untranslated-text -->',
					'\t<p>Allowed Brand Name</p>',
					'\t<Button variant="full" size="fill" type="button" href="/app/sales" />',
					'</Section>'
				].join('\n')
			};
			expect(codes(page, multi)).toEqual([
				'check/untranslated-text src/app/a/+bad.page.svelte:1',
				'check/untranslated-text src/app/a/+bad.page.svelte:2',
				'check/untranslated-text src/app/a/+bad.page.svelte:3',
				'check/untranslated-text src/app/a/+bad.page.svelte:3'
			]);
			// English-only workspaces are not flagged
			expect(codes(page, enOnly)).toEqual([]);
		});
		it('a host-only @norbital-ai/bolt entry does not resolve for workspace code', () => {
			expect(() => workspaceEntry('@norbital-ai/bolt/engine')).toThrow(/no workspace entry/);
			expect(() => workspaceEntry('@norbital-ai/bolt/protocol')).toThrow(/no workspace entry/);
			for (const id of ['@norbital-ai/bolt', '@norbital-ai/bolt/errors', '@norbital-ai/bolt/page'])
				expect(() => workspaceEntry(id)).not.toThrow();
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
