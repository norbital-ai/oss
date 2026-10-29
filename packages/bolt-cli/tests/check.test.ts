/// <reference types="node" />
// `bolt check`'s build rules over a manifest (§3.3.9): model/label, model/instant-date, model/default, model/range,
// sync/*, kiosk/embed, app/embed, write/read-in-loop, notify/via, automation/cron. The full compile pipeline is not run
// here: templates' `bolt check` gate runs it.
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { checkRules, cronValid, sourceRules } from '../src/compiler/check/rules.ts';
import { evaluationCpuMs } from '../src/compiler/check/index.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
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
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
describe('bolt check', () => {
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
							label: ['order', 'title'],
							fields: {
								title: { kind: 'text' },
								shipped_on: { kind: 'instant' },
								due_date: { kind: 'instant' },
								paid_at: { kind: 'instant' },
								born_on: { kind: 'date' }
							}
						},
						orders: { description: 'orders', label: 'id', fields: {} },
						notes: {
							description: 'notes',
							label: 'code',
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
					label: 'title',
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
					label: 'name',
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
	it("checks a sync: its connection, a file's parsers, a remote's cadence and partitions, and a write's one instance (sync/*)", () => {
		const m: EngineManifest = {
			...emptyManifest,
			models: {
				customers: { description: 'c', label: 'name', fields: { name: { kind: 'text' } } },
				events: { description: 'e', label: 'title', fields: { title: { kind: 'text' } } }
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
					configuration: { calendars: { kind: 'list', of: { kind: 'text' } } }
				}
			},
			connections: {
				crm_a: { integration: 'crm' },
				crm_b: { integration: 'crm' }
			},
			exposures: {
				customers: {
					read: { customers: { fields: 'all' } },
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
					read: { events: { fields: 'all' } },
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
			"sync/file customers: syncs.ofx: a file sync runs on upload and export; every and partitions are a remote sync's",
			"sync/parser customers: syncs.ofx: 'numbers' is no built-in parser (xlsx, csv, tsv, json, ics)",
			"sync/parser customers: syncs.ofx: a custom parser lists its file extensions ('.ofx')",
			"sync/every customers: syncs.crm: 'often' is not a duration ('15min', '1h')",
			expect.stringContaining(
				"sync/instance customers: syncs.crm: a write goes through one instance of 'crm'"
			),
			"sync/with customers: syncs.erp: with 'erp' is 'file' or an integration definition",
			"sync/partitions events: syncs.typo: 'calendar' is no configuration field of 'calendar'"
		]);
	});
	it('an embedding origin is https://host[:port], and only a kiosk or a portal page is embedded (kiosk/embed, app/embed)', () => {
		const page = { title: 'P' };
		const m: EngineManifest = {
			...emptyManifest,
			policies: { lobby: { description: 'l', grants: {} } },
			kiosks: {
				lobby: {
					title: 'L',
					description: 'L',
					icon: 'x',
					auth: 'members',
					policies: ['lobby'],
					pages: { home: page },
					embed: ['https://partner.example', 'https://partner.example:8443/path', 'https://a b']
				}
			},
			apps: {
				shop: {
					title: 'S',
					description: 'S',
					icon: 'x',
					pages: {
						home: { ...page, portal: true, embed: ['https://*.example'] },
						open: { ...page, portal: true, embed: ['https://partner.example'] }
					}
				}
			}
		};
		expect(
			checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`)
		).toEqual([
			"kiosk/embed lobby: embed: 'https://partner.example:8443/path' is an origin, https://host[:port] (no path, no wildcard)",
			"kiosk/embed lobby: embed: 'https://a b' is an origin, https://host[:port] (no path, no wildcard)",
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
					label: 'name',
					fields: { name: { kind: 'text' }, cost: { kind: 'int' } }
				}
			},
			exposures: {
				items: {
					read: { items: { fields: 'all' } },
					outputs: {
						public: { items: { fields: ['name'] } },
						unlabelled: { items: { fields: ['cost'] } }
					},
					create: { columns: { items: ['name', 'cost'] } },
					delete: {}
				}
			},
			policies: {
				anyone: { description: 'a', grants: { items: { outputs: { public: true } } } },
				wide: {
					description: 'w',
					grants: { items: { read: true, outputs: { unlabelled: true } } }
				},
				desk: {
					description: 'd',
					grants: { items: { outputs: { public: true }, create: true, delete: true } }
				}
			},
			apps: { shop: { ...shop, audience: { public: ['anyone', 'wide'] } } },
			kiosks: {
				lobby: {
					title: 'L',
					description: 'L',
					icon: 'x',
					auth: 'members',
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
			"access/kiosk-grant desk: kiosk 'lobby': items.create lists its columns explicitly; a kiosk takes no open grant",
			"access/kiosk-grant desk: kiosk 'lobby': items: a kiosk never deletes"
		]);
	});
	it('reads the model sources: a write callback reading inside a loop, a notice through a non-conversation connection (write/read-in-loop, notify/via)', () => {
		const m: EngineManifest = {
			...emptyManifest,
			integrations: { crm: { description: 'CRM', driver: 'http' } },
			connections: { support: { integration: 'whatsapp' }, books: { integration: 'crm' } }
		};
		const text = `import { model } from '@norbital-ai/bolt';
export default model('orders', {
	description: 'o', label: 'title', fields: { title: { kind: 'text' } }, read: 'all',
	create: {
		columns: { orders: ['title'] },
		transform: function* (rows, ctx) {
			const known = yield* ctx.db.query({ orders: { where: { title: { in: rows.map((r) => r.title) } } } });
			for (const row of rows) yield* ctx.db.query({ orders: { where: { title: { eq: row.title } }, limit: 1 } });
			return rows;
		}
	},
	update: {
		columns: { orders: ['title'] },
		*transform(changes, ctx) {
			yield* Effect.all(changes.map(function* (c) { return yield* ctx.db.after('orders', { id: { eq: c.before.id } }); }));
			return changes.map((c) => c.set);
		}
	},
	notify: function* (event, ctx) { for (const x of [1, 2]) yield* ctx.db.query({ orders: { limit: 1 } });
		return [{ title: 'New', to: [{ team: 'sales' }], via: ['support', 'books', 'nowhere'] }];
	}
});`;
		const found = sourceRules(m, [{ path: 'src/data/model/orders/+model.ts', text }]);
		expect(found.map((f) => `${f.code} ${f.line}`)).toEqual([
			'write/read-in-loop 8',
			'write/read-in-loop 15',
			'notify/via 20',
			'notify/via 20'
		]);
		expect(found[0]!.message).toContain('a write callback reads inside a loop over its rows');
		expect(found[2]!.message).toContain("'books' is not one");
		expect(found[3]!.message).toContain("'nowhere' is not one");
	});
	it.live('parses cron strings at build (rule 52)', () =>
		Effect.gen(function* () {
			for (const ok of ['0 2 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '5,35 0 1 1,6 0', '@daily'])
				expect(cronValid(ok)).toBe(true);
			for (const bad of [
				'61 * * * *',
				'* * * *',
				'0 0 0 * *',
				'*/0 * * * *',
				'0 0 * 13 *',
				'5-1 * * * *',
				'@often'
			])
				expect(cronValid(bad)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it('grades evaluation CPU at reference speed: a thread slowed by load is not over budget (rule 6)', () => {
		// unloaded: the reference ran at speed, the module's CPU stands
		expect(evaluationCpuMs(80, 7)).toBe(80);
		expect(evaluationCpuMs(120, 7)).toBe(120);
		// a busy machine ran the same thread 2.5× slower: the same module still measures 80 ms
		expect(evaluationCpuMs(200, 17.5)).toBe(80);
		// a faster thread than the reference is never graded up
		expect(evaluationCpuMs(80, 3)).toBe(80);
	});
});
