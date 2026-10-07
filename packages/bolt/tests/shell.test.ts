// The workspace shell's pure halves (§5.10, §3.9): app visibility, the nav tree, routes, and the visitor fetch.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import { canOpen, canOpenKiosk, crossSite, framePolicy, holdsPublic, exposure, href, isOpenRoute, kioskHref, kioskNav, nav, route, surfaces, type ShellManifest } from '../src/shell/nav.ts';
import { challengeQueue, kioskFetch, visitorFetch, shellApi } from '../src/shell/runtime.ts';
import { liveViewAdmitted } from '../src/protocol/http.ts';
import { activeApp, media, navigationModel, NORBIUS } from '../src/shell/model.ts';
import { fileAttachments } from '../src/shell/data.ts';
import { layoutTeams, searchTeams, subtree } from '../src/shell/teams.ts';
import { dirtyFolders, foldLog, foldPhase, languageOf, reviewAge, reviewFreshness, reviewNextOwner, routedEnvironment, settleDrafts, studioOp, studioView, type StudioOp, type StudioState } from '../src/shell/studio.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';

const m: ShellManifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: ['sales', 'hr'] },
	agent: { internal: 'brief', skills: {} },
	apps: {
		sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' }, quotes: { title: 'Quotes' } } },
		'hr/kiosk': { title: 'Kiosk', description: 'd', icon: 'i', pages: { clock: { title: 'Clock', portal: true } } },
		'hr/people': { title: 'People', description: 'd', icon: 'i', pages: { list: { title: 'List' } } },
		portal: { title: 'Portal', description: 'd', icon: 'i', audience: 'external', pages: { home: { title: 'Home' } } },
		both: { title: 'Both', description: 'd', icon: 'i', audience: 'all', pages: { home: { title: 'Home' } } },
		careers: { title: 'Careers', description: 'd', icon: 'i', audience: { public: ['applicant'], challenge: 'turnstile' }, pages: { apply: { title: 'Apply' } } },
	},
	groups: { hr: { label: 'HR', icon: 'g', defaultChild: 'people' } },
	kiosks: {
		clock: { title: 'Clock', description: 'd', icon: 'i', auth: 'members', policies: ['kiosk_clock'], pages: { clock: { title: 'Clock' } } },
		lobby: { title: 'Lobby', description: 'd', icon: 'i', auth: 'none', policies: ['lobby_public'], pages: { welcome: { title: 'Welcome' } } },
	},
};
const member = (apps: string[], over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}, admin = false, kiosks: string[] = []): Authority => ({
	key: 'k', admin, policies: [], collections: {}, automations: [], limits: [], teamTree: [], scopes: {},
	actor: { kind: 'member', id: 'u1', email: null, phone: null, external: false, teams: [], teamPath: [], admin, party: null, ...over },
	capabilities: { apps, kiosks, tools: [], mcp: [], skills: [] },
});
const names = (ns: ReturnType<typeof nav>): unknown[] => ns.map((n) => n.kind === 'group' ? { [n.name]: names(n.children) } : n.name);

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
		const visitor = { ...member([]), actor: { kind: 'visitor', app: 'careers', visitor: 'v' } } as Authority;
		expect(Object.keys(m.apps).filter((a) => canOpen(m, visitor, a))).toEqual(['careers']);
	});
	it('externals and visitors get no settings, runs or staff inbox; the agent follows the briefs', () => {
		expect(surfaces(m, member([]).actor, true)).toEqual({ inbox: true, runs: true, settings: true, agent: true, studio: false });
		expect(surfaces(m, member([]).actor, true, true).studio).toBe(true);
		// every staff member authors their own draft; the host decides what a non-administrator may do
		expect(surfaces(m, member([]).actor, false, true)).toMatchObject({ studio: true, settings: false });
		expect(surfaces(m, member([], { external: true }).actor, false, true).studio).toBe(false);
		expect(surfaces(m, member([], { external: true }).actor, false)).toEqual({ inbox: false, runs: false, settings: false, agent: false, studio: false });
		expect(surfaces(m, { kind: 'visitor', app: 'careers', visitor: 'v' }, false).agent).toBe(false);
	});
});

