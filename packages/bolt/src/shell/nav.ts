// The shell's navigation (§5.10, §3.3.1, §3.9): which apps an actor sees, the nav tree of apps and groups, the URL of a
// page or record, and the route a URL names. Pure: the host and the browser share it.
import type { Authority, EngineActor, EngineManifest } from '../engine/contracts.ts';
import { SYSTEM } from '../system/index.ts';
import { BOLT } from '../protocol/wire.ts';

export type PageSpec = { title: string; icon?: string; section?: string; site?: true };
export type Audience = 'members' | 'external' | 'all' | { public: readonly string[]; challenge?: 'turnstile' };
export type AppSpec = { title: string; description: string; icon: string; banner?: string; audience?: Audience; pages: { readonly [page: string]: PageSpec } };
export type GroupSpec = { label: string; description?: string; icon: string; defaultChild: string };
/** What the shell reads of the manifest; `groups` are the `+group.ts` literals. */
export type ShellManifest = Pick<EngineManifest, 'workspace' | 'agent'> & Partial<Pick<EngineManifest, 'envoys'>> & { apps: { readonly [app: string]: unknown }; groups?: { readonly [group: string]: unknown } };

export type NavPage = { name: string; title: string; icon?: string; section?: string; site?: true; href: string };
export type NavNode =
	| { kind: 'app'; name: string; title: string; description: string; icon: string; banner?: string; href: string; pages: NavPage[] }
	| { kind: 'group'; name: string; title: string; description?: string; icon: string; href: string; children: NavNode[] };

export const APP_PREFIX = '/app/';
/** The session cookie (§5.11.2), the admin's preview-as target (rule 39) and the visitor's idempotency id (§5.10). */
export const COOKIES = { session: 'nb_s', preview: 'nb_p', visitor: '__bolt_v' } as const;
/**
 * The cookies' site attributes: over https, partitioned and sent in frames, so a portal page embedded in another site keeps
 * its own sign-in (kept apart from the top-level one: a framing site never borrows a member's session); over plain http
 * (`bolt dev`), `Lax`. Cross-site writes are refused by `crossSite`, not by `SameSite`.
 */
export const cookieSite = (secure: boolean): string => secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
/**
 * A browser write another site started (a forged form post or fetch): refused before it reaches a handler. A request from
 * a page of this workspace, framed or not, is `same-origin`; a server calling a webhook sends neither header.
 */
export function crossSite(request: Request, publicUrl: string): boolean {
	if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false;
	const site = request.headers.get('sec-fetch-site');
	if (site !== null) return site === 'cross-site' || site === 'same-site';
	const origin = request.headers.get('origin');
	return origin !== null && origin !== new URL(publicUrl).origin;
}
/** The public app a visitor page's requests run under; it only ever narrows the caller to that app's visitor. */
export const VISITOR_APP = 'Bolt-App';
export const SHELL = `${BOLT}/shell`;
/** The browser's base path: the host names it in `<meta name="bolt-base">` when the workspace is served under a path (`/acme`). */
export const BASE = typeof document === 'undefined' ? '' : document.querySelector('meta[name="bolt-base"]')?.getAttribute('content') ?? '';
/** The browser URL of a workspace path (`/inbox` → `/acme/inbox`); anything else as it is. */
export const based = (path: string): string => path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path;
/** A browser URL as the workspace names it (`/acme/inbox` → `/inbox`), or `null` for one outside the workspace. */
export function logical(u: string | URL): URL | null {
	const x = new URL(u, location.href);
	if (x.origin !== location.origin) return null;
	if (BASE === '') return x;
	if (x.pathname !== BASE && !x.pathname.startsWith(`${BASE}/`)) return null;
	x.pathname = x.pathname.slice(BASE.length) || '/';
	return x;
}

