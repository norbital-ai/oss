// The workspace shell's pure halves (§5.10, §3.9): app visibility, the nav tree, routes, and the visitor fetch.
import { required } from './support/required.ts';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer, ManagedRuntime, Option, Result, Schema } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Files, Images } from '../src/engine/ports.ts';
import { images_port } from '../src/node/images.ts';
import { manifest as baseManifest } from './engine-fixture.ts';
import type { Authority, ModelAuthority, EngineActor } from '../src/engine/contracts.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import {
	can_open,
	command_center_tabs,
	cross_site,
	frame_policy,
	holds_public,
	href,
	is_open_route,
	kiosk_href,
	kiosk_nav,
	nav,
	nav_apps,
	preview_route,
	startable_automations,
	route,
	surfaces
} from '../src/shell/nav.ts';
import { challenge_queue, kiosk_fetch, visitor_fetch, shell_api } from '../src/shell/runtime.ts';
import { BoltRoutes } from '../src/protocol/http.ts';
import { active_app, media, navigation_model } from '../src/shell/model.ts';
import { file_attachments } from '../src/engine/agent/attachments.ts';
import {
	language_of,
	StudioOp,
	studio_view,
	suggest_message,
	type StudioState
} from '../src/shell/studio/model.ts';
import { decode_manifest, type EngineManifest } from '../src/engine/manifest.ts';
/** The Node host's image port, as the agent's attachments read through it. */
const hostImages = Effect.map(Layer.build(Images.fromAbi(images_port)), (context) =>
	Context.get(context, Images)
);
const decodeOp = (value: unknown) =>
	Option.getOrNull(Schema.decodeUnknownOption(StudioOp, { onExcessProperty: 'error' })(value));

