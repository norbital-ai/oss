// The workspace shell's pure halves (§5.10, §3.9): app visibility, the nav tree, routes, and the visitor fetch.
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer, ManagedRuntime, Option, Result, Schema } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Files, Images } from '../src/engine/ports.ts';
import { imagesPort } from '../src/node/images.ts';
import { manifest as baseManifest } from './engine-fixture.ts';
import { canOpenKiosk } from '../src/decl/runtime/kiosk.ts';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import {
	canOpen,
	crossSite,
	framePolicy,
	holdsPublic,
	href,
	isOpenRoute,
	kioskHref,
	kioskNav,
	nav,
	previewRoute,
	startableAutomations,
	route,
	surfaces
} from '../src/shell/nav.ts';
import { challengeQueue, kioskFetch, visitorFetch, shellApi } from '../src/shell/runtime.ts';
import { BoltRoutes } from '../src/protocol/http.ts';
import { activeApp, media, navigationModel, NORBIUS } from '../src/shell/model.ts';
import { fileAttachments } from '../src/engine/agent/attachments.ts';
import {
	dirtyFolders,
	foldLog,
	foldPhase,
	languageOf,
	reach,
	ageText,
	routedEnvironment,
	settleDrafts,
	stepLabel,
	StudioOp,
	studioView,
	suggestMessage,
	type StudioState
} from '../src/shell/studio/model.ts';
import { decodeManifest, type EngineManifest } from '../src/engine/manifest.ts';
/** The Node host's image port, as the agent's attachments read through it. */
const hostImages = Effect.map(Layer.build(Images.fromAbi(imagesPort)), (context) =>
	Context.get(context, Images)
);
const decodeOp = (value: unknown) => Option.getOrNull(Schema.decodeUnknownOption(StudioOp)(value));

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
		}
	},
	groups: { hr: { label: 'HR', icon: 'g', defaultChild: 'people' } },
	kiosks: {
		clock: {
			title: 'Clock',
			description: 'd',
			icon: 'i',
			auth: 'members',
			policies: ['kiosk_clock'],
			pages: { clock: { title: 'Clock' } }
		},
		lobby: {
			title: 'Lobby',
			description: 'd',
			icon: 'i',
			auth: 'none',
			policies: ['lobby_public'],
			pages: { welcome: { title: 'Welcome' } }
		}
	}
};
const member = (
	apps: string[],
	over: Partial<Extract<EngineActor, { kind: 'member' }>> = {},
	admin = false,
	kiosks: string[] = []
): Authority => ({
	key: 'k',
	admin,
	policies: [],
	collections: {},
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
		teamPath: [],
		admin,
		party: null,
		...over
	},
	capabilities: { apps, kiosks, tools: [], mcp: [], skills: [] }
});
const names = (ns: ReturnType<typeof nav>): unknown[] =>
	ns.map((n) => (n.kind === 'group' ? { [n.name]: names(n.children) } : n.name));

