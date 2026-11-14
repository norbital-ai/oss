// The shell's navigation: which apps an actor sees, the nav tree of apps and groups, the URL of a
// page or record, and the route a URL names. Pure: the host and the browser share it.
import type { Authority, EngineActor } from '../engine/contracts.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import { BOLT } from '../protocol/wire.ts';
import type { AutomationExposure, ModelExposure } from '@norbital-ai/ui';
import { Schema } from 'effect';
import { FieldsSchema } from '../protocol/public-page.ts';
import { automation_fields } from '../decl/runtime/automation-input.ts';
import type { ManifestItem } from './finder/manifest.ts';
import type { ReadCatalog } from '../protocol/read-answer.ts';
import type { OperationOutputs } from '../protocol/output-contract.ts';
import { STUDIO_TABS, type ShellNotice, type StudioTab, type WorkspaceLink } from '@norbital-ai/host-api';

type AppSpec = EngineManifest['apps'][string];
/** Browser route metadata; agent availability comes from the authorized boot surfaces. */
export type ShellManifest = Pick<EngineManifest, 'workspace' | 'apps'> &
	Partial<Pick<EngineManifest, 'groups'>>;

export type NavPage = {
	name: string;
	title: string;
	icon?: string;
	section?: string;
	portal?: true;
	href: string;
};
export type NavNode =
	| {
			kind: 'app';
			name: string;
			title: string;
			description: string;
			icon: string;
			banner?: string;
			href: string;
			pages: NavPage[];
	  }
	| {
			kind: 'group';
			name: string;
			title: string;
			description?: string;
			icon: string;
			href: string;
			children: NavNode[];
	  };

/** The apps a nav tree opens, groups flattened: the shell renders no other app's page. */
export const nav_apps = (nodes: readonly NavNode[]): string[] =>
	nodes.flatMap((node) => (node.kind === 'app' ? [node.name] : nav_apps(node.children)));

/** Exact workspace pages the in-app assistant may request; never URLs, API routes or sign-in actions. */
export function navigation_paths(nodes: readonly NavNode[], admin: boolean): string[] {
	const pages = (items: readonly NavNode[]): string[] =>
		items.flatMap((node) =>
			node.kind === 'group' ? pages(node.children) : node.pages.map((page) => page.href)
		);
	return [
		'/',
		'/inbox',
		...pages(nodes),
		...(admin
			? [
					'/settings/organization',
					'/settings/integrations',
					'/settings/secrets',
					'/command-center',
					...COMMAND_CENTER_TABS.map((tab) => `/command-center/${tab}`)
				]
			: [])
	];
}

const APP_PREFIX = '/app/';
const KIOSK_PREFIX = '/kiosk/';
/** The session cookie, the admin's preview-as target and the visitor's idempotency id. */
export const COOKIES = {
	session: '__Secure-bolt-session',
	preview: '__Secure-bolt-preview',
	visitor: '__Secure-bolt-visitor'
} as const;
/** Plain HTTP must not depend on browser exceptions for Secure cookies. */
export const cookie_names = (secure: boolean) =>
	secure ? COOKIES : { session: 'bolt-session', preview: 'bolt-preview', visitor: 'bolt-visitor' };
/**
 * The cookies' site attributes: over https, partitioned and sent in frames, so a portal page embedded in another site keeps
 * its own sign-in (kept apart from the top-level one: a framing site never borrows a member's session); over plain http
 * (`bolt dev`), `Lax` without Secure. Every cookie has no Domain and the workspace's `base_path` as its Path: workspaces
 * served under paths of one host keep their sign-ins apart (`__Host-` would force `Path=/`).
 * Cross-site writes are refused by `cross_site`, not by `SameSite`.
 */
export const cookie_site = (secure: boolean): string =>
	secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
/**
 * A browser write another site started (a forged form post or fetch): refused before it reaches a handler. A request from
 * a page of this workspace, framed or not, is `same-origin`; a server calling a webhook sends neither header.
 */