describe('exposure (the boot catalog ui reads)', () => {
	const em = {
		models: { jobs: { label: 'title', fields: { title: { kind: 'text' }, pay: { kind: 'money' }, notes: { kind: 'text' } }, search: { text: ['title'] } },
			sites: { label: 'name', fields: { name: { kind: 'text' } } } },
		relationships: { 'jobs.site': { to: 'sites', optional: true } },
		collections: { jobs: { description: 'Work orders on site', read: { fields: ['title', 'pay'], relations: ['site'] }, actions: { close: { description: 'Close', input: {}, target: 'record' }, sweep: { description: 'x', input: {}, internal: true } } } },
	} as unknown as EngineManifest;
	it('sends relations, the held actions and the fields masked on some rows; never an unexposed field', () => {
		const auth: Authority = { ...member([]), collections: { jobs: { read: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }], history: [], create: [], update: [], delete: [],
			queries: [], actions: ['close'], moves: {}, masks: { pay: { t: 'const', value: false } } } } };
		expect(exposure(em, auth)).toEqual({ jobs: { label: ['title'], search: ['title'], fields: { title: { kind: 'text' }, pay: { kind: 'money' } },
			relations: { site: { targets: ['sites'], optional: true } }, actions: { close: { input: {}, target: 'record', description: 'Close' } }, masked: ['pay'], description: 'Work orders on site' } });
	});
	it('sends a readable computed field, so a label naming one resolves (A5)', () => {
		const withComputed = { ...em, models: { ...em.models, jobs: { ...em.models['jobs']!, label: 'code', computed: { code: { kind: 'text', expr: { field: 'title' } } } } },
			collections: { jobs: { ...em.collections['jobs']!, read: { fields: 'all' } } } } as unknown as EngineManifest;
		expect(exposure(withComputed, { ...member([]), admin: true })['jobs']).toMatchObject({ label: ['code'], fields: { title: { kind: 'text' }, code: { kind: 'text' } } });
		expect(exposure(em, { ...member([]), admin: true })['jobs']!.fields).not.toHaveProperty('code');
	});
	it('a roll-up sum over a money field keeps its money and literal currency (A9)', () => {
		const orders = { ...em, models: { ...em.models,
			orders: { label: 'code', fields: { code: { kind: 'text' }, total: { kind: 'sum', of: 'lines.amount' }, qty: { kind: 'sum', of: 'lines.n' } } },
			lines: { label: 'code', fields: { code: { kind: 'text' }, amount: { kind: 'money', currency: 'SGD' }, n: { kind: 'decimal', scale: 2 } } } },
			relationships: { ...em.relationships, 'lines.order': { to: 'orders', inverse: 'lines' } },
			collections: { orders: { read: { fields: 'all' } } } } as unknown as EngineManifest;
		expect(exposure(orders, { ...member([]), admin: true })['orders']!.fields).toEqual({ code: { kind: 'text' },
			total: { kind: 'sum', of: 'lines.amount', money: { currency: 'SGD' } }, qty: { kind: 'sum', of: 'lines.n' } });
	});
	it('a roll-up sum over money in a per-row currency reads in the parent\'s same-named currency field', () => {
		const orders = { ...em, models: { ...em.models,
			orders: { label: 'code', fields: { code: { kind: 'text' }, currency: { kind: 'currency' }, total: { kind: 'sum', of: 'lines.amount' } } },
			lines: { label: 'code', fields: { code: { kind: 'text' }, currency: { kind: 'currency' }, amount: { kind: 'money', currency: 'currency' } } },
			bills: { label: 'code', fields: { code: { kind: 'text' }, total: { kind: 'sum', of: 'bill_lines.amount' } } } },
			relationships: { ...em.relationships, 'lines.order': { to: 'orders', inverse: 'lines' }, 'lines.bill': { to: 'bills', inverse: 'bill_lines' } },
			collections: { orders: { read: { fields: 'all' } }, bills: { read: { fields: 'all' } } } } as unknown as EngineManifest;
		const x = exposure(orders, { ...member([]), admin: true });
		expect(x['orders']!.fields['total']).toEqual({ kind: 'sum', of: 'lines.amount', money: { currency: 'currency' } });
		// a parent without that field shows the sum in the workspace default
		expect(x['bills']!.fields['total']).toEqual({ kind: 'sum', of: 'bill_lines.amount', money: {} });
	});
	it('a create form offers only the columns the holder\'s create arms admit; the host fills the rest', () => {
		const withCreate = { ...em, collections: { jobs: { ...em.collections['jobs']!, create: { input: { columns: ['title', 'notes'] } } } } } as EngineManifest;
		const auth: Authority = { ...member([]), collections: { jobs: { read: [], history: [], create: [{ policy: 'p', where: { t: 'const', value: true }, fields: ['title'], approval: [] }],
			update: [], delete: [], queries: [], actions: [], moves: {}, masks: {} } } };
		expect(exposure(withCreate, auth)['jobs']).toMatchObject({ create: { columns: ['title'] }, fields: { title: { kind: 'text' } } });
		expect(exposure(withCreate, { ...auth, admin: true })['jobs']!.create).toEqual({ columns: ['title', 'notes'] });
	});
	it('exposes the system collections the caller reads, so a picker at sys_user labels its rows', () => {
		const auth: Authority = { ...member([]), collections: { sys_user: { read: [{ policy: '$directory', where: { t: 'const', value: true }, fields: ['id', 'name'] }], history: [], create: [], update: [], delete: [],
			queries: [], actions: [], moves: {}, masks: {} } } };
		expect(exposure(em, auth)['sys_user']).toEqual({ label: ['name'], fields: { name: { kind: 'text' } } });
		expect(exposure(em, auth)['sys_team']).toBeUndefined();
	});
});