beforeEach(() => {
	vi.stubGlobal('location', new URL('https://workspace.test/'));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const m: EngineManifest = {
	...baseManifest,
	workspace: { tz: 'UTC', locale: 'en', apps: ['sales', 'hr'] },
	agent: { internal: 'brief', skills: {} },
	apps: {
		sales: {
			title: 'Sales',
			description: 'd',
			icon: 'i',
			pages: { deals: { title: 'Deals' }, quotes: { title: 'Quotes' } }
		},
		'hr/kiosk': {
			title: 'Kiosk',
			description: 'd',
			icon: 'i',
			pages: { clock: { title: 'Clock', portal: true } }
		},
		'hr/people': {
			title: 'People',
			description: 'd',
			icon: 'i',
			pages: { list: { title: 'List' } }
		},
		portal: {
			title: 'Portal',
			description: 'd',
			icon: 'i',
			audience: 'external',
			pages: { home: { title: 'Home' } }
		},
		both: {
			title: 'Both',
			description: 'd',
			icon: 'i',
			audience: 'all',
			pages: { home: { title: 'Home' } }
		},
		careers: {
			title: 'Careers',
			description: 'd',
			icon: 'i',
			audience: { public: ['applicant'], challenge: 'turnstile' },
			pages: { apply: { title: 'Apply' } }
		},
		clock: {
			title: 'Clock',
			description: 'd',
			icon: 'i',
			shell: 'kiosk',
			audience: 'members',
			policies: ['kiosk_clock'],
			pages: { clock: { title: 'Clock' } }
		},
		lobby: {
			title: 'Lobby',
			description: 'd',
			icon: 'i',
			shell: 'kiosk',
			audience: { public: ['lobby_public'] },
			pages: { welcome: { title: 'Welcome' } }
		}
	},
	groups: { hr: { title: 'HR', icon: 'g', default_child: 'people' } }
};
const member = (
	apps: string[],
	over: Partial<Extract<EngineActor, { kind: 'member' }>> = {},
	admin = false
): Authority => ({
	key: 'k',
	admin,
	policies: [],
	models: {},
	automations: [],
	limits: [],
	teamTree: [],
	scopes: {},
	actor: {
		kind: 'member',
		id: 'u1',
		email: null,
		phone: null,
		external: false,
		teams: [],
		team_path: [],
		admin,
		party: null,
		...over
	},
	capabilities: { apps, syncs: [], tools: [], mcp: [] }
});
const names = (ns: ReturnType<typeof nav>): unknown[] =>
	ns.map((n) => (n.kind === 'group' ? { [n.name]: names(n.children) } : n.name));

describe('app visibility (§3.9, capabilities.apps)', () => {
	it('a member whose policy names a public app opens it as themselves; `*`, other staff and administrators stay its visitor', () => {
		expect(can_open(m, member(['careers'], { external: true }), 'careers')).toBe(true);
		expect(holds_public(member(['careers'], { external: true }), 'careers')).toBe(true);
		expect(holds_public(member(['*']), 'careers')).toBe(false);
		expect(holds_public(member(['sales']), 'careers')).toBe(false);
		expect(holds_public(member(['careers'], {}, true), 'careers')).toBe(false);
	});
	it('staff see members/all apps their policies admit, by name, * or group prefix', () => {
		expect(can_open(m, member(['sales']), 'sales')).toBe(true);
		expect(can_open(m, member(['sales']), 'hr/kiosk')).toBe(false);
		expect(can_open(m, member(['hr']), 'hr/kiosk')).toBe(true);
		expect(can_open(m, member(['hr/kiosk']), 'hr/people')).toBe(false);
		expect(can_open(m, member(['*']), 'both')).toBe(true);
		expect(can_open(m, member(['*']), 'portal')).toBe(false);
		expect(can_open(m, member(['*']), 'careers')).toBe(false);
	});
	it('externals see only external/all apps; admins see every app; visitors only their own', () => {
		const ext = member(['*'], { external: true });
		expect(['sales', 'portal', 'both'].map((a) => can_open(m, ext, a))).toEqual([
			false,
			true,
			true
		]);
		const apps = Object.entries(m.apps).filter(([, app]) => app.shell !== 'kiosk');
		expect(apps.every(([name]) => can_open(m, member([], {}, true), name))).toBe(true);
		const visitor: Authority = {
			...member([]),
			actor: { kind: 'visitor', app: 'careers', visitor: 'v' }
		};
		expect(Object.keys(m.apps).filter((a) => can_open(m, visitor, a))).toEqual(['careers']);
	});
	it("the shell renders only its nav's apps: an external's members app is no access", () => {
		expect(nav_apps(nav(m, member(['*'], { external: true })))).toEqual(['both', 'portal']);
		expect(nav_apps(nav(m, member(['hr'])))).toEqual(['hr/people', 'hr/kiosk']);
	});
	it('externals and visitors get no settings, runs or staff inbox; the agent follows the briefs', () => {
		expect(surfaces(m, member([]).actor, true)).toEqual({
			inbox: true,
			runs: true,
			settings: true,
			agent: true,
			studio: false
		});
		expect(surfaces(m, member([]).actor, true, true).studio).toBe(true);
		// every staff member authors their own draft; the host decides what a non-administrator may do
		expect(surfaces(m, member([]).actor, false, true)).toMatchObject({
			studio: true,
			settings: false
		});
		expect(surfaces(m, member([], { external: true }).actor, false, true).studio).toBe(false);
		expect(surfaces(m, member([], { external: true }).actor, false)).toEqual({
			inbox: false,
			runs: false,
			settings: false,
			agent: false,
			studio: false
		});
		expect(surfaces(m, { kind: 'visitor', app: 'careers', visitor: 'v' }, false).agent).toBe(false);
	});
});

describe('exposure (the boot catalog ui reads)', () => {
	it.effect(
		'accepts an unlabelled model and preserves an explicit text index without inventing an identifier',
		() =>
			Effect.gen(function* () {
				const source: EngineManifest = {
					...em,
					models: {
						...em.models,
						jobs: {
							description: 'Jobs',
							fields: { title: { kind: 'text' } },
							search: { text: ['title'] }
						}
					}
				};
				const model = (yield* exposure(source, { ...member([]), admin: true })).jobs;
				expect(model?.label).toEqual([]);
				expect(model?.record_label).toBeUndefined();
				expect(model?.search).toEqual(['title']);
				expect(
					(yield* exposure(
						{
							...source,
							models: {
								...source.models,
								jobs: { description: 'Jobs', fields: { title: { kind: 'text' } } }
							}
						},
						{ ...member([]), admin: true }
					)).jobs?.search
				).toBeUndefined();
			})
	);
	const TRUE = { t: 'const', value: true } as const;
	/** One policy `p`'s access points on a model: none unless named (decision 3: reads and write columns per path). */
	const access = (over: Partial<ModelAuthority> = {}): ModelAuthority => ({
		read: {},
		create: [],
		update: [],
		delete: [],
		moves: {},
		...over
	});
	const em = Result.getOrThrow(
		decode_manifest({
			...baseManifest,
			models: {
				jobs: {
					description: 'Work orders on site',
					record_label: 'record.title',
					fields: { title: { kind: 'text' }, pay: { kind: 'money' }, notes: { kind: 'text' } },
					search: { text: ['title'] }
				},
				sites: {
					description: 'Work sites',
					record_label: 'record.name',
					fields: { name: { kind: 'text' } }
				}
			},
			relationships: { 'jobs.site': { to: 'sites', optional: true } },
			exposures: {
				jobs: {
					outputs: {
						default: { jobs: { fields: ['title', 'pay', 'site'] }, 'jobs.site': { fields: 'all' } }
					},
					update: { columns: { jobs: ['title'] } }
				}
			},
			integrations: {}
		} satisfies EngineManifest)
	);
	it.effect(
		"exposes the columns a write arm admits, with or without its policy's check (the verdict comes at write time)",
		() =>
			Effect.gen(function* () {
				const source: EngineManifest = {
					...em,
					exposures: {
						jobs: {
							outputs: { default: { jobs: { fields: ['title', 'pay'] } } },
							create: { columns: { jobs: ['title', 'pay'] } },
							update: { columns: { jobs: ['title', 'pay'] } }
						}
					}
				};
				const auth: Authority = {
					...member([]),
					models: {
						jobs: access({
							read: { default: { jobs: [{ policy: 'p', where: TRUE }] } },
							create: [{ policy: 'p', columns: { jobs: ['title'] }, check: true }],
							update: [{ policy: 'p', columns: { jobs: ['title'] }, check: false }]
						})
					}
				};
				expect((yield* exposure(source, auth))['jobs']).toMatchObject({
					create: { columns: ['title'] },
					update: { columns: ['title'] }
				});
				expect((yield* exposure(source, auth))['jobs']?.create).not.toHaveProperty('proposal_only');
			})
	);
	it.effect("names a file sync's required context, which a toolbar without it cannot start", () =>
		Effect.gen(function* () {
			const source: EngineManifest = {
				...em,
				exposures: {
					jobs: {
						outputs: { default: { jobs: { fields: ['title'] } } },
						syncs: {
							report: {
								with: 'file',
								parser: ['json'],
								schema: { name: { kind: 'text' } },
								context: {
									ids: { kind: 'ref', to: 'jobs', many: true },
									kind: { kind: 'enum', values: ['A', 'B'], default: 'A' },
									at: { kind: 'instant', optional: true }
								},
								write: true
							},
							sheet: { with: 'file', parser: ['csv'] }
						}
					}
				}
			};
			const auth: Authority = {
				...member([]),
				models: { jobs: access({ read: { default: { jobs: [{ policy: 'p', where: TRUE }] } } }) }
			};
			expect((yield* exposure(source, auth))['jobs']?.syncs).toEqual({
				report: { kind: 'file', parser: ['json'], export: ['json'], context: ['ids'] },
				sheet: { kind: 'file', parser: ['csv'], export: ['csv'] }
			});
		})
	);
	it.effect(
		'exposes native integration instance forms by their grants without exposing the host fence',
		() =>
			Effect.gen(function* () {
				const admin = (yield* exposure(em, { ...member([]), admin: true }))['sys_integration'];
				expect(admin).toMatchObject({
					create: { columns: ['integration', 'name', 'owner', 'envoy', 'configuration'] },
					update: { columns: ['name', 'envoy', 'active', 'configuration', 'import_start'] },
					relations: { owner: { targets: ['sys_user'], optional: true } }
				});
				expect(admin?.fields).not.toHaveProperty('epoch');
				expect((yield* exposure(em, member([])))['sys_integration']).toBeUndefined();
				const auth: Authority = {
					...member([]),
					models: {
						sys_integration: access({
							read: { default: { sys_integration: [{ policy: 'p', where: TRUE }] } },
							update: [
								{ policy: 'p', columns: { sys_integration: ['configuration'] }, check: false }
							]
						})
					}
				};
				const restricted = (yield* exposure(em, auth))['sys_integration'];
				expect(restricted?.update?.columns).toEqual(['configuration']);
				expect(restricted?.create).toBeUndefined();
				expect(restricted?.fields).not.toHaveProperty('epoch');
			})
	);
	it.effect(
		'a declared write layer exposes its child identity (model, parent FK, owned) beside the read layer',
		() =>
			Effect.gen(function* () {
				const source: EngineManifest = {
					...em,
					models: {
						...em.models,
						lines: {
							record_label: 'record.amount',
							description: 'Order lines.',
							fields: { amount: { kind: 'int' } }
						}
					},
					relationships: { 'lines.job': { to: 'jobs', inverse: 'lines', owned: true } },
					exposures: {
						jobs: {
							outputs: { default: { jobs: { fields: 'all' }, 'jobs.lines': { fields: 'all' } } },
							update: { columns: { jobs: ['title'], 'jobs.lines': ['amount'] } }
						},
						lines: {
							outputs: { default: { lines: { fields: 'all' } } },
							create: { columns: { lines: ['amount', 'job'] } },
							update: { columns: { lines: ['amount'] } }
						}
					}
				};
				const catalog = yield* exposure(source, { ...member([]), admin: true });
				// the write layer carries the child's own columns, as its form edits them in place
				expect(catalog['jobs']?.update?.with?.['lines']).toEqual({
					model: 'lines',
					parent: 'job',
					owned: true,
					create: { columns: ['amount'] },
					update: { columns: ['amount'] },
					delete: true
				});
				expect(catalog['jobs']?.children?.['lines']).toEqual({
					model: 'lines',
					parent: 'job',
					owned: true
				});
			})
	);
	it.effect("sends a relationship's where so a picker offers only what a write accepts", () =>
		Effect.gen(function* () {
			const narrowed: EngineManifest = {
				...em,
				relationships: {
					'jobs.site': { to: 'sites', optional: true, where: { title: { eq: 'Yard' } } }
				},
				exposures: {
					jobs: {
						outputs: {
							default: { jobs: { fields: ['title', 'site'] }, 'jobs.site': { fields: 'all' } }
						}
					}
				}
			};
			expect(
				(yield* exposure(narrowed, { ...member([]), admin: true }))['jobs']?.relations
			).toEqual({
				site: { targets: ['sites'], optional: true, where: { title: { eq: 'Yard' } } }
			});
		})
	);
	it.effect(
		'exposes readable source-owned fields with a restriction reason and keeps owned parents immutable',
		() =>
			Effect.gen(function* () {
				const source: EngineManifest = {
					...em,
					relationships: { 'jobs.site': { to: 'sites', optional: true, owned: true } },
					exposures: {
						jobs: {
							outputs: {
								default: {
									jobs: { fields: ['title', 'pay', 'site'] },
									'jobs.site': { fields: 'all' }
								}
							},
							update: { columns: { jobs: ['title', 'site'] } },
							syncs: { jobs: { with: 'operations', read: true } }
						}
					},
					integrations: {
						operations: {
							description: 'Operations source',
							driver: 'sqlserver',
							configuration: {}
						}
					}
				};
				const catalog = yield* exposure(source, { ...member([]), admin: true });
				expect(catalog['jobs']).toMatchObject({
					update: { columns: ['title'] },
					fields: { pay: { kind: 'money' } },
					relations: { site: { targets: ['sites'] } },
					readonly_fields: { pay: 'sync_owned', site: 'owned_parent' },
					syncs: { jobs: { kind: 'remote', with: 'operations' } }
				});
				expect((yield* exposure(source, member([])))['jobs']).toBeUndefined();
				const auth: Authority = {
					...member([]),
					models: {
						jobs: access({ read: { default: { jobs: [{ policy: 'p', where: TRUE }] } } })
					}
				};
				expect((yield* exposure(source, auth))['jobs']?.syncs).toBeUndefined();
				expect(
					(yield* exposure(source, { ...auth, capabilities: { ...auth.capabilities, syncs: ['jobs.jobs'] } }))['jobs']?.syncs
				).toEqual({
					jobs: { kind: 'remote', with: 'operations' }
				});
			})
	);
	it.effect(
		'sends relations, guarded write inputs and the fields of the output the views read; never an unexposed field',
		() =>
			Effect.gen(function* () {
				const auth: Authority = {
					...member([]),
					models: {
						jobs: access({
							read: { default: { jobs: [{ policy: 'p', where: TRUE }] } },
							update: [{ policy: 'p', columns: { jobs: ['title'] }, check: false }]
						})
					}
				};
				expect(yield* exposure(em, auth)).toEqual({
					jobs: {
						audit: false,
						label: ['title'],
						label_paths: ['title'],
						record_label: 'record.title',
						search: ['$label', 'title'],
						fields: { title: { kind: 'text' }, pay: { kind: 'money' } },
						relations: { site: { targets: ['sites'], optional: true } },
						layers: ['site'],
						update: { columns: ['title'] },
						description: 'Work orders on site'
					}
				});
			})
	);
	it.effect(
		'a caller holding only a named output reads that output: its fields, its layers, its name',
		() =>
			Effect.gen(function* () {
				const jobs = em.exposures['jobs'];
				if (jobs === undefined) throw new Error('Missing jobs exposure');
				const source: EngineManifest = {
					...em,
					exposures: {
						jobs: {
							...jobs,
							outputs: { ...jobs.outputs, brief: { jobs: { fields: ['title'] } } }
						}
					}
				};
				const auth: Authority = {
					...member([]),
					models: { jobs: access({ read: { brief: { jobs: [{ policy: 'p', where: TRUE }] } } }) }
				};
				expect((yield* exposure(source, auth))['jobs']).toEqual({
					audit: false,
					label: ['title'],
					label_paths: ['title'],
					record_label: 'record.title',
					search: ['$label', 'title'],
					fields: { title: { kind: 'text' } },
					output: 'brief',
					description: 'Work orders on site'
				});
				// granted both, the views read `default`
				const both: Authority = {
					...auth,
					models: {
						jobs: access({
							read: {
								default: { jobs: [{ policy: 'p', where: TRUE }] },
								brief: { jobs: [{ policy: 'p', where: TRUE }] }
							}
						})
					}
				};
				expect((yield* exposure(source, both))['jobs']).not.toHaveProperty('output');
				expect((yield* exposure(source, both))['jobs']?.fields).toHaveProperty('pay');
			})
	);
	it.effect('sends a readable computed field, so a label naming one resolves (A5)', () =>
		Effect.gen(function* () {
			const withComputed = Result.getOrThrow(
				decode_manifest({
					...baseManifest,
					...em,
					models: {
						...em.models,
						jobs: {
							...required(em.models['jobs']),
							record_label: 'record.code',
							computed: {
								code: { kind: 'text', expr: { field: 'title' } },
								quantity: { kind: 'decimal', scale: 6, expr: 1 }
							}
						}
					},
					exposures: {
						jobs: { ...em.exposures['jobs'], outputs: { default: { jobs: { fields: 'all' } } } }
					}
				})
			);
			expect((yield* exposure(withComputed, { ...member([]), admin: true }))['jobs']).toMatchObject(
				{
					record_label: 'record.code',
					label: ['code'],
					fields: {
						title: { kind: 'text' },
						code: { kind: 'text' },
						quantity: { kind: 'decimal', scale: 6 }
					}
				}
			);
			expect(
				required((yield* exposure(em, { ...member([]), admin: true }))['jobs']).fields
			).not.toHaveProperty('code');
		})
	);
	it.effect('a roll-up sum over a money field keeps its money and literal currency (A9)', () =>
		Effect.gen(function* () {
			const orders = Result.getOrThrow(
				decode_manifest({
					...baseManifest,
					...em,
					models: {
						...em.models,
						orders: {
							description: 'orders',
							record_label: 'record.code',
							fields: {
								code: { kind: 'text' },
								total: { kind: 'sum', of: 'lines.amount' },
								qty: { kind: 'sum', of: 'lines.n' }
							}
						},
						lines: {
							description: 'lines',
							record_label: 'record.code',
							fields: {
								code: { kind: 'text' },
								amount: { kind: 'money', currency: 'SGD' },
								n: { kind: 'decimal', scale: 2 }
							}
						}
					},
					relationships: { ...em.relationships, 'lines.order': { to: 'orders', inverse: 'lines' } },
					exposures: { orders: { outputs: { default: { orders: { fields: 'all' } } } } }
				})
			);
			expect(
				required((yield* exposure(orders, { ...member([]), admin: true }))['orders']).fields
			).toEqual({
				code: { kind: 'text' },
				total: { kind: 'sum', of: 'lines.amount', money: { currency: 'SGD' } },
				qty: { kind: 'sum', of: 'lines.n' }
			});
		})
	);
	it.effect(
		"a roll-up sum over money in a per-row currency reads in the parent's same-named currency field",
		() =>
			Effect.gen(function* () {
				const orders = Result.getOrThrow(
					decode_manifest({
						...baseManifest,
						...em,
						models: {
							...em.models,
							orders: {
								description: 'orders',
								record_label: 'record.code',
								fields: {
									code: { kind: 'text' },
									currency: { kind: 'currency' },
									total: { kind: 'sum', of: 'lines.amount' }
								}
							},
							lines: {
								description: 'lines',
								record_label: 'record.code',
								fields: {
									code: { kind: 'text' },
									currency: { kind: 'currency' },
									amount: { kind: 'money', currency: 'currency' }
								}
							},
							bills: {
								description: 'bills',
								record_label: 'record.code',
								fields: { code: { kind: 'text' }, total: { kind: 'sum', of: 'bill_lines.amount' } }
							}
						},
						relationships: {
							...em.relationships,
							'lines.order': { to: 'orders', inverse: 'lines' },
							'lines.bill': { to: 'bills', inverse: 'bill_lines' }
						},
						exposures: {
							orders: { outputs: { default: { orders: { fields: 'all' } } } },
							bills: { outputs: { default: { bills: { fields: 'all' } } } }
						}
					})
				);
				const x = yield* exposure(orders, { ...member([]), admin: true });
				expect(required(x['orders']).fields['total']).toEqual({
					kind: 'sum',
					of: 'lines.amount',
					money: { currency: 'currency' }
				});
				// a parent without that field shows the sum in the workspace default
				expect(required(x['bills']).fields['total']).toEqual({
					kind: 'sum',
					of: 'bill_lines.amount',
					money: {}
				});
			})
	);
	it.effect(
		"a create form offers only the columns the holder's create arms admit; the host fills the rest",
		() =>
			Effect.gen(function* () {
				const withCreate = Result.getOrThrow(
					decode_manifest({
						...baseManifest,
						...em,
						exposures: {
							jobs: { ...em.exposures['jobs'], create: { columns: { jobs: ['title', 'notes'] } } }
						}
					})
				);
				const auth: Authority = {
					...member([]),
					models: {
						jobs: access({ create: [{ policy: 'p', columns: { jobs: ['title'] }, check: false }] })
					}
				};
				expect((yield* exposure(withCreate, auth))['jobs']).toMatchObject({
					create: { columns: ['title'] },
					fields: { title: { kind: 'text' } }
				});
				expect(
					required((yield* exposure(withCreate, { ...auth, admin: true }))['jobs']).create
				).toEqual({
					columns: ['title', 'notes']
				});
				const filled = Result.getOrThrow(
					decode_manifest({
						...baseManifest,
						...withCreate,
						exposures: {
							jobs: {
								...required(withCreate.exposures['jobs']),
								create: {
									columns: { jobs: ['title', 'notes'] },
									filled: { jobs: ['title', 'notes'] }
								}
							}
						}
					})
				);
				expect(required((yield* exposure(filled, auth))['jobs']).create).toEqual({
					columns: ['title'],
					filled: ['title']
				});
				expect(
					required((yield* exposure(filled, { ...auth, admin: true }))['jobs']).create
				).toEqual({
					columns: ['title', 'notes'],
					filled: ['title', 'notes']
				});
			})
	);
	it.effect(
		'exposes the system models the caller reads, so a picker at sys_user labels its rows',
		() =>
			Effect.gen(function* () {
				const auth: Authority = {
					...member([]),
					models: {
						sys_user: access({
							read: { directory: { sys_user: [{ policy: '$directory', where: TRUE }] } }
						})
					}
				};
				expect((yield* exposure(em, auth))['sys_user']).toEqual({
					label: ['name'],
					label_paths: ['name'],
					record_label: 'record.name',
					search: ['$label', 'name'],
					fields: { name: { kind: 'text' } },
					output: 'directory'
				});
			})
	);
});

describe('nav tree', () => {
	it('orders top level by workspace.apps then name, nests groups with the default child first, drops empty groups', () => {
		expect(names(nav(m, member(['sales', 'hr', 'both'])))).toEqual([
			'sales',
			{ hr: ['hr/people', 'hr/kiosk'] },
			'both'
		]);
		expect(names(nav(m, member(['sales'])))).toEqual(['sales']);
		const [sales, hr] = nav(m, member(['sales', 'hr']));
		expect(sales).toMatchObject({
			href: '/app/sales/deals',
			pages: [{ name: 'deals', href: '/app/sales/deals' }, { name: 'quotes' }]
		});
		expect(hr).toMatchObject({ kind: 'group', href: '/app/hr/people/list' });
	});

	it('nests a group under another group', () => {
		const nested: EngineManifest = {
			...m,
			apps: {
				...m.apps,
				'hr/settings/lineage': {
					title: 'Lineage',
					description: 'd',
					icon: 'i',
					pages: { lineage: { title: 'Lineage' } }
				},
				'hr/settings/change_log': {
					title: 'Change log',
					description: 'd',
					icon: 'i',
					pages: { change_log: { title: 'Change log' } }
				}
			},
			groups: {
				...m.groups,
				'hr/settings': { title: 'Settings', icon: 'i', default_child: 'lineage' }
			}
		};
		const [, hr] = nav(nested, member(['sales', 'hr']));
		const settings =
			hr?.kind === 'group' ? hr.children.find((child) => child.name === 'hr/settings') : undefined;
		expect(settings).toMatchObject({ kind: 'group', href: '/app/hr/settings/lineage' });
		expect(settings?.kind === 'group' ? settings.children.map((child) => child.name) : []).toEqual([
			'hr/settings/lineage',
			'hr/settings/change_log'
		]);
	});

	it('an app folder and its page of the same name share one canonical path', () => {
		const nested: EngineManifest = {
			...m,
			apps: {
				...m.apps,
				'hr/entities': {
					title: 'Entities',
					description: 'd',
					icon: 'i',
					pages: { entities: { title: 'Entities' } }
				}
			}
		};
		const [, hr] = nav(nested, member(['sales', 'hr']));
		const entities =
			hr?.kind === 'group' ? hr.children.find((child) => child.name === 'hr/entities') : undefined;
		expect(entities?.href).toBe('/app/hr/entities');
		expect(route(nested, new URL('/app/hr/entities', 'https://w.example'))).toEqual({
			kind: 'page',
			app: 'hr/entities',
			page: 'entities'
		});
	});
});

describe('preview environments drop the meta tools', () => {
	const at = (path: string) => preview_route(route(m, new URL(path, 'https://w.example')), true);
	it('an administrator on a Studio host keeps the inbox, runs and Settings but not Norbius or Studio', () => {
		expect(surfaces(m, member([], {}, true).actor, true, true, true)).toEqual({
			inbox: true,
			runs: true,
			settings: true,
			agent: false,
			studio: false
		});
	});
	it('Studio, People and Integrations open the apps launcher; apps, approvals and other Settings stay', () => {
		expect(
			['/studio', '/studio/changes', '/command-center/people', '/settings/integrations'].map(at)
		).toEqual(Array.from({ length: 4 }, () => ({ kind: 'home' })));
		expect(at('/app/sales/quotes')).toEqual({ kind: 'page', app: 'sales', page: 'quotes' });
		expect([
			at('/inbox'),
			at('/settings/organization'),
			at('/command-center/automations'),
			at('/settings/secrets')
		]).toEqual([
			{ kind: 'inbox' },
			{ kind: 'settings', tab: 'organization' },
			{ kind: 'command_center', tab: 'automations' },
			{ kind: 'settings', tab: 'secrets' }
		]);
		expect(preview_route({ kind: 'studio' }, false)).toEqual({ kind: 'studio' });
	});
	it('the sidebar drops Norbius, People and Studio and keeps Approvals and the rest of Settings', () => {
		const auth = member(['sales'], {}, true);
		const model = navigation_model(
			{
				workspace: { name: 'Acme', locale: 'en', tz: 'UTC', live: 'https://acme.example' },
				actor: auth.actor,
				name: 'Ada',
				admin: true,
				preview: null,
				nav: nav(m, auth),
				kiosks: [],
				surfaces: surfaces(m, auth.actor, true, true, true),
				inbox: 2,
				push: null,
				visitor: null,
				automations: {},
				read_catalog: {},
				operation_outputs: { automations: {} },
				catalog: {}
			},
			'/',
			(k) => k
		);
		const keys = [...model.sections, ...model.utilities].flatMap((x) =>
			'items' in x ? x.items.map((i) => i.key) : [x.key, ...(x.children ?? []).map((c) => c.key)]
		);
		expect(keys).toEqual(
			expect.arrayContaining(['approvals', 'command-center', 'organization', 'secrets'])
		);
		expect(keys.filter((k) => ['norbius', 'integrations', 'studio'].includes(k))).toEqual([]);
		// no People and no Studio inspection in a preview: the audit trail, runs and inference stay
		expect(command_center_tabs(surfaces(m, auth.actor, true, true, true), true, true)).toEqual([
			'audit',
			'automations'
		]);
	});
	it('the command center: inspection needs a Studio host, the rest follows the viewer', () => {
		const admin = member([], {}, true).actor,
			staff = member([]).actor;
		// tethered (Colony serves Studio): every tab
		expect(command_center_tabs(surfaces(m, admin, true, true), true, false)).toEqual([
			'bundle',
			'telemetry',
			'logs',
			'audit',
			'automations',
			'inference',
			'people'
		]);
		// untethered: no host inspection, the rest stays
		expect(command_center_tabs(surfaces(m, admin, true), true, false)).toEqual([
			'audit',
			'automations',
			'inference',
			'people'
		]);
		// a staff member: their runs only; an external: none
		expect(command_center_tabs(surfaces(m, staff, false, true), false, false)).toEqual([
			'automations'
		]);
		expect(
			command_center_tabs(surfaces(m, member([], { external: true }).actor, false), false, false)
		).toEqual([]);
	});
});

describe('routes and hrefs', () => {
	const at = (path: string) => route(m, new URL(path, 'https://w.example'));
	it('resolves the longest app prefix, the default page and a record', () => {
		expect(at('/app/hr/kiosk/clock')).toEqual({ kind: 'page', app: 'hr/kiosk', page: 'clock' });
		// one spelling per page: a named page is never also its app's folder, and the folder's own-leaf page is only the folder
		expect([at('/app/sales'), at('/app/sales/deals'), at('/app/sales/')]).toEqual([
			{ kind: 'not_found' },
			{ kind: 'page', app: 'sales', page: 'deals' },
			{ kind: 'not_found' }
		]);
		expect(at(href('sales', 'quotes', { model: 'quotes', id: 'q/1' }))).toEqual({
			kind: 'page',
			app: 'sales',
			page: 'quotes',
			record: { model: 'quotes', id: 'q/1' }
		});
		expect(at('/app/sales/nope')).toEqual({ kind: 'not_found' });
		expect(at('/app/hr')).toEqual({ kind: 'not_found' });
	});
	it('shell routes; sign-in keeps only a same-origin next', () => {
		expect(at('/inbox')).toEqual({ kind: 'inbox' });
		// runs and the workspace log live in the command center; there is no `/runs` or `/logs`
		expect([at('/runs'), at('/logs')]).toEqual([{ kind: 'not_found' }, { kind: 'not_found' }]);
		expect(at('/settings/secrets')).toEqual({ kind: 'settings', tab: 'secrets' });
		// no default or fallback tab: each other spelling is not found
		expect([
			at('/settings'),
			at('/settings/bogus'),
			at('/settings/people'),
			at('/settings/secrets/x'),
			at('/studio/workbench'),
			at('/sign-in/x'),
			at('/invite/abc/x'),
			at('/inbox/')
		]).toEqual(Array.from({ length: 8 }, () => ({ kind: 'not_found' })));
		// each command center tab is a stable deep link
		expect([
			at('/command-center'),
			at('/command-center/audit'),
			at('/command-center/people'),
			at('/command-center/x'),
			at('/command-center/audit/1')
		]).toEqual([
			{ kind: 'command_center' },
			{ kind: 'command_center', tab: 'audit' },
			{ kind: 'command_center', tab: 'people' },
			{ kind: 'not_found' },
			{ kind: 'not_found' }
		]);
		expect([at('/studio'), at('/studio/x')]).toEqual([{ kind: 'studio' }, { kind: 'not_found' }]);
		// L-BOLT-528: each Studio tab is a stable deep link; Live moved to the command center
		expect([
			at('/studio/changes'),
			at('/studio/versions'),
			at('/studio/live'),
			at('/studio/changes/1')
		]).toEqual([
			{ kind: 'studio', tab: 'changes' },
			{ kind: 'studio', tab: 'versions' },
			{ kind: 'not_found' },
			{ kind: 'not_found' }
		]);
		expect(at('/invite/abc')).toEqual({ kind: 'invite', id: 'abc' });
		expect(at('/sign-in?next=/app/sales')).toEqual({ kind: 'sign_in', next: '/app/sales' });
		expect(at('/sign-in?next=//evil.example')).toEqual({ kind: 'sign_in' });
	});
	it('only public pages, sign-in and invitation open signed out; there is no registration page', () => {
		expect(at('/register/t')).toEqual({ kind: 'not_found' });
		expect(
			['/app/careers/apply', '/sign-in', '/invite/x'].every((p) => is_open_route(m, at(p)))
		).toBe(true);
		expect(['/app/sales', '/inbox', '/'].some((p) => is_open_route(m, at(p)))).toBe(false);
	});
});

describe('visitor fetch (§5.10, GAPS r5 11)', () => {
	it.live(
		'names the app on every /__bolt request and spends one fresh token per act and upload',
		() =>
			Effect.gen(function* () {
				const seen: { url: string; app: string | null; token: string | null }[] = [];
				const f: typeof fetch = async (input, init = {}) => {
					const hs = new Headers(init.headers);
					seen.push({
						url: String(input),
						app: hs.get('Bolt-App'),
						token: hs.get('Bolt-Challenge')
					});
					return new Response('{}');
				};
				let resets = 0;
				const close = mount_edge(ManagedRuntime.make(Layer.empty));
				yield* Effect.addFinalizer(() =>
					Effect.tryPromise({ try: close, catch: (cause) => new Error(String(cause)) }).pipe(
						Effect.orDie
					)
				);
				const queue = yield* challenge_queue(() => resets++);
				const vf = visitor_fetch('careers', queue, f);
				yield* Effect.tryPromise({
					try: () => vf('/__bolt/q', { method: 'POST' }),
					catch: (cause) => new Error(String(cause))
				});
				const act = vf('/__bolt/act', { method: 'POST' });
				queue.put('t1');
				yield* Effect.tryPromise({ try: () => act, catch: (cause) => new Error(String(cause)) });
				queue.put('t2');
				yield* Effect.tryPromise({
					try: () => vf('/__bolt/files/applications.cv', { method: 'PUT' }),
					catch: (cause) => new Error(String(cause))
				});
				queue.put('t3');
				yield* Effect.tryPromise({
					try: () => vf('/__bolt/session/code', { method: 'POST' }),
					catch: (cause) => new Error(String(cause))
				});
				yield* Effect.tryPromise({
					try: () => vf('/assets/x.png'),
					catch: (cause) => new Error(String(cause))
				});
				expect(seen).toEqual([
					{ url: '/__bolt/q', app: 'careers', token: null },
					{ url: '/__bolt/act', app: 'careers', token: 't1' },
					{ url: '/__bolt/files/applications.cv', app: 'careers', token: 't2' },
					{ url: '/__bolt/session/code', app: 'careers', token: 't3' },
					{ url: '/assets/x.png', app: null, token: null }
				]);
				expect(resets).toBe(3);
			})
	);
	it.live(
		'names the kiosk on every /__bolt request while on a kiosk route, and nothing elsewhere',
		() =>
			Effect.tryPromise({
				try: async () => {
					const seen: { url: string; kiosk: string | null }[] = [];
					const f: typeof fetch = async (input, init = {}) => {
						seen.push({ url: String(input), kiosk: new Headers(init.headers).get('Bolt-Kiosk') });
						return new Response('{}');
					};
					let at: string | null = 'lobby';
					const kf = kiosk_fetch(() => at, f);
					await kf('/__bolt/q', { method: 'POST' });
					await kf('/assets/x.png');
					at = null;
					await kf('/__bolt/q', { method: 'POST' });
					expect(seen).toEqual([
						{ url: '/__bolt/q', kiosk: 'lobby' },
						{ url: '/assets/x.png', kiosk: null },
						{ url: '/__bolt/q', kiosk: null }
					]);
				},
				catch: (cause) => new Error(String(cause))
			})
	);
	it('a visitor subscribes pages, records and read requests of the roots it reads only; members subscribe anything', () => {
		const admits = BoltRoutes['POST /__bolt/live'].admits;
		if (admits === undefined) throw new Error('The live route has no admission rule.');
		const visitor: Authority = {
			...member([]),
			actor: { kind: 'visitor', app: 'lobby', visitor: 'v' },
			models: {
				openings: {
					read: {
						kiosk: { openings: [{ policy: 'visitor', where: { t: 'const', value: true } }] }
					},
					create: [],
					update: [],
					delete: [],
					moves: {}
				}
			}
		};
		// a read request crosses as `query(request)`: every root must be one the visitor reads
		expect(admits(visitor, { m: 'query', a: [{ openings: {} }] })).toBe(true);
		expect(
			admits(visitor, { m: 'query', a: [{ openings: { where: { id: { eq: 'id' } } } }] })
		).toBe(true);
		expect(admits(visitor, { m: 'query', a: [{ orders: {} }] })).toBe(false);
		// the single-model form is gone: a model name and its arguments are no request
		expect(admits(visitor, { m: 'query', a: ['openings', {}] })).toBe(false);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(visitor, { m: 'aggregate', a: ['openings', {}] })
		).toBe(false);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(visitor, {
				m: 'query',
				a: [{ openings: {}, orders: {} }]
			})
		).toBe(false);
		expect(BoltRoutes['POST /__bolt/live'].admits(visitor, undefined)).toBe(false);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(member([]), { m: 'query', a: [{ orders: {} }] })
		).toBe(true);
	});
});

