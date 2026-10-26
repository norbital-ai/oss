// The shell's navigation (§5.10, §3.3.1, §3.9): which apps an actor sees, the nav tree of apps and groups, the URL of a
// page or record, and the route a URL names. Pure: the host and the browser share it.
import type { Authority, EngineActor } from '../engine/contracts.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import { canOpenKiosk } from '../decl/runtime/kiosk.ts';
import { BOLT } from '../protocol/wire.ts';
import type { AutomationExposure, CollectionExposure } from '@norbital-ai/ui';
import { Schema } from 'effect';
import { FieldsSchema } from '../protocol/public-page.ts';

type AppSpec = EngineManifest['apps'][string];
/** Browser route metadata; agent availability comes from the authorized boot surfaces. */
export type ShellManifest = Pick<EngineManifest, 'workspace' | 'apps'> &
	Partial<Pick<EngineManifest, 'envoys' | 'kiosks' | 'groups'>>;

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

const APP_PREFIX = '/app/';
const KIOSK_PREFIX = '/kiosk/';
/** The session cookie (§5.11.2), the admin's preview-as target (rule 39) and the visitor's idempotency id (§5.10). */
export const COOKIES = {
	session: '__Secure-bolt-session',
	preview: '__Secure-bolt-preview',
	visitor: '__Secure-bolt-visitor'
} as const;
/** Plain HTTP must not depend on browser exceptions for Secure cookies. */
export const cookieNames = (secure: boolean) =>
	secure ? COOKIES : { session: 'bolt-session', preview: 'bolt-preview', visitor: 'bolt-visitor' };
/**
 * The cookies' site attributes: over https, partitioned and sent in frames, so a portal page embedded in another site keeps
 * its own sign-in (kept apart from the top-level one: a framing site never borrows a member's session); over plain http
 * (`bolt dev`), `Lax` without Secure. Every cookie has no Domain and the workspace's `basePath` as its Path: workspaces
 * served under paths of one host keep their sign-ins apart (`__Host-` would force `Path=/`).
 * Cross-site writes are refused by `crossSite`, not by `SameSite`.
 */
export const cookieSite = (secure: boolean): string =>
	secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
/**
 * A browser write another site started (a forged form post or fetch): refused before it reaches a handler. A request from
 * a page of this workspace, framed or not, is `same-origin`; a server calling a webhook sends neither header.
 */
export function crossSite(request: Request, publicUrl: string): boolean {
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
export const BASE =
	typeof document === 'undefined'
		? ''
		: (document.querySelector('meta[name="bolt-base"]')?.getAttribute('content') ?? '');
/** The browser URL of a workspace path (`/inbox` → `/acme/inbox`); anything else as it is. */
export const based = (path: string): string =>
	path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path;
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
	/**
	 * `logo`: the host's first brand icon, the page's organization mark (`bolt.org`). `environment`: the non-production
	 * badge's label (`environmentLabel`), absent in production. `handle`: the tenant handle the sign-in card names; `apex`:
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
	preview: { user: string; by: string } | { team: string; by: string } | null;
	/** The host's banner for this member (`ShellHost.notice`: a billing notice). */
	notice?: ShellNotice;
	/** The member's other workspaces (`ShellHost.workspaces`): the switcher's options. */
	workspaces?: readonly WorkspaceLink[];
	nav: NavNode[];
	surfaces: Surfaces;
	inbox: number;
	/** The kiosk rows the viewer may open (server-computed via `kioskNav`, like `nav`). */
	kiosks: {
		readonly name: string;
		readonly title: string;
		readonly icon?: string;
		readonly href: string;
	}[];
	/** The automations this member may start by hand from Settings → Automations (`startableAutomations`). */
	startable?: readonly { readonly name: string; readonly description: string }[];
	/** Each envoy's display name by key (its declared `name`), for the agent panel's conversation groups. */
	envoys?: { readonly [envoy: string]: string };
	/** The VAPID public key to subscribe this device to notices with (§5.7), or `null` when the host sends no push. */
	push: string | null;
	/** A visitor page's app and, when it declares one, the Turnstile site key. */
	visitor: { app: string; siteKey?: string } | null;
	/** What ui's generated forms and record views read per collection (its `CollectionExposure`), as this caller may use it. */
	catalog: { readonly [collection: string]: CollectionExposure };
	/** Inputs of the automations this caller may start; the host still validates every start. */
	automations: Readonly<Record<string, AutomationExposure>>;
	/** The agent surface is on but the host binds no AI provider (P19): the panel says so instead of failing each turn. */
	aiUnconfigured?: true;
	/** The schema fingerprint the page boots against: `$bolt` sends it as `Bolt-Contract` (L-BOLT-171). */
	contract?: string;
};
/** Another workspace the member belongs to; `href` enters it. */
export type WorkspaceLink = { handle: string; name: string; href: string };
/** A host banner above every page; `href` is its one action. */
export type ShellNotice = {
	text: string;
	tone?: 'info' | 'warning';
	href?: string;
	action?: string;
};
/**
 * The environment badge's label: nothing in production (or when unset), `local` for development, and any other name
 * as itself, so an unknown environment is visible rather than mistaken for production.
 */