describe('nav tree', () => {
	it('orders top level by workspace.apps then name, nests groups with the default child first, drops empty groups', () => {
		expect(names(nav(m, member(['sales', 'hr', 'both'])))).toEqual(['sales', { hr: ['hr/people', 'hr/kiosk'] }, 'both']);
		expect(names(nav(m, member(['sales'])))).toEqual(['sales']);
		const [sales, hr] = nav(m, member(['sales', 'hr']));
		expect(sales).toMatchObject({ href: '/app/sales/deals', pages: [{ name: 'deals', href: '/app/sales/deals' }, { name: 'quotes' }] });
		expect(hr).toMatchObject({ kind: 'group', href: '/app/hr/people/list' });
	});
});

describe('routes and hrefs', () => {
	const at = (path: string) => route(m, new URL(path, 'https://w.example'));
	it('resolves the longest app prefix, the default page and a record', () => {
		expect(at('/app/hr/kiosk/clock')).toEqual({ kind: 'page', app: 'hr/kiosk', page: 'clock' });
		expect(at('/app/sales')).toEqual({ kind: 'page', app: 'sales', page: 'deals' });
		expect(at(href('sales', 'quotes', { collection: 'quotes', id: 'q/1' }))).toEqual({ kind: 'page', app: 'sales', page: 'quotes', record: { collection: 'quotes', id: 'q/1' } });
		expect(at('/app/sales/nope')).toEqual({ kind: 'notFound' });
		expect(at('/app/hr')).toEqual({ kind: 'notFound' });
	});
	it('shell routes; sign-in keeps only a same-origin next', () => {
		expect(at('/inbox')).toEqual({ kind: 'inbox' });
		// runs live in Settings → Automations, the workspace log in Studio's runtime log: the old URLs redirect there
		expect([at('/runs'), at('/runs/r1')]).toEqual([{ kind: 'redirect', to: '/settings/automations' }, { kind: 'redirect', to: '/settings/automations?run=r1' }]);
		expect(at('/settings/automations')).toEqual({ kind: 'settings', tab: 'automations' });
		expect(at('/settings/secrets')).toEqual({ kind: 'settings', tab: 'secrets' });
		expect(at('/settings/bogus')).toEqual({ kind: 'settings', tab: 'people' });
		expect([at('/logs'), at('/studio'), at('/studio/x')]).toEqual([{ kind: 'redirect', to: '/studio/runtime' }, { kind: 'studio' }, { kind: 'notFound' }]);
		// L-BOLT-528: each Studio tab is a stable deep link
		expect([at('/studio/mrs'), at('/studio/runtime'), at('/studio/mrs/1')]).toEqual([{ kind: 'studio', tab: 'mrs' }, { kind: 'studio', tab: 'runtime' }, { kind: 'notFound' }]);
		expect(at('/invite/abc')).toEqual({ kind: 'invite', id: 'abc' });
		expect(at('/sign-in?next=/app/sales')).toEqual({ kind: 'signIn', next: '/app/sales' });
		expect(at('/sign-in?next=//evil.example')).toEqual({ kind: 'signIn' });
	});
	it('only public pages, sign-in and invitation open signed out; there is no registration page', () => {
		expect(at('/register/t')).toEqual({ kind: 'notFound' });
		expect(['/app/careers/apply', '/sign-in', '/invite/x'].every((p) => isOpenRoute(m, at(p)))).toBe(true);
		expect(['/app/sales', '/inbox', '/'].some((p) => isOpenRoute(m, at(p)))).toBe(false);
	});
});