describe('startable automations', () => {
	it('Settings → Automations offers every automation the member may start, marking the ones needing a form', () => {
		const spec = (input?: EngineManifest['automations'][string]['input']) => ({
			description: 'd',
			policies: ['p'] as const,
			...(input === undefined ? {} : { input })
		});
		const withRuns: EngineManifest = {
			...m,
			automations: {
				drift: spec({ code: { kind: 'text', optional: true } }),
				lineage: spec({ code: { kind: 'text' } }),
				tick: spec()
			}
		};
		expect(
			startable_automations(withRuns, { ...member([]), automations: ['drift', 'lineage'] })
		).toEqual([
			{ name: 'drift', description: 'd', needs_input: false },
			{ name: 'lineage', description: 'd', needs_input: true }
		]);
		expect(startable_automations(withRuns, member([], {}, true)).map((a) => a.name)).toEqual([
			'drift',
			'lineage',
			'tick'
		]);
	});
});

describe('sidebar model', () => {
	const bootOf = (auth: Authority, studio = false) => ({
		workspace: { name: 'Acme', locale: 'en', tz: 'UTC' },
		actor: auth.actor,
		name: 'Ada',
		admin: auth.admin,
		preview: null,
		nav: nav(m, auth),
		kiosks: kiosk_nav(m, auth),
		surfaces: surfaces(m, auth.actor, auth.admin, studio),
		inbox: 2,
		push: null,
		visitor: null,
		automations: {},
		read_catalog: {},
		operation_outputs: { automations: {} },
		catalog: {}
	});
	const tree = (
		items: readonly { key: string; children?: readonly { key: string }[] }[] | undefined
	) => (items ?? []).map((i) => [i.key, (i.children ?? []).map((c) => c.key)]);
	it("an app's page at its folder's own address is not open beside the sibling below it", () => {
		const pages = [
			{ name: 'payroll', title: 'Runs', href: '/app/payroll' },
			{ name: 'compliance', title: 'Compliance', href: '/app/payroll/compliance' }
		];
		const boot = {
			...bootOf(member(['sales'])),
			nav: [
				{
					kind: 'app' as const,
					name: 'payroll',
					title: 'Payroll',
					description: '',
					icon: 'lucide:receipt',
					href: '/app/payroll',
					pages
				}
			]
		};
		const open = (path: string) =>
			active_app(navigation_model(boot, path, (k) => k))?.pages?.map((p) => [p.key, p.active]);
		expect(open('/app/payroll/compliance')).toEqual([
			['payroll/payroll', false],
			['payroll/compliance', true]
		]);
		expect(open('/app/payroll')).toEqual([
			['payroll/payroll', true],
			['payroll/compliance', false]
		]);
	});
	it("kiosks sit in the ellipsis menu's Kiosks group: members ones by capability, public ones for everyone", () => {
		expect(kiosk_nav(m, member([])).map((k) => k.name)).toEqual(['lobby']);
		expect(kiosk_nav(m, member([], {}, true)).map((k) => k.name)).toEqual(['clock', 'lobby']);
		expect(route(m, new URL('http://x/app/clock'))).toEqual({ kind: 'not_found' });
		expect(kiosk_nav(m, member(['clock'])).map((k) => k.name)).toEqual(['clock', 'lobby']);
		expect(kiosk_href('clock', 'clock')).toBe('/kiosk/clock/clock');
		expect(route(m, new URL('http://x/kiosk/clock/clock'))).toEqual({
			kind: 'kiosk',
			kiosk: 'clock',
			page: 'clock'
		});
		expect(route(m, new URL('http://x/kiosk/nope/clock'))).toEqual({ kind: 'not_found' });
		expect(frame_policy(m, '/kiosk/lobby/welcome')).toBe("frame-ancestors 'self'");
		expect(is_open_route(m, { kind: 'kiosk', kiosk: 'lobby', page: 'welcome' })).toBe(true);
		expect(is_open_route(m, { kind: 'kiosk', kiosk: 'clock', page: 'clock' })).toBe(false);
		expect(
			tree(navigation_model(bootOf(member(['clock'])), '/kiosk/clock/clock', (k) => k).utilities)
		).toContainEqual(['kiosks', ['clock', 'lobby']]);
	});
});