export function environmentLabel(environment: string | undefined): string | null {
	const e = environment?.trim() ?? '';
	return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
}

const appOf = (m: ShellManifest, name: string) => m.apps[name];

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
	const audience = audienceOf(spec),
		actor = auth.actor;
	if (actor.kind === 'visitor') return actor.app === app;
	if (actor.kind !== 'member') return false;
	if (auth.admin) return true;
	if (audience === 'public') return holdsPublic(auth, app);
	if (audience !== 'all' && audience !== (actor.external ? 'external' : 'members')) return false;
	return auth.capabilities.apps.some((c) => c === '*' || c === app || app.startsWith(`${c}/`));
}

/**
 * The `Content-Security-Policy` a document is served with: a kiosk page or a `portal: true` page may
 * be framed by the workspace itself and the origins its `embed` names; every other page only by the
 * workspace, so no other site can overlay it (clickjacking). `path` is the workspace path
 * (`/app/portal/book`), without a base.
 */
export function framePolicy(m: ShellManifest, path: string): string {
	const r = route(m, new URL(path, 'http://x'));
	const embed =
		r.kind === 'kiosk'
			? m.kiosks?.[r.kiosk]?.embed
			: r.kind === 'page'
				? appOf(m, r.app)?.pages[r.page]?.embed
				: undefined;
	return ["frame-ancestors 'self'", ...(embed ?? [])].join(' ');
}

/** A member whose policy names a public app by name (never `*` or a group) opens it as themselves, not as its visitor. */
export const holdsPublic = (auth: Authority, app: string): boolean =>
	auth.actor.kind === 'member' && !auth.admin && auth.capabilities.apps.includes(app);

/** `bolt.href(app, page?, record?)`: `/app/<app>[/<page>][?record=<collection>/<id>]`. */
export function href(
	app: string,
	page?: string,
	record?: { collection: string; id: string }
): string {
	const path = `${APP_PREFIX}${app}${page === undefined ? '' : `/${page}`}`;
	return record === undefined
		? path
		: `${path}?record=${encodeURIComponent(record.collection)}/${encodeURIComponent(record.id)}`;
}
/** `bolt.kioskHref(kiosk, page?)`: `/kiosk/<kiosk>[/<page>]`. Kiosks take no record stack. */
export function kioskHref(kiosk: string, page?: string): string {
	return `${KIOSK_PREFIX}${kiosk}${page === undefined ? '' : `/${page}`}`;
}

/** The kiosk rows a caller may open, in name order. */
export function kioskNav(
	m: EngineManifest,
	authority: Authority | null
): { name: string; title: string; icon?: string; href: string }[] {
	return Object.entries(m.kiosks ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([name, spec]) => {
			if (
				(spec.auth ?? 'members') !== 'none' &&
				(authority === null || !canOpenKiosk(m, name, authority))
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
							href: kioskHref(name, page)
						}
					];
		});
}

/** Authorized input metadata for native automation forms. */
export function automationInputs(
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
								input: Schema.decodeUnknownSync(FieldsSchema)(spec.input ?? {}),
								description: spec.description
							}
						]
					];
		})
	);
}