describe('visitor fetch (§5.10, GAPS r5 11)', () => {
	it('names the app on every /__bolt request and spends one fresh token per act and upload', async () => {
		const seen: { url: string; app: string | null; token: string | null }[] = [];
		const f = (async (input: string, init: RequestInit = {}) => {
			const hs = new Headers(init.headers);
			seen.push({ url: input, app: hs.get('Bolt-App'), token: hs.get('Bolt-Challenge') });
			return new Response('{}');
		}) as typeof fetch;
		let resets = 0;
		const queue = challengeQueue(() => resets++);
		const vf = visitorFetch('careers', queue, f);
		await vf('/__bolt/q', { method: 'POST' });
		const act = vf('/__bolt/act', { method: 'POST' });
		queue.put('t1');
		await act;
		queue.put('t2');
		await vf('/__bolt/files/applications.cv', { method: 'PUT' });
		await vf('/assets/x.png');
		expect(seen).toEqual([
			{ url: '/__bolt/q', app: 'careers', token: null },
			{ url: '/__bolt/act', app: 'careers', token: 't1' },
			{ url: '/__bolt/files/applications.cv', app: 'careers', token: 't2' },
			{ url: '/assets/x.png', app: null, token: null },
		]);
		expect(resets).toBe(2);
	});
	it('names the kiosk on every /__bolt request while on a kiosk route, and nothing elsewhere', async () => {
		const seen: { url: string; kiosk: string | null }[] = [];
		const f = (async (input: string, init: RequestInit = {}) => {
			seen.push({ url: input, kiosk: new Headers(init.headers).get('Bolt-Kiosk') });
			return new Response('{}');
		}) as typeof fetch;
		let at: string | null = 'lobby';
		const kf = kioskFetch(() => at, f);
		await kf('/__bolt/q', { method: 'POST' });
		await kf('/assets/x.png');
		at = null;
		await kf('/__bolt/q', { method: 'POST' });
		expect(seen).toEqual([
			{ url: '/__bolt/q', kiosk: 'lobby' },
			{ url: '/assets/x.png', kiosk: null },
			{ url: '/__bolt/q', kiosk: null },
		]);
	});
	it('a visitor subscribes read/get views of granted reads only; members subscribe anything', () => {
		const visitor: Authority = { ...member([]), actor: { kind: 'visitor', app: 'lobby', visitor: 'v' },
			collections: { openings: { read: [{}], history: [], create: [], update: [], delete: [], queries: [], actions: [], moves: {}, masks: {} } } as unknown as Authority['collections'] };
		expect(liveViewAdmitted(visitor, { m: 'read', a: ['openings', {}] })).toBe(true);
		expect(liveViewAdmitted(visitor, { m: 'get', a: ['openings', 'id'] })).toBe(true);
		expect(liveViewAdmitted(visitor, { m: 'read', a: ['orders', {}] })).toBe(false);
		expect(liveViewAdmitted(visitor, { m: 'aggregate', a: ['openings', {}] })).toBe(false);
		expect(liveViewAdmitted(visitor, { m: 'query', a: ['openings', 'q', {}] })).toBe(false);
		expect(liveViewAdmitted(visitor, undefined)).toBe(false);
		expect(liveViewAdmitted(member([]), { m: 'query', a: ['openings', 'q', {}] })).toBe(true);
	});
});