describe('app visibility (§3.9, capabilities.apps)', () => {
	it('a member whose policy names a public app opens it as themselves; `*`, other staff and administrators stay its visitor', () => {
		expect(canOpen(m, member(['careers'], { external: true }), 'careers')).toBe(true);
		expect(holdsPublic(member(['careers'], { external: true }), 'careers')).toBe(true);
		expect(holdsPublic(member(['*']), 'careers')).toBe(false);
		expect(holdsPublic(member(['sales']), 'careers')).toBe(false);
		expect(holdsPublic(member(['careers'], {}, true), 'careers')).toBe(false);
	});
	it('staff see members/all apps their policies admit, by name, * or group prefix', () => {
		expect(canOpen(m, member(['sales']), 'sales')).toBe(true);
		expect(canOpen(m, member(['sales']), 'hr/kiosk')).toBe(false);
		expect(canOpen(m, member(['hr']), 'hr/kiosk')).toBe(true);
		expect(canOpen(m, member(['hr/kiosk']), 'hr/people')).toBe(false);
		expect(canOpen(m, member(['*']), 'both')).toBe(true);
		expect(canOpen(m, member(['*']), 'portal')).toBe(false);
		expect(canOpen(m, member(['*']), 'careers')).toBe(false);
	});
	it('externals see only external/all apps; admins see every app; visitors only their own', () => {
		const ext = member(['*'], { external: true });
		expect(['sales', 'portal', 'both'].map((a) => canOpen(m, ext, a))).toEqual([false, true, true]);
		expect(Object.keys(m.apps).every((a) => canOpen(m, member([], {}, true), a))).toBe(true);
		const visitor: Authority = {
			...member([]),
			actor: { kind: 'visitor', app: 'careers', visitor: 'v' }
		};
		expect(Object.keys(m.apps).filter((a) => canOpen(m, visitor, a))).toEqual(['careers']);
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
	const em = Result.getOrThrow(
		decodeManifest({
			...baseManifest,
			models: {
				jobs: {
					description: 'Work orders on site',
					label: 'title',
					fields: { title: { kind: 'text' }, pay: { kind: 'money' }, notes: { kind: 'text' } },
					search: { text: ['title'] }
				},
				sites: { description: 'Work sites', label: 'name', fields: { name: { kind: 'text' } } }
			},
			relationships: { 'jobs.site': { to: 'sites', optional: true } },
			collections: {
				jobs: {
					read: { fields: ['title', 'pay'], relations: ['site'] },
					update: { input: { columns: ['title'] } }
				}
			},
			integrations: {}
		} satisfies EngineManifest)
	);
	it('exposes candidate inputs for source approval routes without granting ordinary writes', () => {
		const source: EngineManifest = {
			...em,
			collections: {
				jobs: {
					read: { fields: ['title', 'pay'] },
					create: { input: { columns: ['title', 'pay'] } },
					update: { input: { columns: ['title', 'pay'] } }
				}
			}
		};
		const auth: Authority = {
			...member([]),
			collections: {
				jobs: {
					read: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }],
					history: [],
					create: [
						{ policy: 'p', where: { t: 'const', value: true }, fields: ['title'], approval: true }
					],
					update: [
						{ policy: 'p', where: { t: 'const', value: true }, fields: ['title'], approval: true }
					],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		expect(exposure(source, auth)['jobs']).toMatchObject({
			create: { columns: ['title'], proposalOnly: true },
			update: { columns: ['title'] }
		});
		expect(auth.collections['jobs']?.update.filter((arm) => arm.approval !== true)).toEqual([]);
	});
	it('exposes native integration instance forms by their grants without exposing the host fence', () => {
		const admin = exposure(em, { ...member([]), admin: true })['sys_integration'];
		expect(admin).toMatchObject({
			create: { columns: ['integration', 'name', 'owner', 'envoy', 'configuration'] },
			update: { columns: ['name', 'envoy', 'active', 'configuration', 'import_start'] },
			relations: { owner: { targets: ['sys_user'], optional: true } }
		});
		expect(admin?.fields).not.toHaveProperty('epoch');
		expect(exposure(em, member([]))['sys_integration']).toBeUndefined();
		const auth: Authority = {
			...member([]),
			collections: {
				sys_integration: {
					read: [
						{ policy: 'p', where: { t: 'const', value: true }, fields: ['name', 'configuration'] }
					],
					history: [],
					create: [],
					update: [{ policy: 'p', where: { t: 'const', value: true }, fields: ['configuration'] }],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		const restricted = exposure(em, auth)['sys_integration'];
		expect(restricted?.update?.columns).toEqual(['configuration']);
		expect(restricted?.create).toBeUndefined();
		expect(restricted?.relations).toBeUndefined();
		expect(restricted?.fields).not.toHaveProperty('epoch');
	});
	it('an upsert-only nested input exposes inverse identity without inventing create or update operations', () => {
		const source: EngineManifest = {
			...em,
			models: {
				...em.models,
				lines: { label: 'amount', description: 'Order lines.', fields: { amount: { kind: 'int' } } }
			},
			relationships: { 'lines.job': { to: 'jobs', inverse: 'lines', owned: true } },
			collections: {
				jobs: {
					read: { fields: 'all', relations: 'all' },
					update: {
						input: { columns: ['title'], with: { lines: { upsert: { columns: ['amount'] } } } }
					}
				},
				lines: {
					read: { fields: 'all' },
					create: { input: { columns: ['amount', 'job'] } },
					update: { input: { columns: ['amount'] } }
				}
			}
		};
		const catalog = exposure(source, { ...member([]), admin: true });
		expect(catalog['jobs']?.update?.with?.['lines']).toEqual({
			collection: 'lines',
			parent: 'job',
			owned: true
		});
		expect(catalog['jobs']?.children?.['lines']).toEqual({
			collection: 'lines',
			parent: 'job',
			owned: true
		});
	});
	it("sends a relationship's where so a picker offers only what a write accepts", () => {
		const narrowed: EngineManifest = {
			...em,
			relationships: {
				'jobs.site': { to: 'sites', optional: true, where: { title: { eq: 'Yard' } } }
			},
			collections: { jobs: { read: { fields: ['title'], relations: ['site'] } } }
		};
		expect(exposure(narrowed, { ...member([]), admin: true })['jobs']?.relations).toEqual({
			site: { targets: ['sites'], optional: true, where: { title: { eq: 'Yard' } } }
		});
	});
	it('exposes readable source-owned fields with a restriction reason and keeps owned parents immutable', () => {
		const source: EngineManifest = {
			...em,
			relationships: { 'jobs.site': { to: 'sites', optional: true, owned: true } },
			collections: {
				jobs: {
					read: { fields: ['title', 'pay'], relations: ['site'] },
					update: { input: { columns: ['title', 'site'] } },
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
		const catalog = exposure(source, { ...member([]), admin: true });
		expect(catalog['jobs']).toMatchObject({
			update: { columns: ['title'] },
			fields: { pay: { kind: 'money' } },
			relations: { site: { targets: ['sites'] } },
			readonlyFields: { pay: 'syncOwned', site: 'ownedParent' },
			syncs: { jobs: { kind: 'remote', with: 'operations' } }
		});
		expect(exposure(source, member([]))['jobs']).toBeUndefined();
		const auth: Authority = {
			...member([]),
			collections: {
				jobs: {
					read: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }],
					history: [],
					create: [],
					update: [],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		expect(exposure(source, auth)['jobs']?.syncs).toBeUndefined();
		expect(exposure(source, { ...auth, automations: ['jobs.sync.jobs'] })['jobs']?.syncs).toEqual({
			jobs: { kind: 'remote', with: 'operations' }
		});
	});
	it('sends relations, guarded write inputs and fields masked on some rows; never an unexposed field', () => {
		const auth: Authority = {
			...member([]),
			collections: {
				jobs: {
					read: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }],
					history: [],
					create: [],
					update: [{ policy: 'p', where: { t: 'const', value: true }, fields: ['title'] }],
					delete: [],
					queries: [],
					moves: {},
					masks: { pay: { t: 'const', value: false } }
				}
			}
		};
		expect(exposure(em, auth)).toEqual({
			jobs: {
				label: ['title'],
				search: ['title'],
				fields: { title: { kind: 'text' }, pay: { kind: 'money' } },
				relations: { site: { targets: ['sites'], optional: true } },
				update: { columns: ['title'] },
				masked: ['pay'],
				description: 'Work orders on site'
			}
		});
	});
	it('sends a readable computed field, so a label naming one resolves (A5)', () => {
		const withComputed = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				...em,
				models: {
					...em.models,
					jobs: {
						...em.models['jobs']!,
						label: 'code',
						computed: {
							code: { kind: 'text', expr: { field: 'title' } },
							quantity: { kind: 'decimal', scale: 6, expr: 1 }
						}
					}
				},
				collections: { jobs: { ...em.collections['jobs'], read: { fields: 'all' } } }
			})
		);
		expect(exposure(withComputed, { ...member([]), admin: true })['jobs']).toMatchObject({
			label: ['code'],
			fields: {
				title: { kind: 'text' },
				code: { kind: 'text' },
				quantity: { kind: 'decimal', scale: 6 }
			}
		});
		expect(exposure(em, { ...member([]), admin: true })['jobs']!.fields).not.toHaveProperty('code');
	});
	it('a roll-up sum over a money field keeps its money and literal currency (A9)', () => {
		const orders = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				...em,
				models: {
					...em.models,
					orders: {
						label: 'code',
						fields: {
							code: { kind: 'text' },
							total: { kind: 'sum', of: 'lines.amount' },
							qty: { kind: 'sum', of: 'lines.n' }
						}
					},
					lines: {
						label: 'code',
						fields: {
							code: { kind: 'text' },
							amount: { kind: 'money', currency: 'SGD' },
							n: { kind: 'decimal', scale: 2 }
						}
					}
				},
				relationships: { ...em.relationships, 'lines.order': { to: 'orders', inverse: 'lines' } },
				collections: { orders: { read: { fields: 'all' } } }
			})
		);
		expect(exposure(orders, { ...member([]), admin: true })['orders']!.fields).toEqual({
			code: { kind: 'text' },
			total: { kind: 'sum', of: 'lines.amount', money: { currency: 'SGD' } },
			qty: { kind: 'sum', of: 'lines.n' }
		});
	});
	it("a roll-up sum over money in a per-row currency reads in the parent's same-named currency field", () => {
		const orders = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				...em,
				models: {
					...em.models,
					orders: {
						label: 'code',
						fields: {
							code: { kind: 'text' },
							currency: { kind: 'currency' },
							total: { kind: 'sum', of: 'lines.amount' }
						}
					},
					lines: {
						label: 'code',
						fields: {
							code: { kind: 'text' },
							currency: { kind: 'currency' },
							amount: { kind: 'money', currency: 'currency' }
						}
					},
					bills: {
						label: 'code',
						fields: { code: { kind: 'text' }, total: { kind: 'sum', of: 'bill_lines.amount' } }
					}
				},
				relationships: {
					...em.relationships,
					'lines.order': { to: 'orders', inverse: 'lines' },
					'lines.bill': { to: 'bills', inverse: 'bill_lines' }
				},
				collections: { orders: { read: { fields: 'all' } }, bills: { read: { fields: 'all' } } }
			})
		);
		const x = exposure(orders, { ...member([]), admin: true });
		expect(x['orders']!.fields['total']).toEqual({
			kind: 'sum',
			of: 'lines.amount',
			money: { currency: 'currency' }
		});
		// a parent without that field shows the sum in the workspace default
		expect(x['bills']!.fields['total']).toEqual({
			kind: 'sum',
			of: 'bill_lines.amount',
			money: {}
		});
	});
	it("a create form offers only the columns the holder's create arms admit; the host fills the rest", () => {
		const withCreate = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				...em,
				collections: {
					jobs: { ...em.collections['jobs'], create: { input: { columns: ['title', 'notes'] } } }
				}
			})
		);
		const auth: Authority = {
			...member([]),
			collections: {
				jobs: {
					read: [],
					history: [],
					create: [{ policy: 'p', where: { t: 'const', value: true }, fields: ['title'] }],
					update: [],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		expect(exposure(withCreate, auth)['jobs']).toMatchObject({
			create: { columns: ['title'] },
			fields: { title: { kind: 'text' } }
		});
		expect(exposure(withCreate, { ...auth, admin: true })['jobs']!.create).toEqual({
			columns: ['title', 'notes']
		});
		const filled = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				...withCreate,
				collections: {
					jobs: {
						...withCreate.collections['jobs']!,
						create: { input: { columns: ['title', 'notes'], filled: ['title', 'notes'] } }
					}
				}
			})
		);
		expect(exposure(filled, auth)['jobs']!.create).toEqual({
			columns: ['title'],
			filled: ['title']
		});
		expect(exposure(filled, { ...auth, admin: true })['jobs']!.create).toEqual({
			columns: ['title', 'notes'],
			filled: ['title', 'notes']
		});
	});
	it('exposes the system collections the caller reads, so a picker at sys_user labels its rows', () => {
		const auth: Authority = {
			...member([]),
			collections: {
				sys_user: {
					read: [
						{ policy: '$directory', where: { t: 'const', value: true }, fields: ['id', 'name'] }
					],
					history: [],
					create: [],
					update: [],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		expect(exposure(em, auth)['sys_user']).toEqual({
			label: ['name'],
			fields: { name: { kind: 'text' } }
		});
		expect(exposure(em, auth)['sys_team']).toBeUndefined();
	});
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
});

describe('preview environments drop the meta tools', () => {
	const at = (path: string) => previewRoute(route(m, new URL(path, 'https://w.example')), true);
	it('an administrator on a Studio host keeps the inbox, runs and Settings but not Norbius or Studio', () => {
		expect(surfaces(m, member([], {}, true).actor, true, true, true)).toEqual({
			inbox: true,
			runs: true,
			settings: true,
			agent: false,
			studio: false
		});
	});
	it('Studio, People and Connections open the apps launcher; apps, approvals and other Settings stay', () => {
		expect(
			['/studio', '/studio/mrs', '/settings', '/settings/people', '/connections'].map(at)
		).toEqual(Array.from({ length: 5 }, () => ({ kind: 'home' })));
		expect(at('/app/sales/quotes')).toEqual({ kind: 'page', app: 'sales', page: 'quotes' });
		expect([at('/inbox'), at('/settings/automations'), at('/settings/secrets')]).toEqual([
			{ kind: 'inbox' },
			{ kind: 'settings', tab: 'automations' },
			{ kind: 'settings', tab: 'secrets' }
		]);
		expect(previewRoute({ kind: 'studio' }, false)).toEqual({ kind: 'studio' });
	});
	it('the sidebar drops Norbius, People and Studio and keeps Approvals and the rest of Settings', () => {
		const auth = member(['sales'], {}, true);
		const model = navigationModel(
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
				catalog: {}
			},
			'/',
			(k) => k
		);
		const keys = [...model.sections, ...model.utilities].flatMap((x) =>
			'items' in x ? x.items.map((i) => i.key) : [x.key, ...(x.children ?? []).map((c) => c.key)]
		);
		expect(keys).toEqual(expect.arrayContaining(['approvals', 'automations', 'secrets']));
		expect(keys.filter((k) => ['norbius', 'people', 'studio'].includes(k))).toEqual([]);
	});
});