/** The automations `authority` may start from Settings → Automations with no input: every input field optional. */
export function startableAutomations(
	m: EngineManifest,
	authority: Authority
): { name: string; description: string }[] {
	return (authority.admin ? Object.keys(m.automations) : authority.automations)
		.toSorted()
		.flatMap((name) => {
			const spec = m.automations[name];
			return spec === undefined ||
				Object.values(spec.input ?? {}).some((field) => field.optional !== true)
				? []
				: [{ name, description: spec.description }];
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
			if (children.length === 0) return null;
			const first = children.find((c) => c.name === `${name}/${g.defaultChild}`) ?? children[0]!;
			return {
				kind: 'group',
				name,
				title: g.label,
				...(g.description === undefined ? {} : { description: g.description }),
				icon: g.icon,
				href: first.href,
				children
			};
		}
		const a = appOf(m, name);
		if (a === undefined || !canOpen(m, auth, name)) return null;
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
			parent === null ? (m.workspace.apps ?? []) : [`${parent}/${groups[parent]?.defaultChild}`];
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
 * The shell's own surfaces an actor gets (§3.9, P1): externals never see settings, automation runs, the staff inbox or Studio.
 * Settings and logs are an administrator's; Studio is every staff member's (their own draft; the host decides what a
 * non-administrator may do) on a host that serves it (`studio`). A preview environment (`preview`) drops the meta
 * tools, Norbius and Studio; everything else stays (Settings loses its People and Integrations tabs, `previewRoute`).
 */
type Surfaces = {
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
	| { kind: 'page'; app: string; page: string; record?: { collection: string; id: string } }
	| { kind: 'kiosk'; kiosk: string; page: string }
	| { kind: 'home' }
	| { kind: 'inbox' }
	| { kind: 'connections' }
	| { kind: 'settings'; tab: SettingsTab }
	| { kind: 'studio'; tab?: StudioTab }
	| { kind: 'signIn'; next?: string }
	| { kind: 'invite'; id: string }
	| { kind: 'notFound' };
/** Settings proper (people, organization, audit, automation runs), then the System pages (integrations, secrets). */
const SETTINGS_TABS = [
	'people',
	'organization',
	'audit',
	'automations',
	'integrations',
	'secrets'
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Studio's tabs, each a stable deep link `/studio/<tab>` (L-BOLT-528); `/studio` is the workbench. */
const STUDIO_TABS = [
	'workbench',
	'changes',
	'live',
	'mrs',
	'runtime',
	'operations',
	'usage',
	'rules'
] as const;
export type StudioTab = (typeof STUDIO_TABS)[number];
const named = <T extends string>(tabs: readonly T[], value: string | undefined): T | undefined =>
	tabs.find((t) => t === value);

/**
 * A preview environment drops the meta tools: Studio and who-has-access management (Settings → People) open the apps
 * launcher, and so do Connections and Settings → Integrations, whose integration endpoints only the live workspace serves.
 */
export function previewRoute(r: Route, preview: boolean): Route {
	return preview &&
		(r.kind === 'studio' ||
			r.kind === 'connections' ||
			(r.kind === 'settings' && (r.tab === 'people' || r.tab === 'integrations')))
		? { kind: 'home' }
		: r;
}

/** The route a URL names. An app name is a folder path, so the longest declared app prefix wins. */
export function route(m: ShellManifest, url: URL): Route {
	const path = url.pathname.replace(/\/+$/, '') || '/';
	const seg = path.split('/').slice(1).map(decodeURIComponent);
	if (seg[0] === 'kiosk') {
		const kiosk = seg[1] ?? '',
			spec = m.kiosks?.[kiosk];
		if (spec === undefined) return { kind: 'notFound' };
		const pages = Object.keys(spec.pages);
		const page = seg[2] ?? pages[0];
		if (seg.length > 3 || page === undefined || !pages.includes(page)) return { kind: 'notFound' };
		return { kind: 'kiosk', kiosk, page };
	}
	switch (seg[0]) {
		case '':
			return { kind: 'home' };
		case 'inbox':
			return seg.length === 1 ? { kind: 'inbox' } : { kind: 'notFound' };
		case 'connections':
			return seg.length === 1 ? { kind: 'connections' } : { kind: 'notFound' };
		case 'settings':
			return { kind: 'settings', tab: named(SETTINGS_TABS, seg[1]) ?? 'people' };
		case 'studio': {
			if (seg.length === 1) return { kind: 'studio' };
			const tab = named(STUDIO_TABS, seg[1]);
			return seg.length === 2 && tab !== undefined ? { kind: 'studio', tab } : { kind: 'notFound' };
		}
		case 'sign-in': {
			const next = url.searchParams.get('next');
			return {
				kind: 'signIn',
				...(next?.startsWith('/') && !next.startsWith('//') ? { next } : {})
			};
		}
		case 'invite':
			return seg[1] ? { kind: 'invite', id: seg[1] } : { kind: 'notFound' };
		case 'app':
			break;
		default:
			return { kind: 'notFound' };
	}
	for (let n = seg.length; n > 1; n--) {
		const app = seg.slice(1, n).join('/'),
			a = appOf(m, app);
		if (a === undefined) continue;
		const rest = seg.slice(n),
			pages = Object.keys(a.pages);
		const page = rest[0] ?? pages[0];
		if (rest.length > 1 || page === undefined || !pages.includes(page)) return { kind: 'notFound' };
		const record = recordOf(url);
		return { kind: 'page', app, page, ...(record === null ? {} : { record }) };
	}
	return { kind: 'notFound' };
}

/** The record a `?record=<collection>/<id>` link opens over any shell route (the top of `recordsOf`'s stack). */
function recordOf(url: URL): { collection: string; id: string } | null {
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
	const next = new URL(url),
		kept = recordsOf(url).slice(0, depth);
	next.searchParams.delete('record');
	for (const r of kept) next.searchParams.append('record', `${r.collection}/${r.id}`);
	return next;
}

/** What a signed-out viewer may open: public app pages, `auth: 'none'` kiosks, sign-in and invitation. */
export function isOpenRoute(m: ShellManifest, r: Route): boolean {
	return (
		r.kind === 'signIn' ||
		r.kind === 'invite' ||
		(r.kind === 'page' && audienceOf(appOf(m, r.app)) === 'public') ||
		(r.kind === 'kiosk' && m.kiosks?.[r.kiosk]?.auth === 'none')
	);
}