describe('sidebar model', () => {
	const bootOf = (auth: Authority, studio = false) => ({ workspace: { name: 'Acme', locale: 'en', tz: 'UTC' }, actor: auth.actor, name: 'Ada', admin: auth.admin,
		preview: null, nav: nav(m, auth), kiosks: kioskNav(m, auth), surfaces: surfaces(m, auth.actor, auth.admin, studio), inbox: 2, push: null, visitor: null, catalog: {} });
	const tree = (items: readonly { key: string; children?: readonly { key: string }[] }[] | undefined) => (items ?? []).map((i) => [i.key, (i.children ?? []).map((c) => c.key)]);

	it('Operations (Norbius, Approvals) above Applications; the inbox count as a badge; an app\'s pages its tabs, a group\'s apps its children', () => {
		const model = navigationModel(bootOf(member(['sales', 'hr'])), '/app/sales/quotes', (k) => k);
		expect(model.sections.map((s) => [s.key, s.items.map((i) => i.key)])).toEqual([['operations', ['norbius', 'approvals']], ['applications', ['sales', 'hr']]]);
		expect(model.sections[0]!.items).toMatchObject([{ href: NORBIUS, badge: '⌘K' }, { href: '/inbox', badge: '2' }]);
		const sales = model.sections[1]!.items[0]!;
		expect(sales.active).toBe(true);
		expect(activeApp(model)?.key).toBe('sales');
		expect(sales.pages?.map((c) => [c.key, c.active])).toEqual([['sales/deals', false], ['sales/quotes', true]]);
		// a portal page is no sidebar row or tab: `hr/kiosk` has only its portal page, so the group keeps `hr/people` alone
		expect(tree(model.sections[1]!.items)).toContainEqual(['hr', ['hr/people']]);
	});
	it('portal pages sit in the ellipsis menu\'s Portals group, for the viewers who may open them', () => {
		const model = navigationModel(bootOf(member(['hr'])), '/app/hr/kiosk/clock', (k) => k);
		expect(tree(model.utilities)).toEqual([['portals', ['hr/kiosk/clock']], ['kiosks', ['lobby']]]);
		expect(model.utilities[0]!.children).toMatchObject([{ label: 'Clock', href: '/app/hr/kiosk/clock', active: true }]);
		expect(activeApp(model)).toBeNull();
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([['kiosks', ['lobby']]]);
	});
	it('kiosks sit in the ellipsis menu\'s Kiosks group: members ones by capability, `none` ones for everyone', () => {
		expect(canOpenKiosk(m, member([], {}, false, ['clock']), 'clock')).toBe(true);
		expect(canOpenKiosk(m, member([]), 'clock')).toBe(false);
		expect(canOpenKiosk(m, member([]), 'lobby')).toBe(true);
		expect(canOpenKiosk(m, null, 'lobby')).toBe(true);
		expect(canOpenKiosk(m, null, 'clock')).toBe(false);
		expect(canOpenKiosk(m, member([], {}, true), 'clock')).toBe(true);
		expect(kioskNav(m, member([], {}, false, ['clock'])).map((k) => k.name)).toEqual(['clock', 'lobby']);
		expect(kioskHref('clock', 'clock')).toBe('/kiosk/clock/clock');
		expect(route(m, new URL('http://x/kiosk/clock/clock'))).toEqual({ kind: 'kiosk', kiosk: 'clock', page: 'clock' });
		expect(route(m, new URL('http://x/kiosk/nope/clock'))).toEqual({ kind: 'notFound' });
		expect(framePolicy(m, '/kiosk/lobby/welcome')).toBe('frame-ancestors *');
		expect(isOpenRoute(m, { kind: 'kiosk', kiosk: 'lobby', page: 'welcome' })).toBe(true);
		expect(isOpenRoute(m, { kind: 'kiosk', kiosk: 'clock', page: 'clock' })).toBe(false);
		expect(tree(navigationModel(bootOf(member([], {}, false, ['clock'])), '/kiosk/clock/clock', (k) => k).utilities)).toContainEqual(['kiosks', ['clock', 'lobby']]);
	});
	it('the account popover: Settings (People, Organization, Audit, Automations) apart from System (no Logs: Studio holds the log); a member has neither', () => {
		expect(tree(navigationModel(bootOf(member([], {}, true), true), '/', (k) => k).utilities)).toEqual([
			['settings', ['people', 'organization', 'audit', 'automations']], ['system', ['envoy', 'integrations', 'secrets', 'studio']], ['portals', ['hr/kiosk/clock']], ['kiosks', ['clock', 'lobby']]]);
		const settings = navigationModel(bootOf(member([], {}, true)), '/settings/automations', (k) => k).utilities?.[0];
		expect(settings).toMatchObject({ key: 'settings', active: true });
		expect(settings?.children?.find((c) => c.key === 'automations')).toMatchObject({ href: '/settings/automations', active: true });
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([['kiosks', ['lobby']]]);
	});
});