export function cross_site(request: Request, publicUrl: string): boolean {
	if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
		return false;
	const site = request.headers.get('sec-fetch-site');
	if (site !== null) return site === 'cross-site' || site === 'same-site';
	const origin = request.headers.get('origin');
	return origin !== null && origin !== new URL(publicUrl).origin;
}
/** The public app a visitor page's requests run under; it only ever narrows the caller to that app's visitor. */
export const VISITOR_APP = 'Bolt-App';
export const SHELL = `${BOLT}/shell`;
/** The browser's base path: the host names it in `<meta name="bolt-base">` when the workspace is served under a path (`/acme`). */
export const base = (): string =>
	typeof document === 'undefined'
		? ''
		: (document.querySelector('meta[name="bolt-base"]')?.getAttribute('content') ?? '');
/** The browser URL of a workspace path (`/inbox` → `/acme/inbox`); anything else as it is. */
export const based = (path: string): string =>
	path.startsWith('/') && !path.startsWith('//') ? `${base()}${path}` : path;
/** A browser URL as the workspace names it (`/acme/inbox` → `/inbox`), or `null` for one outside the workspace. */
export function logical(u: string | URL): URL | null {
	const x = new URL(u, location.href);
	if (x.origin !== location.origin) return null;
	const at = base();
	if (at === '') return x;
	if (x.pathname !== at && !x.pathname.startsWith(`${at}/`)) return null;
	x.pathname = x.pathname.slice(at.length) || '/';
	return x;
}

export type ShellBoot = {
	/**
	 * `logo`: the host's first brand icon, the page's organization mark (`bolt.org`). `environment`: the non-production
	 * badge's label (`environment_label`), absent in production. `handle`: the tenant handle the sign-in card names; `apex`:
	 * where "Change workspace" leads (the host's workspace picker). `organization`: the host lets an administrator edit the
	 * name and logo (`ShellHostConfig.organization`). `live`: this is a preview environment; the live workspace's address.
	 */
	workspace: {
		name: string;
		locale: string;
		tz: string;
		logo?: string;
		environment?: string;
		handle?: string;
		apex?: string;
		live?: string;
		organization?: true;
	};
	actor: EngineActor | null;
	name: string | null;
	admin: boolean;
	/** Rule 39: the member or team being previewed and the administrator previewing. */
	preview: { user: string; by: string } | { team: string; name: string; by: string } | null;
	/** The host's banner for this member (`ShellHost.notice`: a billing notice). */
	notice?: ShellNotice;
	/** The release's client hash: a live link that comes back under another reloads the page. */
	client?: string;
	/** Where this host serves Studio's bundle (`StudioPort.bundle`), under the workspace; absent: it serves none. */
	studio_bundle?: string;
	/** The member's other workspaces (`ShellHost.workspaces`): the switcher's options. */
	workspaces?: readonly WorkspaceLink[];
	nav: NavNode[];
	surfaces: Surfaces;
	inbox: number;
	/** The kiosk rows the viewer may open (server-computed via `kiosk_nav`, like `nav`). */
	kiosks: {
		readonly name: string;
		readonly title: string;
		readonly icon?: string;
		readonly href: string;
	}[];
	/** The automations this member may start by hand from the command center's Automations (`startable_automations`). */
	startable?: readonly {
		readonly name: string;
		readonly description: string;
		readonly needs_input?: boolean;
	}[];
	/** Each envoy's display name by key (its declared `name`), for the agent panel's conversation groups. */
	envoys?: { readonly [envoy: string]: string };
	/** The VAPID public key to subscribe this device to notices with, or `null` when the host sends no push. */
	push: string | null;
	/** A visitor page's app and, when it declares one, the Turnstile site key. */
	visitor: { app: string; site_key?: string } | null;
	/** What ui's generated forms and record views read per model (its `ModelExposure`), as this caller may use it. */
	catalog: { readonly [model: string]: ModelExposure };
	/** Field schemas for every output this caller holds, including its relation layers. */
	read_catalog: ReadCatalog;
	/** Inputs of the automations this caller may start; the host still validates every start. */
	automations: Readonly<Record<string, AutomationExposure>>;
	/** Result shapes of the automations this caller may start, for decoding their answers. */
	operation_outputs: OperationOutputs;
	/** Authorized manifest metadata for the shared search picker. */
	search?: readonly ManifestItem[];
	/** The agent surface is on but the host binds no AI provider: the panel says so instead of failing each turn. */
	ai_unconfigured?: true;
	/** The schema fingerprint the page boots against: the page context sends it as `Bolt-Contract`. */
	contract?: string;
};
/**
 * The environment badge's label: nothing in production (or when unset), `local` for development, and any other name
 * as itself, so an unknown environment is visible rather than mistaken for production.
 */