describe('Studio port boundary', () => {
	it('decodes only well-formed ops; a saved path stays inside the source', () => {
		expect(decodeOp({ op: 'rollback', commit: 'abc' })).toEqual({ op: 'rollback', commit: 'abc' });
		expect(decodeOp({ op: 'rollback', commit: 'abc', discard_data_since: 't' })).toEqual({
			op: 'rollback',
			commit: 'abc',
			discard_data_since: 't'
		});
		expect(
			decodeOp({ op: 'save', expected: 'h', files: { 'src/a.ts': 'x', 'b.ts': null } })
		).toMatchObject({ op: 'save' });
		expect([
			decodeOp({ op: 'rollback' }),
			decodeOp({ op: 'save', expected: 'h', files: { '../x': 'y' } }),
			decodeOp({ op: 'save', expected: 'h', files: { '/etc/x': 'y' } }),
			decodeOp({ op: 'save', expected: 'h', files: { a: 1 } }),
			decodeOp({ op: 'drop' }),
			decodeOp([])
		]).toEqual([null, null, null, null, null, null]);
	});
	it('accepts only current source edit and rollback keys', () => {
		expect(
			decodeOp({
				op: 'draft',
				path: 'src/a.ts',
				old_string: 'before',
				new_string: 'after',
				replace_all: true
			})
		).toMatchObject({ old_string: 'before', new_string: 'after', replace_all: true });
		expect([
			decodeOp({ op: 'draft', path: 'src/a.ts', oldString: 'before', newString: 'after' }),
			decodeOp({
				op: 'draft',
				path: 'src/a.ts',
				old_string: 'before',
				new_string: 'after',
				replaceAll: true
			}),
			decodeOp({ op: 'draft', patchText: '*** Begin Patch' }),
			decodeOp({ op: 'rollback', commit: 'c1', discardDataSince: 'yesterday' })
		]).toEqual([null, null, null, null]);
	});
	it("decodes a merge with the destructive steps it accepts, and a held request's decision", () => {
		expect([
			decodeOp({ op: 'change.merge', id: '1' }),
			decodeOp({ op: 'change.merge', id: '1', accept: ['drop column leave.days'] }),
			decodeOp({ op: 'approval.decide', id: 'a1', kind: 'approved' }),
			decodeOp({ op: 'approval.decide', id: 'a1', kind: 'rejected' })
		]).toEqual([
			{ op: 'change.merge', id: '1' },
			{ op: 'change.merge', id: '1', accept: ['drop column leave.days'] },
			{ op: 'approval.decide', id: 'a1', kind: 'approved' },
			{ op: 'approval.decide', id: 'a1', kind: 'rejected' }
		]);
		expect([
			decodeOp({ op: 'change.merge', id: '1', accept: [''] }),
			decodeOp({ op: 'change.merge' }),
			decodeOp({ op: 'approval.decide', id: 'a1', kind: 'changes_requested' }),
			decodeOp({ op: 'approval.decide', kind: 'approved' })
		]).toEqual([null, null, null, null]);
	});
	it('decodes current change operations and refuses incomplete input', () => {
		expect([
			decodeOp({ op: 'change.open', id: '3' }),
			decodeOp({ op: 'preview' }),
			decodeOp({ op: 'preview', id: '3' }),
			decodeOp({ op: 'change.rebase' }),
			decodeOp({ op: 'change.revert', commit: 'c0ffee' })
		]).toEqual([
			{ op: 'change.open', id: '3' },
			{ op: 'preview' },
			{ op: 'preview', id: '3' },
			{ op: 'change.rebase' },
			{ op: 'change.revert', commit: 'c0ffee' }
		]);
		expect([
			decodeOp({ op: 'change.open' }),
			decodeOp({ op: 'change.open', title: 'Leave rules' }),
			decodeOp({ op: 'change.close', id: '3' }),
			decodeOp({ op: 'change.revert' }),
			decodeOp({ op: 'preview', id: '' }),
			decodeOp({ op: 'preview', id: 3 })
		]).toEqual([null, null, null, null, null, null]);
	});
	it('edits a path in its language (L-BOLT-528)', () => {
		expect(['a.ts', 'b.svelte', 'c.json', 'd.md'].map(language_of)).toEqual([
			'javascript',
			'javascript',
			'json',
			'plaintext'
		]);
	});
	it('cuts the workbench manifest to the Manifest chips, each entry with its source path (L-BOLT-527)', () => {
		const manifest = Result.getOrThrow(
			decode_manifest({
				...baseManifest,
				workspace: { tz: 'UTC', locale: 'en', secrets: { API: { label: 'API' } } },
				models: {
					b: {
						description: 'B records',
						record_label: 'record.name',
						fields: { name: { kind: 'text' } }
					},
					a: {
						description: 'A records',
						record_label: 'record.name',
						fields: { name: { kind: 'text' } }
					}
				},
				apps: { x: { title: 'X', description: 'X workspace', icon: 'lucide:box', pages: {} } },
				policies: { rep: { description: 'Representative', grants: {} } },

				automations: { nightly: { description: 'Nightly task', policies: ['rep'] } },
				mcp: { docs: { description: 'Documentation tools', url: 'API' } },
				integrations: {
					mail: { description: 'Mailbox', driver: 'email' },
					stripe: {
						description: 'Stripe API',
						driver: 'http',
						http: { base_url: 'https://api.stripe.com' }
					}
				}
			} satisfies EngineManifest)
		);
		const files = Object.fromEntries(
			[
				'src/+workspace.ts',
				'src/+secrets.ts',
				'src/data/model/a/+model.ts',
				'src/data/model/b/+model.ts',
				'src/app/x/+app.ts',
				'src/access_control/policy/+rep.policy.ts',
				'src/automation/+nightly.automation.ts',
				'src/integration/stripe/+integration.ts',
				'src/agent/mcp/+docs.mcp.ts',
				'src/integration/mail/+integration.ts'
			].map((p) => [p, { bytes: 0 }])
		);
		const state: StudioState = {
			commit: 'h',
			files,
			changes: [],
			manifest,
			log: [],
			preview: null,
			releases: []
		};
		const v = studio_view(state);
		const names = Object.fromEntries(
			Object.entries(required(v.sections)).map(([s, es]) => [s, es.map((e) => e.name)])
		);
		expect(names).toEqual({
			models: ['a', 'b'],
			apps: ['x'],
			kiosks: [],
			policies: ['rep'],
			automations: ['nightly'],
			secrets: ['API']
		});
		expect(required(v.sections).models).toEqual([
			{ name: 'a', path: 'src/data/model/a/+model.ts' },
			{ name: 'b', path: 'src/data/model/b/+model.ts' }
		]);
		expect(v.sections?.policies).toEqual([
			{ name: 'rep', path: 'src/access_control/policy/+rep.policy.ts' }
		]);
		expect(required(v.sections).apps).toEqual([
			{ name: 'x', path: 'src/app/x/+app.ts', href: '/app/x' }
		]);
		expect('manifest' in v).toBe(false);
		expect(v.stale).toBeUndefined();
	});
	it('fails a manifest older than the source closed: no partial sections when a declared file is gone', () => {
		const manifest = Result.getOrThrow(
			decode_manifest({
				...baseManifest,
				workspace: { tz: 'UTC', locale: 'en' },
				models: {
					a: {
						description: 'A records',
						record_label: 'record.name',
						fields: { name: { kind: 'text' } }
					}
				},
				apps: { x: { title: 'X', description: 'X workspace', icon: 'lucide:box', pages: {} } },
				policies: {},

				automations: {},

				mcp: {},
				integrations: {}
			} satisfies EngineManifest)
		);
		const v = studio_view({
			commit: 'h',
			files: { 'src/app/x/+app.ts': { bytes: 0 } },
			changes: [],
			manifest,
			log: [],
			preview: null,
			releases: []
		});
		expect([v.sections, v.stale]).toEqual([null, true]);
		expect(
			studio_view({
				commit: 'h',
				files: {},
				changes: [],
				manifest: null,
				log: [],
				preview: null,
				releases: []
			})
		).toMatchObject({ sections: null });
	});
	it('suggests a save description from the drafts; a save carries it as its message', () => {
		const files = {
			'src/i18n/+messages.ts': { bytes: 0 },
			'src/data/+payroll.model.ts': { bytes: 0 }
		};
		expect(suggest_message({ 'src/i18n/+messages.ts': 'x' }, files)).toBe('Update i18n messages');
		expect(suggest_message({ 'src/data/+payroll.model.ts': null, 'notes.txt': 'n' }, files)).toBe(
			'Remove payroll model, Add notes'
		);
		expect(suggest_message({ a: '1', b: '2', c: '3' }, {})).toBe('Add a and 2 more files');
		expect(
			decodeOp({ op: 'save', expected: 'c', files: {}, message: 'Fix the label' })
		).toMatchObject({ message: 'Fix the label' });
		expect(decodeOp({ op: 'save', expected: 'c', files: {}, message: '' })).toBeNull();
	});
});