export type ShellBoot = {
	/** `logo`: the host's first brand icon, the page's organization mark (`bolt.org`). */
	/** `environment`: the non-production badge's label (`environmentLabel`), absent in production. */
	/** `handle`: the tenant handle the sign-in card names; `apex`: where "Change workspace" leads (the host's workspace picker). */
	/** `organization`: the host lets an administrator edit the name and logo (`ShellHostConfig.organization`). */
	workspace: { name: string; locale: string; tz: string; logo?: string; environment?: string; handle?: string; apex?: string; organization?: true };
	actor: EngineActor | null; name: string | null; admin: boolean;
	/** Rule 39: the member or team being previewed and the administrator previewing. */
	preview: { user: string; by: string } | { team: string; by: string } | null;
	/** The host's banner for this member (`ShellHost.notice`: a billing notice). */
	notice?: ShellNotice;
	/** The member's other workspaces (`ShellHost.workspaces`): the switcher's options. */
	workspaces?: readonly WorkspaceLink[];
	nav: NavNode[]; surfaces: Surfaces; inbox: number;
	/** Each envoy's display name by key (its declared `name`), for the agent panel's conversation groups. */
	envoys?: { readonly [envoy: string]: string };
	/** The VAPID public key to subscribe this device to notices with (§5.7), or `null` when the host sends no push. */
	push: string | null;
	/** A visitor page's app and, when it declares one, the Turnstile site key. */
	visitor: { app: string; siteKey?: string } | null;
	/** What ui's generated forms and record views read per collection (its `CollectionExposure`), as this caller may use it. */
	catalog: { readonly [collection: string]: Exposure };
	/** The agent surface is on but the host binds no AI provider (P19): the panel says so instead of failing each turn. */
	aiUnconfigured?: true;
	/** The schema fingerprint the page boots against: `$bolt` sends it as `Bolt-Contract` (L-BOLT-171). */
	contract?: string;
};
/** Another workspace the member belongs to; `href` enters it. */
export type WorkspaceLink = { handle: string; name: string; href: string };
/** A host banner above every page; `href` is its one action. */
export type ShellNotice = { text: string; tone?: 'info' | 'warning'; href?: string; action?: string };
/**
 * The environment badge's label: nothing in production (or when unset), `local` for development, and any other name
 * as itself, so an unknown environment is visible rather than mistaken for production.
 */
export function environmentLabel(environment: string | undefined): string | null {
	const e = environment?.trim() ?? '';
	return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
}

export type Exposure = {
	label: readonly string[]; search?: readonly string[]; semantic?: true; fields: { readonly [f: string]: unknown };
	/** The named similarity searches (§3.3.4) a reader may run, by their typed `input`: the toolbar's `/<name>` indexes. */
	similarity?: { readonly [name: string]: { input: unknown; description: string } };
	/** The collection's named queries the caller holds, by their typed `input` and `output`: the toolbar's `/<query>` indexes. */
	queries?: { readonly [query: string]: { input: unknown; output: unknown; description: string } };
	relations?: { readonly [fk: string]: { targets: readonly string[]; optional?: true; inverse?: string } };
	/** hook:query — the many-relations a Where may cross here (`bolt.decode`, rule 11a). */
	many?: readonly string[];
	create?: { columns: readonly string[] }; update?: { columns: readonly string[] };
	actions?: { readonly [action: string]: { input: unknown; target?: 'record'; description?: string } };
	/** Fields this viewer reads only on some rows (rule 14): elsewhere they arrive `{ $masked: true }`; never a sort or filter key. */
	masked?: readonly string[];
	/** The view toolbar's info text: the collection's declared description, else its model's. */
	description?: string;
	/** The caller holds a delete arm. */
	delete?: true;
	/** The collection has an integration whose `<c>.integration` run the caller may start. */
	integration?: true;
	/** The `<c>.pipeline` feeds the caller may run (import: a create arm; export: a read arm), by their declared description. */
	pipeline?: { import?: string; export?: string };
};

/**
 * The caller's collections for ui: the model's label and search fields, the fields and one-relations the collection and
 * the caller's read arms expose (rule 14), the create/update columns and the actions the caller holds, and which of the
 * exposed fields are masked on some rows for this caller.
 */