export function environment_label(environment: string | undefined): string | null {
	const e = environment?.trim() ?? '';
	return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
}

const appOf = (m: ShellManifest, name: string) => m.apps[name];
export const kiosk_of = (m: ShellManifest, name: string) => {
	const app = appOf(m, name);
	return app?.shell === 'kiosk' ? app : undefined;
};
export const kiosk_policies = (app: NonNullable<ReturnType<typeof kiosk_of>>) =>
	typeof app.audience === 'object' ? app.audience.public : app.policies;
export const can_open_kiosk = (
	app: NonNullable<ReturnType<typeof kiosk_of>>,
	authority: Authority,
	name: string
) =>
	audience_of(app) === 'public' ||
	(authority.actor.kind === 'member' &&
		(authority.admin ||
			((app.audience === 'all' ||
				(app.audience ?? 'members') === (authority.actor.external ? 'external' : 'members')) &&
				(authority.actor.external || holdsApp(authority, name)))));
const holdsApp = (authority: Authority, name: string) =>
	authority.capabilities.apps.some(
		(app) => app === '*' || app === name || name.startsWith(`${app}/`)
	);

/** The four kinds of `audience`; `public` apps run every viewer as the visitor. */
export function audience_of(spec: AppSpec | undefined): 'members' | 'external' | 'all' | 'public' {
	const a = spec?.audience ?? 'members';
	return typeof a === 'object' ? 'public' : a;
}
export const challenge_of = (m: ShellManifest, app: string): true | undefined => {
	const a = appOf(m, app)?.audience;
	return typeof a === 'object' ? a.challenge : undefined;
};

/**
 * Whether `auth` may open `app`. A visitor sees only its own public app, as does a member whose policy names it; a
 * member sees an app whose audience admits their kind and that a held policy's `capabilities.apps` admits (a name, `*`, or a `<group>/` prefix); an administrator
 * sees every app, public ones included, so they can try a form.
 */
export function can_open(m: ShellManifest, auth: Authority, app: string): boolean {
	const spec = appOf(m, app);
	if (spec === undefined || spec.shell === 'kiosk') return false;
	const audience = audience_of(spec),
		actor = auth.actor;
	if (actor.kind === 'visitor') return actor.app === app;
	if (actor.kind !== 'member') return false;
	if (auth.admin) return true;
	if (audience === 'public') return holds_public(auth, app);
	if (audience !== 'all' && audience !== (actor.external ? 'external' : 'members')) return false;
	return holdsApp(auth, app);
}

/**
 * A document may be framed by the workspace itself and the origins in the app or kiosk’s `embed` list.
 * `path` is the workspace path without a base.
 */
export function frame_policy(m: ShellManifest, path: string): string {
	const r = route(m, new URL(path, 'http://x'));
	const embed =
		r.kind === 'kiosk'
			? kiosk_of(m, r.kiosk)?.embed
			: r.kind === 'page'
				? appOf(m, r.app)?.embed
				: undefined;
	return ["frame-ancestors 'self'", ...(embed ?? [])].join(' ');
}

/** A member whose policy names a public app by name (never `*` or a group) opens it as themselves, not as its visitor. */
export const holds_public = (auth: Authority, app: string): boolean =>
	auth.actor.kind === 'member' && !auth.admin && auth.capabilities.apps.includes(app);

/**
 * `bolt.href(app, page?, record?)`: a page's one canonical address. Pages are named (`/app/<app>/<page>`), except the
 * page named as its app folder's own leaf, whose address is the folder (`/app/hr/entities` for `hr/entities`' page
 * `entities`; `page` omitted names that one). `route` refuses every other spelling.
 */
export function href(app: string, page?: string, record?: { model: string; id: string }): string {
	const path = `${APP_PREFIX}${app}${page === undefined || page === leafOf(app) ? '' : `/${page}`}`;
	return record === undefined
		? path
		: `${path}?record=${encodeURIComponent(record.model)}/${encodeURIComponent(record.id)}`;
}
const leafOf = (app: string) => app.split('/').at(-1);
/** `bolt.kiosk_href(kiosk, page?)`: `/kiosk/<kiosk>[/<page>]`. Kiosks take no record stack. */
export function kiosk_href(kiosk: string, page?: string): string {
	return `${KIOSK_PREFIX}${kiosk}${page === undefined ? '' : `/${page}`}`;
}