describe('routes and hrefs', () => {
	const at = (path: string) => route(m, new URL(path, 'https://w.example'));
	it('resolves the longest app prefix, the default page and a record', () => {
		expect(at('/app/hr/kiosk/clock')).toEqual({ kind: 'page', app: 'hr/kiosk', page: 'clock' });
		expect(at('/app/sales')).toEqual({ kind: 'page', app: 'sales', page: 'deals' });
		expect(at(href('sales', 'quotes', { collection: 'quotes', id: 'q/1' }))).toEqual({
			kind: 'page',
			app: 'sales',
			page: 'quotes',
			record: { collection: 'quotes', id: 'q/1' }
		});
		expect(at('/app/sales/nope')).toEqual({ kind: 'notFound' });
		expect(at('/app/hr')).toEqual({ kind: 'notFound' });
	});
	it('shell routes; sign-in keeps only a same-origin next', () => {
		expect(at('/inbox')).toEqual({ kind: 'inbox' });
		// runs live in Settings → Automations and the workspace log in Studio's runtime log; there is no `/runs` or `/logs`
		expect([at('/runs'), at('/logs')]).toEqual([{ kind: 'notFound' }, { kind: 'notFound' }]);
		expect(at('/settings/automations')).toEqual({ kind: 'settings', tab: 'automations' });
		expect(at('/settings/secrets')).toEqual({ kind: 'settings', tab: 'secrets' });
		expect(at('/settings/bogus')).toEqual({ kind: 'settings', tab: 'people' });
		expect([at('/studio'), at('/studio/x')]).toEqual([{ kind: 'studio' }, { kind: 'notFound' }]);
		// L-BOLT-528: each Studio tab is a stable deep link
		expect([at('/studio/mrs'), at('/studio/runtime'), at('/studio/mrs/1')]).toEqual([
			{ kind: 'studio', tab: 'mrs' },
			{ kind: 'studio', tab: 'runtime' },
			{ kind: 'notFound' }
		]);
		expect(at('/invite/abc')).toEqual({ kind: 'invite', id: 'abc' });
		expect(at('/sign-in?next=/app/sales')).toEqual({ kind: 'signIn', next: '/app/sales' });
		expect(at('/sign-in?next=//evil.example')).toEqual({ kind: 'signIn' });
	});
	it('only public pages, sign-in and invitation open signed out; there is no registration page', () => {
		expect(at('/register/t')).toEqual({ kind: 'notFound' });
		expect(
			['/app/careers/apply', '/sign-in', '/invite/x'].every((p) => isOpenRoute(m, at(p)))
		).toBe(true);
		expect(['/app/sales', '/inbox', '/'].some((p) => isOpenRoute(m, at(p)))).toBe(false);
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
				const close = mountEdge(ManagedRuntime.make(Layer.empty));
				yield* Effect.addFinalizer(() =>
					Effect.tryPromise({ try: close, catch: (cause) => new Error(String(cause)) }).pipe(
						Effect.orDie
					)
				);
				const queue = yield* challengeQueue(() => resets++);
				const vf = visitorFetch('careers', queue, f);
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
				yield* Effect.tryPromise({
					try: () => vf('/assets/x.png'),
					catch: (cause) => new Error(String(cause))
				});
				expect(seen).toEqual([
					{ url: '/__bolt/q', app: 'careers', token: null },
					{ url: '/__bolt/act', app: 'careers', token: 't1' },
					{ url: '/__bolt/files/applications.cv', app: 'careers', token: 't2' },
					{ url: '/assets/x.png', app: null, token: null }
				]);
				expect(resets).toBe(2);
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
					const kf = kioskFetch(() => at, f);
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
	it('a visitor subscribes model pages and records of granted queries only; members subscribe anything', () => {
		const admits = BoltRoutes['POST /__bolt/live'].admits;
		if (admits === undefined) throw new Error('The live route has no admission rule.');
		const visitor: Authority = {
			...member([]),
			actor: { kind: 'visitor', app: 'lobby', visitor: 'v' },
			collections: {
				openings: {
					read: [{ policy: 'visitor', where: { t: 'const', value: true }, fields: 'all' }],
					history: [],
					create: [],
					update: [],
					delete: [],
					queries: [],
					moves: {},
					masks: {}
				}
			}
		};
		expect(admits(visitor, { m: 'query', a: ['openings', {}] })).toBe(true);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(visitor, { m: 'query', a: ['openings', { id: 'id' }] })
		).toBe(true);
		expect(BoltRoutes['POST /__bolt/live'].admits(visitor, { m: 'query', a: ['orders', {}] })).toBe(
			false
		);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(visitor, { m: 'aggregate', a: ['openings', {}] })
		).toBe(false);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(visitor, { m: 'query', a: ['openings.q', {}] })
		).toBe(false);
		expect(BoltRoutes['POST /__bolt/live'].admits(visitor, undefined)).toBe(false);
		expect(
			BoltRoutes['POST /__bolt/live'].admits(member([]), { m: 'query', a: ['openings.q', {}] })
		).toBe(true);
	});
});