/** The system collections the browser resolves as targets: the directory (pickers, `actor` operands) and stored files. */
const TARGETS = ['sys_user', 'sys_team', 'sys_file'] as const;
function pipelineOf(m: EngineManifest, a: Authority, c: string, reads: boolean): Pick<Exposure, 'pipeline'> {
	const p = m.pipelines?.[c] as { import?: { description: string }; export?: { description: string } } | undefined;
	const feeds = { ...(p?.import !== undefined && a.actor.kind === 'member' && (a.admin || (a.collections[c]?.create.length ?? 0) > 0) ? { import: p.import.description } : {}),
		...(p?.export !== undefined && a.actor.kind === 'member' && reads ? { export: p.export.description } : {}) };
	return Object.keys(feeds).length === 0 ? {} : { pipeline: feeds };
}
export function exposure(m: EngineManifest, a: Authority): ShellBoot['catalog'] {
	const out: { [c: string]: Exposure } = {};
	for (const [c, spec] of Object.entries(m.collections)) {
		const ca = a.collections[c], model = m.models[c];
		const reads = a.admin || (ca?.read.length ?? 0) > 0;
		const writes = (['create', 'update'] as const).filter((v) => spec[v] !== undefined && (a.admin || (ca?.[v].length ?? 0) > 0));
		const queries = Object.entries(spec.queries ?? {}).filter(([n]) => a.admin || (ca?.queries.includes(n) ?? false));
		const actions = Object.entries(spec.actions ?? {}).filter(([n, x]) => x.internal !== true && (a.admin || (ca?.actions.includes(n) ?? false)));
		if (model === undefined || (!reads && writes.length === 0 && actions.length === 0)) continue;
		const arms = ca?.read ?? [];
		const armed = (f: string) => a.admin || arms.some((x) => x.fields === 'all' || x.fields.includes(f));
		const readable = (f: string) => reads && (spec.read.fields === 'all' || spec.read.fields.includes(f)) && armed(f);
		const relExposed = (fk: string) => { const r = spec.read.relations ?? (spec.read.fields === 'all' ? 'all' : []); return r === 'all' || r.includes(fk); };
		// the columns this caller's own create/update arms admit (rule 14): a column no held arm names is filled by the host
		const columns = (v: 'create' | 'update') => spec[v]!.input.columns.filter((f) => a.admin || ca![v].some((x) => x.fields === 'all' || x.fields.includes(f)));
		// a create-only caller (a visitor's application form) still sees the fields it writes
		const written = new Set(writes.flatMap(columns));
		const fields = Object.entries(model.fields).filter(([f]) => readable(f) || written.has(f));
		const relations = Object.entries(m.relationships).flatMap(([key, r]) => {
			const [from, fk] = key.split('.') as [string, string];
			return from === c && ((reads && relExposed(fk) && armed(fk)) || written.has(fk))
				? [[fk, { targets: [r.to].flat(), ...(r.optional === true ? { optional: true as const } : {}), ...(r.inverse === undefined ? {} : { inverse: r.inverse }) }] as const] : []; // hook:query (inverse)
		});
		const many = !reads ? [] : Object.values(m.relationships).flatMap((r) => r.inverse !== undefined && [r.to].flat().includes(c) && relExposed(r.inverse) ? [r.inverse] : []); // hook:query
		const masked = a.admin ? [] : Object.keys(ca?.masks ?? {}).filter((f) => fields.some(([x]) => x === f));
		out[c] = { label: [model.label].flat(), ...(model.search === undefined ? {} : { search: model.search.text }),
			...(model.search?.semantic === undefined ? {} : { semantic: true as const }), fields: Object.fromEntries(fields),
			...(reads && Object.keys(spec.similarity ?? {}).length > 0 ? { similarity: Object.fromEntries(Object.entries(spec.similarity!).map(([n, x]) => [n, { input: x.input, description: x.description }])) } : {}),
			...(relations.length === 0 ? {} : { relations: Object.fromEntries(relations) }), ...(many.length === 0 ? {} : { many }), // hook:query (many)
			...Object.fromEntries(writes.map((v) => [v, { columns: columns(v) }])),
			...(queries.length === 0 ? {} : { queries: Object.fromEntries(queries.map(([n, x]) => [n, { input: x.input, output: x.output, description: x.description }])) }),
			...(actions.length === 0 ? {} : { actions: Object.fromEntries(actions.map(([n, x]) => [n, { input: x.input, ...(x.target === undefined ? {} : { target: x.target }), description: x.description }])) }),
			...(masked.length === 0 ? {} : { masked }),
			description: spec.description ?? model.description,
			...(spec.delete !== undefined && (a.admin || (ca?.delete.length ?? 0) > 0) ? { delete: true } : {}),
			...(m.integrations?.[c] !== undefined && (a.admin || a.automations.includes(`${c}.integration`)) ? { integration: true } : {}),
			...pipelineOf(m, a, c, reads) };
	}
	// the system targets a relation, an `id` input or a file field points at: their declared fields as the caller's grants or
	// the kernel directory let it read them
	for (const c of TARGETS) {
		const arms = a.collections[c]?.read ?? [], model = SYSTEM.models[c]!, read = SYSTEM.collections[c]!.read.fields;
		if (!a.admin && arms.length === 0) continue;
		const readable = Object.entries(model.fields).filter(([f]) => (read === 'all' || read.includes(f)) && (a.admin || arms.some((x) => x.fields === 'all' || x.fields.includes(f))));
		out[c] = { label: [model.label].flat(), fields: Object.fromEntries(readable) };
	}
	return out;
}