/** The kiosk rows a caller may open, in name order. */
export function kiosk_nav(
	m: EngineManifest,
	authority: Authority | null
): { name: string; title: string; icon?: string; href: string }[] {
	return Object.entries(m.apps)
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([name, spec]) => {
			if (
				spec.shell !== 'kiosk' ||
				(audience_of(spec) !== 'public' &&
					(authority === null || !can_open_kiosk(spec, authority, name)))
			)
				return [];
			const page = Object.keys(spec.pages)[0];
			return page === undefined
				? []
				: [
						{
							name,
							title: spec.title,
							...(spec.icon === undefined ? {} : { icon: spec.icon }),
							href: kiosk_href(name, page)
						}
					];
		});
}

/** Authorized input metadata for native automation forms. */
export function automation_inputs(
	m: EngineManifest,
	authority: Authority
): Readonly<Record<string, AutomationExposure>> {
	if (authority.actor.kind === 'visitor') return {};
	return Object.fromEntries(
		(authority.admin ? Object.keys(m.automations) : authority.automations).flatMap<
			readonly [string, AutomationExposure]
		>((name) => {
			const spec = m.automations[name];
			return spec === undefined
				? []
				: [
						[
							name,
							{
								input: Schema.decodeUnknownSync(FieldsSchema)(automation_fields(spec.input)),
								mode: spec.mode ?? 'job',
								description: spec.description
							}
						]
					];
		})
	);
}

/**
 * The automations `authority` may start from the command center's Automations. One with a required input opens its
 * native form first (`needs_input`), so a new automation is runnable without a bespoke page.
 */
export function startable_automations(
	m: EngineManifest,
	authority: Authority
): { name: string; description: string; needs_input: boolean }[] {
	return (authority.admin ? Object.keys(m.automations) : authority.automations)
		.toSorted()
		.flatMap((name) => {
			const spec = m.automations[name];
			return spec === undefined
				? []
				: [
						{
							name,
							description: spec.description,
							needs_input: Object.values(spec.input ?? {}).some((field) => field.optional !== true)
						}
					];
		});
}

/** The nav tree `auth` sees: top-level apps and groups in `workspace.apps` order, then by name; empty groups dropped. */
export function nav(m: ShellManifest, auth: Authority): NavNode[] {
	const groups = m.groups ?? {};
	const node = (name: string): NavNode | null => {
		const g = groups[name];
		if (g !== undefined) {
			const children = childrenOf(name)
				.map(node)
				.filter((n) => n !== null);
			const first = children.find((c) => c.name === `${name}/${g.default_child}`) ?? children[0];
			if (first === undefined) return null;
			return {
				kind: 'group',
				name,
				title: g.title,
				...(g.description === undefined ? {} : { description: g.description }),
				icon: g.icon,
				href: first.href,
				children
			};
		}
		const a = appOf(m, name);
		if (a === undefined || !can_open(m, auth, name)) return null;
		const pages = Object.entries<AppSpec['pages'][string]>(a.pages).map(([p, s]): NavPage => ({
			name: p,
			...s,
			href: href(name, p)
		}));
		return {
			kind: 'app',
			name,
			title: a.title,
			description: a.description,
			icon: a.icon,
			...(a.banner === undefined ? {} : { banner: a.banner }),
			href: pages[0]?.href ?? href(name),
			pages
		};
	};
	const all = [...Object.keys(m.apps), ...Object.keys(groups)];
	const childrenOf = (parent: string | null) => {
		const depth = parent === null ? 1 : parent.split('/').length + 1;
		const names = all.filter(
			(n) => n.split('/').length === depth && (parent === null || n.startsWith(`${parent}/`))
		);
		const order =
			parent === null ? (m.workspace.apps ?? []) : [`${parent}/${groups[parent]?.default_child}`];
		const rank = (n: string) => {
			const i = order.indexOf(n);
			return i < 0 ? order.length : i;
		};
		return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	};
	return childrenOf(null)
		.map(node)
		.filter((n) => n !== null);
}