describe('startable automations', () => {
	it('Settings → Automations offers only automations the member may start and that need no input', () => {
		const spec = (input?: EngineManifest['automations'][string]['input']) => ({
			description: 'd',
			runAs: ['p'] as const,
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
			startableAutomations(withRuns, { ...member([]), automations: ['drift', 'lineage'] })
		).toEqual([{ name: 'drift', description: 'd' }]);
		expect(startableAutomations(withRuns, member([], {}, true)).map((a) => a.name)).toEqual([
			'drift',
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
		kiosks: kioskNav(m, auth),
		surfaces: surfaces(m, auth.actor, auth.admin, studio),
		inbox: 2,
		push: null,
		visitor: null,
		automations: {},
		catalog: {}
	});
	const tree = (
		items: readonly { key: string; children?: readonly { key: string }[] }[] | undefined
	) => (items ?? []).map((i) => [i.key, (i.children ?? []).map((c) => c.key)]);

	it("Operations (Norbius, Approvals) above Applications; the inbox count as a badge; an app's pages its tabs, a group's apps its children", () => {
		const model = navigationModel(bootOf(member(['sales', 'hr'])), '/app/sales/quotes', (k) => k);
		expect(model.sections.map((s) => [s.key, s.items.map((i) => i.key)])).toEqual([
			['operations', ['norbius', 'approvals']],
			['applications', ['sales', 'hr']]
		]);
		expect(model.sections[0]!.items).toMatchObject([
			{ href: NORBIUS, badge: '⌘K' },
			{ href: '/inbox', badge: '2' }
		]);
		const sales = model.sections[1]!.items[0]!;
		expect(sales.active).toBe(true);
		expect(activeApp(model)?.key).toBe('sales');
		expect(sales.pages?.map((c) => [c.key, c.active])).toEqual([
			['sales/deals', false],
			['sales/quotes', true]
		]);
		// a portal page is no sidebar row or tab: `hr/kiosk` has only its portal page, so the group keeps `hr/people` alone
		expect(tree(model.sections[1]!.items)).toContainEqual(['hr', ['hr/people']]);
	});
	it("portal pages sit in the ellipsis menu's Portals group, for the viewers who may open them", () => {
		const model = navigationModel(bootOf(member(['hr'])), '/app/hr/kiosk/clock', (k) => k);
		expect(tree(model.utilities)).toEqual([
			['portals', ['hr/kiosk/clock']],
			['kiosks', ['lobby']]
		]);
		expect(model.utilities[0]!.children).toMatchObject([
			{ label: 'Clock', href: '/app/hr/kiosk/clock', active: true }
		]);
		expect(activeApp(model)).toBeNull();
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([
			['kiosks', ['lobby']]
		]);
	});
	it("kiosks sit in the ellipsis menu's Kiosks group: members ones by capability, `none` ones for everyone", () => {
		expect(canOpenKiosk({ ...baseManifest, ...m }, 'clock', member([], {}, false, ['clock']))).toBe(
			true
		);
		expect(canOpenKiosk({ ...baseManifest, ...m }, 'clock', member([]))).toBe(false);
		expect(canOpenKiosk({ ...baseManifest, ...m }, 'lobby', member([]))).toBe(true);
		expect(m.kiosks?.['lobby']?.auth === 'none').toBe(true);
		expect(m.kiosks?.['clock']?.auth === 'none').toBe(false);
		expect(canOpenKiosk({ ...baseManifest, ...m }, 'clock', member([], {}, true))).toBe(true);
		expect(kioskNav(m, member([], {}, false, ['clock'])).map((k) => k.name)).toEqual([
			'clock',
			'lobby'
		]);
		expect(kioskHref('clock', 'clock')).toBe('/kiosk/clock/clock');
		expect(route(m, new URL('http://x/kiosk/clock/clock'))).toEqual({
			kind: 'kiosk',
			kiosk: 'clock',
			page: 'clock'
		});
		expect(route(m, new URL('http://x/kiosk/nope/clock'))).toEqual({ kind: 'notFound' });
		expect(framePolicy(m, '/kiosk/lobby/welcome')).toBe("frame-ancestors 'self'");
		expect(isOpenRoute(m, { kind: 'kiosk', kiosk: 'lobby', page: 'welcome' })).toBe(true);
		expect(isOpenRoute(m, { kind: 'kiosk', kiosk: 'clock', page: 'clock' })).toBe(false);
		expect(
			tree(
				navigationModel(bootOf(member([], {}, false, ['clock'])), '/kiosk/clock/clock', (k) => k)
					.utilities
			)
		).toContainEqual(['kiosks', ['clock', 'lobby']]);
	});
	it('the account popover: Settings (People, Organization, Audit, Automations) apart from System (no Logs: Studio holds the log); a member has neither', () => {
		expect(
			tree(navigationModel(bootOf(member([], {}, true), true), '/', (k) => k).utilities)
		).toEqual([
			['settings', ['people', 'organization', 'audit', 'automations']],
			['system', ['integrations', 'secrets', 'studio']],
			['portals', ['hr/kiosk/clock']],
			['kiosks', ['clock', 'lobby']]
		]);
		const settings = navigationModel(
			bootOf(member([], {}, true)),
			'/settings/automations',
			(k) => k
		).utilities?.[0];
		expect(settings).toMatchObject({ key: 'settings', active: true });
		expect(settings?.children?.find((c) => c.key === 'automations')).toMatchObject({
			href: '/settings/automations',
			active: true
		});
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([
			['kiosks', ['lobby']]
		]);
	});
});

describe('Studio port boundary', () => {
	it('decodes only well-formed ops; a saved path stays inside the source', () => {
		expect(decodeOp({ op: 'rollback', commit: 'abc' })).toEqual({ op: 'rollback', commit: 'abc' });
		expect(decodeOp({ op: 'rollback', commit: 'abc', discardDataSince: 't' })).toEqual({
			op: 'rollback',
			commit: 'abc',
			discardDataSince: 't'
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
			decodeOp({ op: 'change.open', title: 'Leave rules' }),
			decodeOp({ op: 'change.open', id: '3' }),
			decodeOp({ op: 'preview' }),
			decodeOp({ op: 'preview', id: '3' }),
			decodeOp({ op: 'change.close', id: '3' })
		]).toEqual([
			{ op: 'change.open', title: 'Leave rules' },
			{ op: 'change.open', id: '3' },
			{ op: 'preview' },
			{ op: 'preview', id: '3' },
			{ op: 'change.close', id: '3' }
		]);
		expect(decodeOp({ op: 'change.open', title: 'x'.repeat(300) })).toEqual({
			op: 'change.open',
			title: 'x'.repeat(200)
		});
		expect([
			decodeOp({ op: 'change.open' }),
			decodeOp({ op: 'change.open', title: '' }),
			decodeOp({ op: 'change.close' }),
			decodeOp({ op: 'preview', id: '' }),
			decodeOp({ op: 'preview', id: 3 })
		]).toEqual([null, null, null, null, null]);
	});
	it('says an age in short words', () => {
		const t0 = Date.parse('2026-09-01T00:30:00.000Z');
		expect([
			ageText('2026-09-01T00:30:00.000Z', t0),
			ageText('2026-09-01T00:30:00.000Z', t0 + 90 * 60_000),
			ageText('bad', t0),
			ageText(null, t0)
		]).toEqual(['just now', '1h', '', '']);
	});
	it('marks every ancestor folder of a draft, and edits a path in its language (L-BOLT-528)', () => {
		expect([...dirtyFolders(['src/app/x/+app.ts', 'README.md'])]).toEqual([
			'src/',
			'src/app/',
			'src/app/x/'
		]);
		expect(['a.ts', 'b.svelte', 'c.json', 'd.md'].map(languageOf)).toEqual([
			'javascript',
			'javascript',
			'json',
			'plaintext'
		]);
	});
	it('cuts the workbench manifest to the Manifest chips, each entry with its source path (L-BOLT-527)', () => {
		const manifest = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				workspace: { tz: 'UTC', locale: 'en', secrets: { API: { label: 'API' } } },
				models: {
					b: { description: 'B records', label: 'name', fields: { name: { kind: 'text' } } },
					a: { description: 'A records', label: 'name', fields: { name: { kind: 'text' } } }
				},
				apps: { x: { title: 'X', description: 'X workspace', icon: 'lucide:box', pages: {} } },
				policies: { rep: { description: 'Representative', grants: {} } },
				envoys: {},
				automations: { nightly: { description: 'Nightly task', runAs: 'trigger' } },
				connections: { stripe: { integration: 'stripe' }, mail: { integration: 'mail' } },
				mcp: { docs: { description: 'Documentation tools', url: 'API' } },
				integrations: {
					mail: { description: 'Mailbox', driver: 'email' },
					stripe: {
						description: 'Stripe API',
						driver: 'http',
						http: { baseUrl: 'https://api.stripe.com' }
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
		const v = studioView(state);
		const names = Object.fromEntries(
			Object.entries(v.sections!).map(([s, es]) => [s, es.map((e) => e.name)])
		);
		expect(names).toEqual({
			models: ['a', 'b'],
			apps: ['x'],
			kiosks: [],
			policies: ['rep'],
			automations: ['nightly'],
			remotes: ['docs', 'mail', 'stripe'],
			secrets: ['API']
		});
		expect(v.sections!.models).toEqual([
			{ name: 'a', path: 'src/data/model/a/+model.ts' },
			{ name: 'b', path: 'src/data/model/b/+model.ts' }
		]);
		expect(v.sections?.policies).toEqual([
			{ name: 'rep', path: 'src/access_control/policy/+rep.policy.ts' }
		]);
		expect(v.sections!.apps).toEqual([{ name: 'x', path: 'src/app/x/+app.ts', href: '/app/x' }]);
		expect(v.sections!.remotes.map((e) => e.path)).toEqual([
			'src/agent/mcp/+docs.mcp.ts',
			'src/integration/mail/+integration.ts',
			'src/integration/stripe/+integration.ts'
		]);
		expect('manifest' in v).toBe(false);
		expect(v.stale).toBeUndefined();
	});
	it('fails a manifest older than the source closed: no partial sections when a declared file is gone', () => {
		const manifest = Result.getOrThrow(
			decodeManifest({
				...baseManifest,
				workspace: { tz: 'UTC', locale: 'en' },
				models: {
					a: { description: 'A records', label: 'name', fields: { name: { kind: 'text' } } }
				},
				apps: { x: { title: 'X', description: 'X workspace', icon: 'lucide:box', pages: {} } },
				policies: {},
				envoys: {},
				automations: {},
				connections: {},
				mcp: {},
				integrations: {}
			} satisfies EngineManifest)
		);
		const v = studioView({
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
			studioView({
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
	it('keeps an edit made while its save was in flight, and drops what the save landed (L-BOLT-529)', () => {
		const saved = { 'src/a.ts': 'two', 'src/b.ts': 'two', 'src/c.ts': null };
		const drafts = { 'src/a.ts': 'three', 'src/b.ts': 'two', 'src/c.ts': null, 'src/d.ts': 'new' };
		expect(settleDrafts(drafts, saved)).toEqual({ 'src/a.ts': 'three', 'src/d.ts': 'new' });
	});
	it('folds a pushed log line: ANSI stripped, clipped to 800, the last 256 kept (L-BOLT-530)', () => {
		const line = (message: string) => ({ at: 't', level: 'error' as const, message });
		expect(foldLog([], line('\u001b[31mfailed\u001b[0m'))).toEqual([line('failed')]);
		expect(foldLog([], line('x'.repeat(900)))[0]!.message).toBe(`${'x'.repeat(800)}…`);
		const full = Array.from({ length: 256 }, (_, i) => line(String(i)));
		expect(foldLog(full, line('new')).map((l) => l.message)).toEqual([
			...full.slice(1).map((l) => l.message),
			'new'
		]);
	});
	it('folds pushed phases diagnose → preview → merge; a phase starting again clears the later ones (L-BOLT-530)', () => {
		let p = foldPhase({}, 'diagnose', 'running');
		p = foldPhase(
			foldPhase(foldPhase(p, 'diagnose', 'done'), 'preview', 'running'),
			'preview',
			'done'
		);
		expect(p).toEqual({ diagnose: 'done', preview: 'done' });
		expect(foldPhase(foldPhase(p, 'merge', 'failed'), 'diagnose', 'running')).toEqual({
			diagnose: 'running'
		});
		expect(foldPhase(p, 'preview', 'running')).toEqual({ diagnose: 'done', preview: 'running' });
	});
	it('moves the progress strip only forward within a run: an earlier phase never takes it back', () => {
		const steps = (['diagnose', 'merge', 'diagnose', 'preview'] as const).reduce<number[]>(
			(seen, phase) => [...seen, reach(seen.at(-1) ?? -1, phase)],
			[]
		);
		expect(steps.map(stepLabel)).toEqual([
			'Building…',
			'Switching over…',
			'Switching over…',
			'Switching over…'
		]);
		expect(stepLabel(-1)).toBe('Getting ready…');
	});
	it('suggests a save description from the drafts; a save carries it as its message', () => {
		const files = {
			'src/i18n/+messages.ts': { bytes: 0 },
			'src/data/+payroll.model.ts': { bytes: 0 }
		};
		expect(suggestMessage({ 'src/i18n/+messages.ts': 'x' }, files)).toBe('Update i18n messages');
		expect(suggestMessage({ 'src/data/+payroll.model.ts': null, 'notes.txt': 'n' }, files)).toBe(
			'Remove payroll model, Add notes'
		);
		expect(suggestMessage({ a: '1', b: '2', c: '3' }, {})).toBe('Add a and 2 more files');
		expect(
			decodeOp({ op: 'save', expected: 'c', files: {}, message: 'Fix the label' })
		).toMatchObject({ message: 'Fix the label' });
		expect(decodeOp({ op: 'save', expected: 'c', files: {}, message: '' })).toBeNull();
	});
	it('summarizes the routed environment: live preferred, any routed one otherwise, none when unrouted (L-BOLT-534)', () => {
		const env = (name: string, release: string) => ({ name, release, url: null });
		expect(routedEnvironment([env('development', 'r1')])).toEqual(env('development', 'r1'));
		expect(routedEnvironment([env('preview', 'r2'), env('live', 'r1')])).toEqual(env('live', 'r1'));
		expect(routedEnvironment([env('development', '')])).toBeUndefined();
		expect(routedEnvironment(undefined)).toBeUndefined();
	});
});

describe('read_attachment over the files port', () => {
	it.live('reads images and PDFs by MIME even with a wrong mode; refuses unsupported bytes', () =>
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
				session: () =>
					Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
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
			const a = fileAttachments(db, files, yield* hostImages);
			expect(yield* a.read({ id: 'f1', name: 'a.csv' }, 'sheet')).toEqual({
				name: 'a.csv',
				mime: 'text/csv',
				text: 'bytes of k1'
			});
			for (const as of ['text', 'image', 'document', 'sheet'] as const) {
				expect(yield* a.read({ id: 'f2' }, as)).toEqual({
					mime: 'image/png',
					bytes: new TextEncoder().encode('bytes of k2')
				});
				expect(yield* a.read({ id: 'f3' }, as)).toEqual({
					mime: 'application/pdf',
					bytes: new TextEncoder().encode('bytes of k3')
				});
			}
			expect(yield* a.read({ id: 'f5', name: 'items.xlsx' }, 'text')).toMatchObject({
				sheets: ['Stock'],
				sheet: 'Stock',
				cells: [
					['name', 'qty', 'ok'],
					['Bolt, M8', 4, true],
					['Nut', 2.5, false]
				]
			});
			const binary = yield* Effect.flip(a.read({ id: 'f4' }, 'text'));
			expect(binary.message).toMatch(/cannot be read/);
			const missing = yield* Effect.flip(a.read({ id: 'nope' }, 'text'));
			expect(missing.message).toMatch(/not stored/);
		})
	);
	it.live(
		'reads a HEIC attachment as a derived JPEG, the image a model takes',
		() =>
			Effect.gen(function* () {
				const db = TenantDb.typed({
					read: () => Effect.succeed([{ rows: [{ key: 'k', mime: 'image/heic' }], affected: 0 }]),
					write: () => Effect.die('unused write'),
					session: () =>
						Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
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
				const got = yield* fileAttachments(db, files, yield* hostImages).read({ id: 'f' }, 'image');
				if (
					typeof got !== 'object' ||
					got === null ||
					!('bytes' in got) ||
					!(got.bytes instanceof Uint8Array)
				)
					throw new Error('Expected image bytes.');
				expect(got.mime).toBe('image/jpeg');
				expect([...got.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
			}),
		30_000
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
	const embedded: EngineManifest = {
		...m,
		apps: {
			...m.apps,
			'hr/kiosk': {
				title: 'Kiosk',
				description: 'd',
				icon: 'i',
				pages: {
					clock: { title: 'Clock', portal: true, embed: [partner, 'https://b.example:8443'] }
				}
			}
		},
		kiosks: { lobby: { ...m.kiosks!['lobby']!, embed: [partner] } }
	};
	it('a kiosk or portal page is framed by the workspace and the origins its `embed` names; without `embed`, by the workspace alone', () => {
		expect(framePolicy(embedded, '/app/hr/kiosk/clock')).toBe(
			`frame-ancestors 'self' ${partner} https://b.example:8443`
		);
		expect(framePolicy(embedded, '/kiosk/lobby/welcome')).toBe(`frame-ancestors 'self' ${partner}`);
		expect(framePolicy(m, '/app/hr/kiosk/clock')).toBe("frame-ancestors 'self'");
		expect(framePolicy(m, '/kiosk/lobby/welcome')).toBe("frame-ancestors 'self'");
	});
	it('every other page, and a route that is none, is framed by the workspace alone', () => {
		expect(framePolicy(embedded, '/app/sales/deals')).toBe("frame-ancestors 'self'");
		expect(framePolicy(m, '/sign-in')).toBe("frame-ancestors 'self'");
		expect(framePolicy(m, '/nowhere')).toBe("frame-ancestors 'self'");
	});
	const post = (headers: Record<string, string>) =>
		new Request('https://acme.example/__bolt/q', { method: 'POST', headers });
	it('refuses a browser write another site started, framed or not; a page of this workspace and a webhook pass', () => {
		expect(crossSite(post({ 'sec-fetch-site': 'cross-site' }), 'https://acme.example')).toBe(true);
		expect(crossSite(post({ 'sec-fetch-site': 'same-site' }), 'https://acme.example')).toBe(true);
		expect(crossSite(post({ 'sec-fetch-site': 'same-origin' }), 'https://acme.example')).toBe(
			false
		); // a portal in another site's frame
		expect(crossSite(post({ origin: 'https://evil.example' }), 'https://acme.example')).toBe(true); // a browser without Sec-Fetch
		expect(crossSite(post({ origin: 'https://acme.example' }), 'https://acme.example/acme')).toBe(
			false
		);
		expect(crossSite(post({}), 'https://acme.example')).toBe(false); // a server's webhook
		expect(
			crossSite(
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
					shellApi(async () => new Response('<html>proxy error</html>', { status })).boot()
				);
				expect(result).toMatchObject({ status });
				expect(result.code).not.toBe('offline');
			})
		);
	it.effect('keeps the safe refusal reason', () =>
		Effect.gen(function* () {
			const result = yield* Effect.flip(
				shellApi(async () =>
					Response.json(
						{ error: { code: 'expired', message: 'The link expired.' } },
						{ status: 410 }
					)
				).boot()
			);
			expect(result).toMatchObject({ status: 410, message: 'The link expired.' });
		})
	);
	it.effect('distinguishes a connection failure from an invalid successful response', () =>
		Effect.gen(function* () {
			expect(
				yield* Effect.flip(
					shellApi(async () => {
						throw new TypeError('fetch failed');
					}).boot()
				)
			).toMatchObject({ status: 0, code: 'offline' });
			expect(
				yield* Effect.flip(shellApi(async () => new Response('not JSON')).boot())
			).toMatchObject({ status: 200, code: 'protocol' });
		})
	);
	it.effect("decodes each route's answer once: a malformed value is a protocol failure", () =>
		Effect.gen(function* () {
			const answering = (value: unknown) => shellApi(async () => Response.json({ value }));
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
			shellApi(async () =>
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