const appOf = (m: ShellManifest, name: string) => m.apps[name] as AppSpec | undefined;

/** The four kinds of `audience`; `public` apps run every viewer as the visitor (§3.9). */
export function audienceOf(spec: AppSpec | undefined): 'members' | 'external' | 'all' | 'public' {
	const a = spec?.audience ?? 'members';
	return typeof a === 'object' ? 'public' : a;
}
export const challengeOf = (m: ShellManifest, app: string): 'turnstile' | undefined => {
	const a = appOf(m, app)?.audience;
	return typeof a === 'object' ? a.challenge : undefined;
};

/**
 * Whether `auth` may open `app`. A visitor sees only its own public app, as does a member whose policy names it; a
 * member sees an app whose audience admits their kind and that a held policy's `capabilities.apps` admits (a name, `*`, or a `<group>/` prefix); an administrator
 * sees every app, public ones included, so they can try a form.
 */
export function canOpen(m: ShellManifest, auth: Authority, app: string): boolean {
	const spec = appOf(m, app);
	if (spec === undefined) return false;
	const audience = audienceOf(spec), actor = auth.actor;
	if (actor.kind === 'visitor') return actor.app === app;
	if (actor.kind !== 'member') return false;
	if (auth.admin) return true;
	if (audience === 'public') return holdsPublic(auth, app);
	if (audience !== 'all' && audience !== (actor.external ? 'external' : 'members')) return false;
	return auth.capabilities.apps.some((c) => c === '*' || c === app || app.startsWith(`${c}/`));
}

/**
 * The `Content-Security-Policy` a document is served with: a `site: true` page may be framed by any website (made to be
 * embedded); every other page only by the workspace itself, so no other site can overlay it (clickjacking). `path` is the
 * workspace path (`/app/portal/book`), without a base.
 */
export function framePolicy(m: ShellManifest, path: string): string {
	const r = route(m, new URL(path, 'http://x'));
	const site = r.kind === 'page' && appOf(m, r.app)?.pages[r.page]?.site === true;
	return `frame-ancestors ${site ? '*' : "'self'"}`;
}