/**
 * The shell's own surfaces an actor gets: externals never see settings, automation runs, the staff inbox or Studio.
 * Settings and logs are an administrator's; Studio is every staff member's (their own draft; the host decides what a
 * non-administrator may do) on a host that serves it (`studio`: Colony; an untethered workspace has none). The command
 * center is every staff member's (`runs`); its tabs follow the rest. A preview environment (`preview`) drops the meta
 * tools, Norbius and Studio; everything else stays (Settings loses Integrations and the command center People, `preview_route`).
 */
export type Surfaces = {
	inbox: boolean;
	runs: boolean;
	settings: boolean;
	agent: boolean;
	studio: boolean;
};
export function surfaces(
	m: Pick<EngineManifest, 'agent'>,
	actor: EngineActor,
	admin: boolean,
	studio = false,
	preview = false
): Surfaces {
	if (actor.kind !== 'member')
		return { inbox: false, runs: false, settings: false, agent: false, studio: false };
	const staff = !actor.external;
	return {
		inbox: staff,
		runs: staff,
		settings: staff && admin,
		agent: !preview && (staff ? m.agent.internal : m.agent.external) !== undefined,
		studio: staff && studio && !preview
	};
}

export type Route =
	| { kind: 'page'; app: string; page: string; record?: { model: string; id: string } }
	| { kind: 'kiosk'; kiosk: string; page: string }
	| { kind: 'home' }
	| { kind: 'inbox' }
	| { kind: 'settings'; tab: SettingsTab }
	| { kind: 'command_center'; tab?: CommandCenterTab }
	| { kind: 'studio'; tab?: StudioTab }
	| { kind: 'sign_in'; next?: string }
	| { kind: 'invite'; id: string }
	| { kind: 'not_found' };
/** The compiled page module a page or kiosk route names. */
export const page_chunk_key = (r: Route): string | null =>
	r.kind === 'page' ? `${r.app}/${r.page}`
		: r.kind === 'kiosk' ? `kiosk/${r.kiosk}/${r.page}` : null;