describe('reading files over the files port', () => {
	it.live('reads images and text; every other file is ingested', () =>
		Effect.gen(function* () {
			const stored: Record<string, { key: string; mime: string }> = {
				f1: { key: 'k1', mime: 'text/csv' },
				f2: { key: 'k2', mime: 'image/png' },
				f3: { key: 'k3', mime: 'application/pdf' },
				f4: { key: 'k4', mime: 'application/octet-stream' },
				f5: { key: 'k5', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
			};
			const db = TenantDb.typed({
				read: (queries) =>
					Effect.succeed([
						{
							rows: Object.values(stored).filter(
								(row) => row === stored[String(queries[0]?.params[0])]
							),
							affected: 0
						}
					]),
				write: () => Effect.die('unused write'),

				transaction: () => Effect.die('unused transaction')
			});
			const files = Files.of({
				get: (key) =>
					Effect.succeed(
						key === 'k5'
							? new Uint8Array(
									readFileSync(new URL('./fixtures/files/items.xlsx', import.meta.url))
								)
							: new TextEncoder().encode(`bytes of ${key}`)
					),
				put: () => Effect.die('unused put'),
				url: () => Effect.die('unused url'),
				remove: () => Effect.die('unused remove'),
				download: () => Effect.die('unused download')
			});
			const a = file_attachments(db, files, yield* hostImages);
			expect(yield* a.read({ id: 'f1', name: 'a.csv' })).toEqual({
				name: 'a.csv',
				mime: 'text/csv',
				text: 'bytes of k1'
			});
			expect(yield* a.read({ id: 'f2' })).toEqual({
				mime: 'image/png',
				bytes: new TextEncoder().encode('bytes of k2')
			});
			// a document, a workbook or any other binary is parsed by read_file, never read here
			for (const id of ['f3', 'f4', 'f5'])
				expect((yield* Effect.flip(a.read({ id }))).message).toContain(
					`read_file { id: '${id}' } parses it`
				);
			const missing = yield* Effect.flip(a.read({ id: 'nope' }));
			expect(missing.message).toMatch(/not stored/);
		})
	);
	it.live('reads a HEIC attachment as a derived JPEG, the image a model takes', () =>
		Effect.gen(function* () {
			const db = TenantDb.typed({
				read: () => Effect.succeed([{ rows: [{ key: 'k', mime: 'image/heic' }], affected: 0 }]),
				write: () => Effect.die('unused write'),

				transaction: () => Effect.die('unused transaction')
			});
			const files = Files.of({
				get: () =>
					Effect.succeed(
						new Uint8Array(readFileSync(new URL('./fixtures/files/photo.heic', import.meta.url)))
					),
				put: () => Effect.die('unused put'),
				url: () => Effect.die('unused url'),
				remove: () => Effect.die('unused remove'),
				download: () => Effect.die('unused download')
			});
			const got = yield* file_attachments(db, files, yield* hostImages).read({ id: 'f' });
			if (
				typeof got !== 'object' ||
				got === null ||
				!('bytes' in got) ||
				!(got.bytes instanceof Uint8Array)
			)
				throw new Error('Expected image bytes.');
			expect(got.mime).toBe('image/jpeg');
			expect([...got.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
		})
	);
});

describe('workspace media', () => {
	it('serves a relative asset path under /assets/, and leaves absolute and data URLs alone', () => {
		expect(media('app-media/people-banner.webp')).toBe('/assets/app-media/people-banner.webp');
		expect(media('/app-media/x.webp')).toBe('/app-media/x.webp');
		expect(media('https://cdn.test/x.webp')).toBe('https://cdn.test/x.webp');
		expect(media('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
	});
});

describe('embedding', () => {
	const partner = 'https://partner.example';
	const lobby = m.apps['lobby'];
	if (lobby === undefined) throw new Error('missing lobby fixture');
	const embedded: EngineManifest = {
		...m,
		apps: {
			...m.apps,
			'hr/kiosk': {
				title: 'Kiosk',
				description: 'd',
				icon: 'i',
				embed: [partner, 'https://b.example:8443'],
				pages: { clock: { title: 'Clock' } }
			},
			lobby: { ...lobby, embed: [partner] }
		}
	};
	it('an app or kiosk page is framed by the workspace and the origins its `embed` names; without `embed`, by the workspace alone', () => {
		expect(frame_policy(embedded, '/app/hr/kiosk/clock')).toBe(
			`frame-ancestors 'self' ${partner} https://b.example:8443`
		);
		expect(frame_policy(embedded, '/kiosk/lobby/welcome')).toBe(
			`frame-ancestors 'self' ${partner}`
		);
		expect(frame_policy(m, '/app/hr/kiosk/clock')).toBe("frame-ancestors 'self'");
		expect(frame_policy(m, '/kiosk/lobby/welcome')).toBe("frame-ancestors 'self'");
	});
	it('every other page, and a route that is none, is framed by the workspace alone', () => {
		expect(frame_policy(embedded, '/app/sales/deals')).toBe("frame-ancestors 'self'");
		expect(frame_policy(m, '/sign-in')).toBe("frame-ancestors 'self'");
		expect(frame_policy(m, '/nowhere')).toBe("frame-ancestors 'self'");
	});
	const post = (headers: Record<string, string>) =>
		new Request('https://acme.example/__bolt/q', { method: 'POST', headers });
	it('refuses a browser write another site started, framed or not; a page of this workspace and a webhook pass', () => {
		expect(cross_site(post({ 'sec-fetch-site': 'cross-site' }), 'https://acme.example')).toBe(true);
		expect(cross_site(post({ 'sec-fetch-site': 'same-site' }), 'https://acme.example')).toBe(true);
		expect(cross_site(post({ 'sec-fetch-site': 'same-origin' }), 'https://acme.example')).toBe(
			false
		); // a portal in another site's frame
		expect(cross_site(post({ origin: 'https://evil.example' }), 'https://acme.example')).toBe(true); // a browser without Sec-Fetch
		expect(cross_site(post({ origin: 'https://acme.example' }), 'https://acme.example/acme')).toBe(
			false
		);
		expect(cross_site(post({}), 'https://acme.example')).toBe(false); // a server's webhook
		expect(
			cross_site(
				new Request('https://acme.example/app/x', { headers: { 'sec-fetch-site': 'cross-site' } }),
				'https://acme.example'
			)
		).toBe(false);
	});
});

describe('shell HTTP failures', () => {
	for (const status of [403, 404, 429, 500, 502, 503, 504])
		it.effect(`preserves HTTP ${status} when the server answers HTML`, () =>
			Effect.gen(function* () {
				const result = yield* Effect.flip(
					shell_api(async () => new Response('<html>proxy error</html>', { status })).boot()
				);
				expect(result).toMatchObject({ status });
				expect(result.code).not.toBe('offline');
			})
		);
	it.effect('keeps the safe refusal reason', () =>
		Effect.gen(function* () {
			const result = yield* Effect.flip(
				shell_api(async () =>
					Response.json(
						{ error: { code: 'expired', message: 'The link expired.' } },
						{ status: 410 }
					)
				).boot()
			);
			expect(result).toMatchObject({ status: 410, message: 'The link expired.' });
		})
	);
	it.effect('answers every rateLimited refusal with the one friendly message', () =>
		Effect.gen(function* () {
			const result = yield* Effect.flip(
				shell_api(async () =>
					Response.json(
						{ error: { code: 'rate_limited', message: 'rate_limited' } },
						{ status: 429 }
					)
				).boot()
			);
			expect(result).toMatchObject({
				status: 429,
				code: 'rate_limited',
				message: 'Too many requests. Wait a moment and try again.'
			});
		})
	);
	it.effect('distinguishes a connection failure from an invalid successful response', () =>
		Effect.gen(function* () {
			expect(
				yield* Effect.flip(
					shell_api(async () => {
						throw new TypeError('fetch failed');
					}).boot()
				)
			).toMatchObject({ status: 0, code: 'offline' });
			expect(
				yield* Effect.flip(shell_api(async () => new Response('not JSON')).boot())
			).toMatchObject({ status: 200, code: 'protocol' });
		})
	);
	it.effect("decodes each route's answer once: a malformed value is a protocol failure", () =>
		Effect.gen(function* () {
			const answering = (value: unknown) => shell_api(async () => Response.json({ value }));
			expect(
				yield* answering({
					email: true,
					phone: false,
					whatsapp: false,
					signup: ['email'],
					locale: 'en'
				}).methods()
			).toEqual({ email: true, phone: false, whatsapp: false, signup: ['email'], locale: 'en' });
			expect(yield* Effect.flip(answering({ email: 'yes', locale: 'en' }).methods())).toMatchObject(
				{ status: 200, code: 'protocol' }
			);
			expect(yield* Effect.flip(answering({ id: 7 }).verify('a', 'b'))).toMatchObject({
				status: 200,
				code: 'protocol'
			});
		})
	);
});
it.effect('explains a generic internal refusal using its HTTP status', () =>
	Effect.gen(function* () {
		const result = yield* Effect.flip(
			shell_api(async () =>
				Response.json(
					{ error: { code: 'internal', message: 'The request failed.' } },
					{ status: 500 }
				)
			).boot()
		);
		expect(result).toMatchObject({
			status: 500,
			code: 'unavailable',
			message: 'The workspace server could not complete the request. Try again shortly.'
		});
	})
);

describe('native shell mutations on a snapshot client', () => {
	it.effect(
		'awaits the owned refresh without retrying an acknowledged write when the read fails',
		() =>
			Effect.gen(function* () {
				const calls: string[] = [];
				const api = shell_api(
					async () => {
						calls.push('mutation');
						return Response.json({
							outcome: { kind: 'committed', output: { id: 'message' }, records: [] },
							v: 4
						});
					},
					{
						base: 'https://workspace.test',
						after_mutation: () =>
							Effect.sync(() => {
								calls.push('refresh');
							}).pipe(Effect.andThen(Effect.fail({ message: 'The transcript could not refresh.' })))
					}
				);
				expect(yield* api.agent.post('conversation', 'Steer this', true)).toMatchObject({
					kind: 'committed',
					output: { id: 'message' }
				});
				expect(calls).toEqual(['mutation', 'refresh']);
			})
	);
	it.effect(
		'refreshes held and running work, while refused, conflict and uncertain outcomes stay unchanged',
		() =>
			Effect.gen(function* () {
				const outcomes = [
					{ kind: 'pending_approval', request_id: 'approval', records: [] },
					{ kind: 'running', run: 'run' },
					{ kind: 'refused', code: 'forbidden', message: 'No access.' },
					{ kind: 'conflict', records: [] },
					{ kind: 'unknown', invocation: 'uncertain' }
				] as const;
				for (const outcome of outcomes) {
					let refreshed = 0;
					const api = shell_api(async () => Response.json({ outcome, v: 1 }), {
						base: 'https://workspace.test',
						after_mutation: () =>
							Effect.sync(() => {
								refreshed++;
							})
					});
					expect(yield* api.agent.stop('conversation')).toEqual(outcome);
					expect(refreshed).toBe(
						outcome.kind === 'pending_approval' || outcome.kind === 'running' ? 1 : 0
					);
				}
			})
	);
});