/** A member whose policy names a public app by name (never `*` or a group) opens it as themselves, not as its visitor. */
export const holdsPublic = (auth: Authority, app: string): boolean =>
	auth.actor.kind === 'member' && !auth.admin && auth.capabilities.apps.includes(app);

/** `bolt.href(app, page?, record?)`: `/app/<app>[/<page>][?record=<collection>/<id>]`. */
export function href(app: string, page?: string, record?: { collection: string; id: string }): string {
	const path = `${APP_PREFIX}${app}${page === undefined ? '' : `/${page}`}`;
	return record === undefined ? path : `${path}?record=${encodeURIComponent(record.collection)}/${encodeURIComponent(record.id)}`;
}

/** The nav tree `auth` sees: top-level apps and groups in `workspace.apps` order, then by name; empty groups dropped. */
export function nav(m: ShellManifest, auth: Authority): NavNode[] {
	const groups = (m.groups ?? {}) as { readonly [g: string]: GroupSpec };
	const node = (name: string): NavNode | null => {
		const g = groups[name];
		if (g !== undefined) {
			const children = childrenOf(name).map(node).filter((n) => n !== null);
			if (children.length === 0) return null;
			const first = children.find((c) => c.name === `${name}/${g.defaultChild}`) ?? children[0]!;
			return { kind: 'group', name, title: g.label, ...(g.description === undefined ? {} : { description: g.description }), icon: g.icon, href: first.href, children };
		}
		const a = appOf(m, name);
		if (a === undefined || !canOpen(m, auth, name)) return null;
		const pages = Object.entries(a.pages).map(([p, s]): NavPage => ({ name: p, ...s, href: href(name, p) }));
		return { kind: 'app', name, title: a.title, description: a.description, icon: a.icon, ...(a.banner === undefined ? {} : { banner: a.banner }),
			href: pages[0]?.href ?? href(name), pages };
	};
	const all = [...Object.keys(m.apps), ...Object.keys(groups)];
	const childrenOf = (parent: string | null) => {
		const depth = parent === null ? 1 : parent.split('/').length + 1;
		const names = all.filter((n) => n.split('/').length === depth && (parent === null || n.startsWith(`${parent}/`)));
		const order = parent === null ? m.workspace.apps ?? [] : [`${parent}/${groups[parent]?.defaultChild}`];
		const rank = (n: string) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
		return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	};
	return childrenOf(null).map(node).filter((n) => n !== null);
}

/**
 * The shell's own surfaces an actor gets (§3.9, P1): externals never see settings, `/runs`, the staff inbox or Studio.
 * Settings and logs are an administrator's; Studio is every staff member's (their own draft; the host decides what a
 * non-administrator may do) on a host that serves it (`studio`).
 */
export type Surfaces = { inbox: boolean; runs: boolean; settings: boolean; agent: boolean; studio: boolean };
export function surfaces(m: ShellManifest, actor: EngineActor, admin: boolean, studio = false): Surfaces {
	if (actor.kind !== 'member') return { inbox: false, runs: false, settings: false, agent: false, studio: false };
	const staff = !actor.external;
	return { inbox: staff, runs: staff, settings: staff && admin, agent: (staff ? m.agent.internal : m.agent.external) !== undefined, studio: staff && studio };
}

export type Route =
	| { kind: 'page'; app: string; page: string; record?: { collection: string; id: string } }
	| { kind: 'home' } | { kind: 'inbox' } | { kind: 'settings'; tab: SettingsTab } | { kind: 'studio'; tab?: StudioTab }
	/** A moved page (`/runs` is Settings' Automations, `/logs` Studio's runtime log): the shell replaces the URL. */
	| { kind: 'redirect'; to: string }
	| { kind: 'signIn'; next?: string } | { kind: 'invite'; id: string } | { kind: 'register'; claim: string }
	| { kind: 'notFound' };
