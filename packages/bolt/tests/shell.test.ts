// The workspace shell's pure halves (§5.10, §3.9): app visibility, the nav tree, routes, and the visitor fetch.
import { describe, expect, it } from 'vitest';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import { canOpen, exposure, href, isOpenRoute, nav, route, surfaces, type ShellManifest } from '../src/shell/nav.ts';
import { challengeQueue, visitorFetch } from '../src/shell/runtime.ts';
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
		'hr/kiosk': { title: 'Kiosk', description: 'd', icon: 'i', pages: { clock: { title: 'Clock', kiosk: true } } },
		'hr/people': { title: 'People', description: 'd', icon: 'i', pages: { list: { title: 'List' } } },
		portal: { title: 'Portal', description: 'd', icon: 'i', audience: 'external', pages: { home: { title: 'Home' } } },
		both: { title: 'Both', description: 'd', icon: 'i', audience: 'all', pages: { home: { title: 'Home' } } },
		careers: { title: 'Careers', description: 'd', icon: 'i', audience: { public: ['applicant'], challenge: 'turnstile' }, pages: { apply: { title: 'Apply' } } },
	},
	groups: { hr: { label: 'HR', icon: 'g', defaultChild: 'people' } },
};
const member = (apps: string[], over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}, admin = false): Authority => ({
	key: 'k', admin, policies: [], collections: {}, automations: [], limits: [], teamTree: [], scopes: {},
	actor: { kind: 'member', id: 'u1', email: null, external: false, teams: [], teamPath: [], admin, party: null, ...over },
	capabilities: { apps, tools: [], mcp: [], skills: [] },
});
const names = (ns: ReturnType<typeof nav>): unknown[] => ns.map((n) => n.kind === 'group' ? { [n.name]: names(n.children) } : n.name);

describe('app visibility (§3.9, capabilities.apps)', () => {
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
		expect(surfaces(m, member([]).actor, true)).toEqual({ inbox: true, runs: true, settings: true, agent: true, studio: false, conversations: false });
		expect(surfaces(m, member([]).actor, true, true).studio).toBe(true);
		// every staff member authors their own draft; the host decides what a non-administrator may do
		expect(surfaces(m, member([]).actor, false, true)).toMatchObject({ studio: true, settings: false });
		expect(surfaces(m, member([], { external: true }).actor, false, true).studio).toBe(false);
		expect(surfaces(m, member([], { external: true }).actor, false)).toEqual({ inbox: false, runs: false, settings: false, agent: false, studio: false, conversations: false });
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
	it('only public pages, sign-in, invitation and registration open signed out', () => {
		expect(['/app/careers/apply', '/sign-in', '/invite/x', '/register/t'].every((p) => isOpenRoute(m, at(p)))).toBe(true);
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
});

describe('sidebar model', () => {
	const bootOf = (auth: Authority, studio = false) => ({ workspace: { name: 'Acme', locale: 'en', tz: 'UTC' }, actor: auth.actor, name: 'Ada', admin: auth.admin,
		preview: null, nav: nav(m, auth), surfaces: surfaces(m, auth.actor, auth.admin, studio), inbox: 2, push: null, visitor: null, catalog: {} });
	const tree = (items: readonly { key: string; children?: readonly { key: string }[] }[] | undefined) => (items ?? []).map((i) => [i.key, (i.children ?? []).map((c) => c.key)]);

	it('Operations (Norbius, Approvals) above Applications; the inbox count as a badge; an app\'s pages its tabs, a group\'s apps its children', () => {
		const model = navigationModel(bootOf(member(['sales', 'hr'])), '/app/sales/quotes', (k) => k);
		expect(model.sections.map((s) => [s.key, s.items.map((i) => i.key)])).toEqual([['operations', ['norbius', 'approvals']], ['applications', ['sales', 'hr']]]);
		expect(model.sections[0]!.items).toMatchObject([{ href: NORBIUS, badge: '⌘K' }, { href: '/inbox', badge: '2' }]);
		const sales = model.sections[1]!.items[0]!;
		expect(sales.active).toBe(true);
		expect(activeApp(model)?.key).toBe('sales');
		expect(sales.pages?.map((c) => [c.key, c.active])).toEqual([['sales/deals', false], ['sales/quotes', true]]);
		// a kiosk page is no sidebar row or tab: `hr/kiosk` has only its kiosk page, so the group keeps `hr/people` alone
		expect(tree(model.sections[1]!.items)).toContainEqual(['hr', ['hr/people']]);
	});
	it('kiosk pages sit in the ellipsis menu\'s Kiosks group, for the viewers who may open them', () => {
		const model = navigationModel(bootOf(member(['hr'])), '/app/hr/kiosk/clock', (k) => k);
		expect(tree(model.utilities)).toEqual([['kiosks', ['hr/kiosk/clock']]]);
		expect(model.utilities[0]!.children).toMatchObject([{ label: 'Clock', href: '/app/hr/kiosk/clock', active: true }]);
		expect(activeApp(model)).toBeNull();
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([]);
	});
	it('the account popover: Settings (People, Organization, Audit, Automations) apart from System (no Logs: Studio holds the log); a member has neither', () => {
		expect(tree(navigationModel(bootOf(member([], {}, true), true), '/', (k) => k).utilities)).toEqual([
			['settings', ['people', 'organization', 'audit', 'automations']], ['system', ['channels', 'integrations', 'secrets', 'studio']], ['kiosks', ['hr/kiosk/clock']]]);
		const settings = navigationModel(bootOf(member([], {}, true)), '/settings/automations', (k) => k).utilities?.[0];
		expect(settings).toMatchObject({ key: 'settings', active: true });
		expect(settings?.children?.find((c) => c.key === 'automations')).toMatchObject({ href: '/settings/automations', active: true });
		expect(tree(navigationModel(bootOf(member(['sales'])), '/', (k) => k).utilities)).toEqual([]);
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
		expect(names).toEqual({ collections: ['a', 'b'], pipelines: ['a'], apps: ['x'], policies: [], envoys: [], automations: ['nightly'], remotes: ['stripe', 'docs'], environment: ['API'] });
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
});

describe('workspace media', () => {
	it('serves a relative asset path under /assets/, and leaves absolute and data URLs alone', () => {
		expect(media('app-media/people-banner.webp')).toBe('/assets/app-media/people-banner.webp');
		expect(media('/app-media/x.webp')).toBe('/app-media/x.webp');
		expect(media('https://cdn.test/x.webp')).toBe('https://cdn.test/x.webp');
		expect(media('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
	});
});