/** Settings proper (organization), then the System pages (integrations, secrets). */
const SETTINGS_TABS = ['organization', 'integrations', 'secrets'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/**
 * The command center's tabs, each a deep link `/command-center/<tab>`: what happens across the workspace (bundle
 * analysis, resource telemetry, runtime logs, the audit trail, automation runs, inference transcripts) and who has access.
 */
const COMMAND_CENTER_TABS = [
	'bundle',
	'telemetry',
	'logs',
	'audit',
	'automations',
	'inference',
	'people'
] as const;
export type CommandCenterTab = (typeof COMMAND_CENTER_TABS)[number];
const named = <T extends string>(tabs: readonly T[], value: string | undefined): T | undefined =>
	tabs.find((t) => t === value);
/**
 * A preview environment drops the meta tools: Studio and who-has-access management (the command center's People) open
 * the apps launcher, and so does Settings → Integrations, whose integration endpoints only the live workspace serves.
 */
export function preview_route(r: Route, preview: boolean): Route {
	return preview &&
		(r.kind === 'studio' ||
			(r.kind === 'command_center' && r.tab === 'people') ||
			(r.kind === 'settings' && r.tab === 'integrations'))
		? { kind: 'home' }
		: r;
}

/**
 * The command center tabs a viewer gets, in order: the host's inspection (bundle, telemetry, logs) needs a Studio
 * host and an administrator; the audit trail, inference transcripts (with Norbius) and People are an administrator's,
 * People never in a preview environment; automation runs are every staff member's. Empty: no command center.
 */
export function command_center_tabs(
	s: Surfaces,
	admin: boolean,
	preview: boolean
): readonly CommandCenterTab[] {
	if (!s.runs) return [];
	const lead = admin && s.settings;
	return COMMAND_CENTER_TABS.filter((tab) =>
		tab === 'automations'
			? true
			: tab === 'bundle' || tab === 'telemetry' || tab === 'logs'
				? lead && s.studio
				: tab === 'inference'
					? lead && s.agent
					: tab === 'people'
						? lead && !preview
						: lead
	);
}

/**
 * The route a URL names, at its one canonical spelling only: any other is `not_found` (the server already redirects
 * doubled and trailing slashes). An app name is a folder path, so the longest declared app prefix wins.
 */
export function route(m: ShellManifest, url: URL): Route {
	const seg = url.pathname.split('/').slice(1).map(decodeURIComponent);
	if (seg[0] === 'kiosk') {
		for (let n = seg.length; n > 1; n--) {
			const kiosk = seg.slice(1, n).join('/');
			const spec = kiosk_of(m, kiosk);
			if (spec === undefined) continue;
			const page = seg[n] ?? Object.keys(spec.pages)[0];
			if (seg.length > n + 1 || page === undefined || !Object.hasOwn(spec.pages, page)) break;
			return { kind: 'kiosk', kiosk, page };
		}
		return { kind: 'not_found' };
	}
	switch (seg[0]) {
		case '':
			return { kind: 'home' };
		case 'inbox':
			return seg.length === 1 ? { kind: 'inbox' } : { kind: 'not_found' };
		case 'settings': {
			const tab = named(SETTINGS_TABS, seg[1]);
			return seg.length === 2 && tab !== undefined
				? { kind: 'settings', tab }
				: { kind: 'not_found' };
		}
		case 'command-center': {
			if (seg.length === 1) return { kind: 'command_center' };
			const tab = named(COMMAND_CENTER_TABS, seg[1]);
			return seg.length === 2 && tab !== undefined
				? { kind: 'command_center', tab }
				: { kind: 'not_found' };
		}
		case 'studio': {
			// `/studio` is the workbench; `/studio/workbench` is not another spelling of it
			if (seg.length === 1) return { kind: 'studio' };
			const tab = named(STUDIO_TABS, seg[1]);
			return seg.length === 2 && tab !== undefined && tab !== 'workbench'
				? { kind: 'studio', tab }
				: { kind: 'not_found' };
		}
		case 'sign-in': {
			if (seg.length > 1) return { kind: 'not_found' };
			const next = url.searchParams.get('next');
			return {
				kind: 'sign_in',
				...(next?.startsWith('/') && !next.startsWith('//') ? { next } : {})
			};
		}
		case 'invite':
			return seg.length === 2 && seg[1] ? { kind: 'invite', id: seg[1] } : { kind: 'not_found' };
		case 'app':
			break;
		default:
			return { kind: 'not_found' };
	}
	for (let n = seg.length; n > 1; n--) {
		const app = seg.slice(1, n).join('/'),
			a = appOf(m, app);
		if (a === undefined || a.shell === 'kiosk') continue;
		const rest = seg.slice(n),
			page = rest[0] ?? leafOf(app);
		if (
			rest.length > 1 ||
			page === undefined ||
			!Object.hasOwn(a.pages, page) ||
			href(app, page) !== `${APP_PREFIX}${seg.slice(1).join('/')}`
		)
			return { kind: 'not_found' };
		const record = recordOf(url);
		return { kind: 'page', app, page, ...(record === null ? {} : { record }) };
	}
	return { kind: 'not_found' };
}

/** The record a `?record=<model>/<id>` link opens over any shell route (the top of `records_of`'s stack). */
function recordOf(url: URL): { model: string; id: string } | null {
	return records_of(url).at(-1) ?? null;
}
/** The record-sheet stack: each `?record=` in order, the last on top; a malformed entry is skipped. */
export function records_of(url: URL): { model: string; id: string }[] {
	return url.searchParams.getAll('record').flatMap((v) => {
		const [, model, id] = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(v) ?? [];
		return model === undefined || id === undefined ? [] : [{ model, id }];
	});
}
/** The URL with the record stack cut back to its first `depth` sheets (closing one closes those above it). */
export function with_records(url: URL, depth: number): URL {
	const next = new URL(url),
		kept = records_of(url).slice(0, depth);
	next.searchParams.delete('record');
	for (const r of kept) next.searchParams.append('record', `${r.model}/${r.id}`);
	return next;
}

/** What a signed-out viewer may open: public app and kiosk pages, sign-in and invitation. */
export function is_open_route(m: ShellManifest, r: Route): boolean {
	return (
		r.kind === 'sign_in' ||
		r.kind === 'invite' ||
		(r.kind === 'page' && audience_of(appOf(m, r.app)) === 'public') ||
		(r.kind === 'kiosk' && audience_of(kiosk_of(m, r.kiosk)) === 'public')
	);
}