describe('team chart (Settings → People → Teams)', () => {
	const T = (id: string, name: string, parent: string | null = null) => ({ id, name, parent });
	const org = [T('ops', 'Ops'), T('hr', 'HR', 'ops'), T('pay', 'Payroll', 'hr'), T('eng', 'Eng'), T('fin', 'Finance', 'ops')];
	it('a parent sits over the middle of its subtree; leaves take columns left to right; one edge per parent → child', () => {
		const { positions, edges } = layoutTeams(org, 100, 10);
		const at = Object.fromEntries(positions.map((p) => [p.id, [p.x, p.y]]));
		expect(at).toEqual({ eng: [0, 0], fin: [100, 10], pay: [200, 20], hr: [200, 10], ops: [150, 0] });
		expect(edges).toEqual([{ parent: 'ops', child: 'hr' }, { parent: 'hr', child: 'pay' }, { parent: 'ops', child: 'fin' }]);
	});
	it('a missing parent, a self-parent and a cycle are drawn, never dropped', () => {
		const odd = [T('a', 'A', 'gone'), T('b', 'B', 'b'), T('c', 'C', 'd'), T('d', 'D', 'c')];
		expect(layoutTeams(odd).positions.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(layoutTeams(odd).edges).toEqual([{ parent: 'd', child: 'c' }, { parent: 'c', child: 'd' }]);
	});
	it('a search keeps each match and the teams above it; a move is never into the own subtree', () => {
		expect(searchTeams(org, 'pay').map((t) => t.id)).toEqual(['ops', 'hr', 'pay']);
		expect(searchTeams(org, '  ').length).toBe(org.length);
		expect([...subtree(org, 'ops')].sort()).toEqual(['fin', 'hr', 'ops', 'pay']);
	});
});

describe('Studio port boundary', () => {
	it('decodes only well-formed ops; a saved path stays inside the source', () => {
		expect(studioOp({ op: 'restore', commit: 'abc' })).toEqual({ op: 'restore', commit: 'abc' });
		expect(studioOp({ op: 'save', expected: 'h', files: { 'src/a.ts': 'x', 'b.ts': null } })).toMatchObject({ op: 'save' });
		expect([studioOp({ op: 'restore' }), studioOp({ op: 'save', expected: 'h', files: { '../x': 'y' } }), studioOp({ op: 'save', expected: 'h', files: { '/etc/x': 'y' } }),
			studioOp({ op: 'save', expected: 'h', files: { a: 1 } }), studioOp({ op: 'drop' }), studioOp([])]).toEqual([null, null, null, null, null, null]);
	});
	it('decodes the collaboration ops (L-COL-188, 190): switch, rebase, preview on live data, exit and mr.*', () => {
		expect([studioOp({ op: 'switch', target: '3' }), studioOp({ op: 'rebase' }), studioOp({ op: 'preview', live: true }), studioOp({ op: 'preview', live: 'yes' }), studioOp({ op: 'exit' })])
			.toEqual([{ op: 'switch', target: '3' }, { op: 'rebase' }, { op: 'preview', live: true }, { op: 'preview' }, { op: 'exit' }]);
		expect(studioOp({ op: 'mr.open', title: 'Leave rules' })).toEqual({ op: 'mr.open', title: 'Leave rules' });
		expect(studioOp({ op: 'mr.decide', id: '1', kind: 'changes_requested', reason: 'no' })).toEqual({ op: 'mr.decide', id: '1', kind: 'changes_requested', reason: 'no' });
		expect(studioOp({ op: 'mr.merge', id: '1' })).toEqual({ op: 'mr.merge', id: '1' });
		expect([studioOp({ op: 'switch' }), studioOp({ op: 'mr.open', title: '' }), studioOp({ op: 'mr.decide', id: '1', kind: 'lgtm' }), studioOp({ op: 'mr.comment', id: '1' }),
			studioOp({ op: 'mr.ready' })]).toEqual([null, null, null, null, null]);
	});
	it('names the next owner and freshness of a merge request, and its review age (L-BOLT-526)', () => {
		const mr = (state: 'draft' | 'ready' | 'merged' | 'closed', behind = 0, decision: 'approved' | 'changes_requested' | null = null) =>
			({ state, behind, decision: decision === null ? null : { kind: decision, by: 'r', at: 't', commit: 'h', reason: null } });
		expect([reviewFreshness(mr('ready')), reviewFreshness(mr('ready', 2)), reviewFreshness(mr('closed', 2))]).toEqual(['current', 'live_advanced', 'terminal']);
		expect([reviewNextOwner(mr('draft')), reviewNextOwner(mr('ready')), reviewNextOwner(mr('ready', 1)), reviewNextOwner(mr('ready', 0, 'changes_requested')),
			reviewNextOwner(mr('ready', 0, 'approved')), reviewNextOwner(mr('merged'))]).toEqual(['author', 'reviewer', 'author', 'author', 'reviewer', 'complete']);
		const t0 = Date.parse('2026-09-01T00:30:00.000Z');
		expect([reviewAge('2026-09-01T00:30:00.000Z', t0), reviewAge('2026-09-01T00:30:00.000Z', t0 + 90 * 60_000), reviewAge('bad', t0), reviewAge(null, t0)]).toEqual(['just now', '1h', '', '']);
	});
	it('marks every ancestor folder of a draft, and edits a path in its language (L-BOLT-528)', () => {
		expect([...dirtyFolders(['src/app/x/+app.ts', 'README.md'])]).toEqual(['src/', 'src/app/', 'src/app/x/']);
		expect(['a.ts', 'b.svelte', 'c.json', 'd.md'].map(languageOf)).toEqual(['javascript', 'javascript', 'json', 'plaintext']);
	});
	it('cuts the workbench manifest to the Manifest chips, each entry with its source path (L-BOLT-527)', () => {
		const manifest = { workspace: { tz: 'UTC', locale: 'en', env: { API: { label: 'API' } } }, collections: { b: {}, a: {} }, pipelines: { a: {} }, apps: { x: {} }, policies: {}, envoys: {},
			automations: { nightly: {} }, connections: { stripe: {} }, mcp: { docs: {} }, integrations: {} } as unknown as EngineManifest;
		const files = Object.fromEntries(['src/+workspace.ts', 'src/data/collection/a/+collection.ts', 'src/data/collection/b/+collection.ts', 'src/data/collection/a/+pipeline.ts',
			'src/app/x/+app.ts', 'src/automation/+nightly.automation.ts', 'src/connection/+stripe.connection.ts', 'src/agent/mcp/+docs.mcp.ts'].map((p) => [p, '']));
		const state: StudioState = { commit: 'h', files, changes: [], manifest, log: [], preview: null, releases: [] };
		const v = studioView(state);
		const names = Object.fromEntries(Object.entries(v.sections!).map(([s, es]) => [s, es.map((e) => e.name)]));
		expect(names).toEqual({ collections: ['a', 'b'], pipelines: ['a'], apps: ['x'], kiosks: [], policies: [], channelTypes: [], automations: ['nightly'], remotes: ['stripe', 'docs'], environment: ['API'] });
		expect(v.sections!.apps).toEqual([{ name: 'x', path: 'src/app/x/+app.ts', href: '/app/x' }]);
		expect(v.sections!.remotes.map((e) => e.path)).toEqual(['src/connection/+stripe.connection.ts', 'src/agent/mcp/+docs.mcp.ts']);
		expect('manifest' in v).toBe(false);
		expect(v.stale).toBeUndefined();
	});
	it('fails a manifest older than the source closed: no partial sections when a declared file is gone', () => {
		const manifest = { workspace: { tz: 'UTC', locale: 'en' }, collections: { a: {} }, pipelines: {}, apps: { x: {} }, policies: {}, envoys: {}, automations: {},
			connections: {}, mcp: {}, integrations: {} } as unknown as EngineManifest;
		const v = studioView({ commit: 'h', files: { 'src/app/x/+app.ts': '' }, changes: [], manifest, log: [], preview: null, releases: [] });
		expect([v.sections, v.stale]).toEqual([null, true]);
		expect(studioView({ commit: 'h', files: {}, changes: [], manifest: null, log: [], preview: null, releases: [] })).toMatchObject({ sections: null });
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
		expect(foldLog(full, line('new')).map((l) => l.message)).toEqual([...full.slice(1).map((l) => l.message), 'new']);
	});
	it('folds pushed phases diagnose → preview → merge; a phase starting again clears the later ones (L-BOLT-530)', () => {
		let p = foldPhase({}, 'diagnose', 'running');
		p = foldPhase(foldPhase(foldPhase(p, 'diagnose', 'done'), 'preview', 'running'), 'preview', 'done');
		expect(p).toEqual({ diagnose: 'done', preview: 'done' });
		expect(foldPhase(foldPhase(p, 'merge', 'failed'), 'diagnose', 'running')).toEqual({ diagnose: 'running' });
		expect(foldPhase(p, 'preview', 'running')).toEqual({ diagnose: 'done', preview: 'running' });
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
	it('answers text for text files and bytes for images; refuses a binary read as text', async () => {
		const stored: Record<string, { key: string; mime: string }> = { f1: { key: 'k1', mime: 'text/csv' }, f2: { key: 'k2', mime: 'image/png' }, f3: { key: 'k3', mime: 'application/pdf' } };
		const db = { read: async (qs: readonly { params: readonly unknown[] }[]) => [{ rows: [stored[String(qs[0]!.params[0])]].filter(Boolean), affected: 0 }] } as never;
		const files = { get: async (key: string) => new TextEncoder().encode(`bytes of ${key}`) } as never;
		const a = fileAttachments(db, files), signal = AbortSignal.timeout(1000);
		expect(await a.read({ id: 'f1', name: 'a.csv' }, 'sheet', signal)).toEqual({ name: 'a.csv', mime: 'text/csv', text: 'bytes of k1' });
		expect(await a.read({ id: 'f2' }, 'image', signal)).toMatchObject({ mime: 'image/png' });
		expect(await a.read({ id: 'f3' }, 'document', signal)).toMatchObject({ mime: 'application/pdf' });
		await expect(a.read({ id: 'f3' }, 'text', signal)).rejects.toThrow(/cannot be read/);
		await expect(a.read({ id: 'nope' }, 'text', signal)).rejects.toThrow(/not stored/);
	});
	it('reads a HEIC attachment as a derived JPEG, the image a model takes', async () => {
		const db = { read: async () => [{ rows: [{ key: 'k', mime: 'image/heic' }], affected: 0 }] } as never;
		const files = { get: async () => new Uint8Array(readFileSync(new URL('./fixtures/files/photo.heic', import.meta.url))) } as never;
		const got = await fileAttachments(db, files).read({ id: 'f' }, 'image', AbortSignal.timeout(30_000)) as { mime: string; bytes: Uint8Array };
		expect(got.mime).toBe('image/jpeg');
		expect([...got.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	}, 30_000);
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
	it('only a site page may be framed by another website; every other page, and a route that is none, by the workspace alone', () => {
		expect(framePolicy(m, '/app/hr/kiosk/clock')).toBe('frame-ancestors *');
		expect(framePolicy(m, '/app/sales/deals')).toBe("frame-ancestors 'self'");
		expect(framePolicy(m, '/sign-in')).toBe("frame-ancestors 'self'");
		expect(framePolicy(m, '/nowhere')).toBe("frame-ancestors 'self'");
	});
	const post = (headers: Record<string, string>) => new Request('https://acme.example/__bolt/q', { method: 'POST', headers });
	it('refuses a browser write another site started, framed or not; a page of this workspace and a webhook pass', () => {
		expect(crossSite(post({ 'sec-fetch-site': 'cross-site' }), 'https://acme.example')).toBe(true);
		expect(crossSite(post({ 'sec-fetch-site': 'same-site' }), 'https://acme.example')).toBe(true);
		expect(crossSite(post({ 'sec-fetch-site': 'same-origin' }), 'https://acme.example')).toBe(false);   // a portal in another site's frame
		expect(crossSite(post({ origin: 'https://evil.example' }), 'https://acme.example')).toBe(true);    // a browser without Sec-Fetch
		expect(crossSite(post({ origin: 'https://acme.example' }), 'https://acme.example/acme')).toBe(false);
		expect(crossSite(post({}), 'https://acme.example')).toBe(false);                                   // a server's webhook
		expect(crossSite(new Request('https://acme.example/app/x', { headers: { 'sec-fetch-site': 'cross-site' } }), 'https://acme.example')).toBe(false);
	});
});


describe('shell HTTP failures', () => {
	it.each([403, 404, 429, 500, 502, 503, 504])('preserves HTTP %s when the server answers HTML', async (status) => {
		const api = shellApi(async () => new Response('<html>proxy error</html>', { status }));
		const result = await api.boot();
		expect(result).toMatchObject({ ok: false, status });
		if (!result.ok) expect(result.error.code).not.toBe('offline');
	});
	it('keeps the safe refusal reason', async () => {
		const api = shellApi(async () => Response.json({ error: { code: 'expired', message: 'The link expired.' } }, { status: 410 }));
		expect(await api.boot()).toMatchObject({ ok: false, status: 410, error: { message: 'The link expired.' } });
	});
	it('distinguishes a connection failure from an invalid successful response', async () => {
		expect(await shellApi(async () => { throw new TypeError('fetch failed'); }).boot()).toMatchObject({ ok: false, status: 0, error: { code: 'offline' } });
		expect(await shellApi(async () => new Response('not JSON')).boot()).toMatchObject({ ok: false, status: 200, error: { code: 'protocol' } });
	});
});

it('explains a generic internal refusal using its HTTP status', async () => {
	const result = await shellApi(async () => Response.json({ error: { code: 'internal', message: 'The request failed.' } }, { status: 500 })).boot();
	expect(result).toMatchObject({ ok: false, status: 500, error: { code: 'unavailable', message: 'The workspace server could not complete the request. Try again shortly.' } });
});