/** Settings proper (people, organization, audit, automation runs), then the System pages (channels, integrations, environment secrets). */
export const SETTINGS_TABS = ['people', 'organization', 'audit', 'automations', 'channels', 'integrations', 'secrets'] as const;
export type SettingsTab = typeof SETTINGS_TABS[number];
/** Studio's tabs, each a stable deep link `/studio/<tab>` (L-BOLT-528); `/studio` is the workbench. */
export const STUDIO_TABS = ['workbench', 'changes', 'live', 'mrs', 'runtime', 'operations'] as const;
export type StudioTab = typeof STUDIO_TABS[number];

/** The route a URL names. An app name is a folder path, so the longest declared app prefix wins. */
export function route(m: ShellManifest, url: URL): Route {
	const path = url.pathname.replace(/\/+$/, '') || '/';
	const seg = path.split('/').slice(1).map(decodeURIComponent);
	switch (seg[0]) {
		case '': return { kind: 'home' };
		case 'inbox': return seg.length === 1 ? { kind: 'inbox' } : { kind: 'notFound' };
		case 'runs': return seg.length <= 2 ? { kind: 'redirect', to: `/settings/automations${seg[1] === undefined ? '' : `?run=${encodeURIComponent(seg[1])}`}` } : { kind: 'notFound' };
		case 'settings': return { kind: 'settings', tab: SETTINGS_TABS.includes(seg[1] as never) ? seg[1] as SettingsTab : 'people' };
		case 'logs': return seg.length === 1 ? { kind: 'redirect', to: '/studio/runtime' } : { kind: 'notFound' };
		case 'studio': return seg.length === 1 ? { kind: 'studio' }
			: seg.length === 2 && STUDIO_TABS.includes(seg[1] as never) ? { kind: 'studio', tab: seg[1] as StudioTab } : { kind: 'notFound' };
		case 'sign-in': { const next = url.searchParams.get('next'); return { kind: 'signIn', ...(next?.startsWith('/') && !next.startsWith('//') ? { next } : {}) }; }
		case 'invite': return seg[1] ? { kind: 'invite', id: seg[1] } : { kind: 'notFound' };
		case 'register': return seg[1] ? { kind: 'register', claim: seg[1] } : { kind: 'notFound' };
		case 'app': break;
		default: return { kind: 'notFound' };
	}
	for (let n = seg.length; n > 1; n--) {
		const app = seg.slice(1, n).join('/'), a = appOf(m, app);
		if (a === undefined) continue;
		const rest = seg.slice(n), pages = Object.keys(a.pages);
		const page = rest[0] ?? pages[0];
		if (rest.length > 1 || page === undefined || !pages.includes(page)) return { kind: 'notFound' };
		const record = recordOf(url);
		return { kind: 'page', app, page, ...(record === null ? {} : { record }) };
	}
	return { kind: 'notFound' };
}

/** The record a `?record=<collection>/<id>` link opens over any shell route (the top of `recordsOf`'s stack). */
export function recordOf(url: URL): { collection: string; id: string } | null {
	return recordsOf(url).at(-1) ?? null;
}
/** The record-sheet stack (rule 10): each `?record=` in order, the last on top; a malformed entry is skipped. */
export function recordsOf(url: URL): { collection: string; id: string }[] {
	return url.searchParams.getAll('record').flatMap((v) => {
		const r = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(v);
		return r === null ? [] : [{ collection: r[1]!, id: r[2]! }];
	});
}
/** The URL with the record stack cut back to its first `depth` sheets (closing one closes those above it). */
export function withRecords(url: URL, depth: number): URL {
	const next = new URL(url), kept = recordsOf(url).slice(0, depth);
	next.searchParams.delete('record');
	for (const r of kept) next.searchParams.append('record', `${r.collection}/${r.id}`);
	return next;
}

/** What a signed-out viewer may open: public app pages, sign-in, invitation and registration. */
export function isOpenRoute(m: ShellManifest, r: Route): boolean {
	return r.kind === 'signIn' || r.kind === 'invite' || r.kind === 'register' || (r.kind === 'page' && audienceOf(appOf(m, r.app)) === 'public');
}
