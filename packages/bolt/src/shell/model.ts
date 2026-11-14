// The boot as the sidebar's navigation model (`Nav.svelte`),  Operations (Norbius, the agent, opened
// by `NORBIUS` or ⌘K; Approvals) above Applications, one row per app (or a group of apps); an app's pages
// are the tab strip under its banner (`pages`), not sidebar rows. Everything else sits in the account row's ellipsis
// popover: Settings (Organization, Integrations, Secrets), System (the command center: builds and releases, the
// audit trail, automation runs, inference and people; and Workspace Studio on a host that serves it), Portals (every `portal: true` page the viewer may open — kiosks and customer-facing pages, never a sidebar row or tab). Host plugins and the organisation list are the host's, so this model carries only the current workspace.
import type { FeatureColorKey } from '@norbital-ai/ui/brand';
import type { WorkspaceLink } from '@norbital-ai/host-api';
import { based, command_center_tabs, type NavNode, type NavPage, type ShellBoot } from './nav.ts';

/** Norbius's row is no page: the shell opens the agent when the navigator is handed this href. */
export const NORBIUS = '#norbius';
export type Translate = (key: string) => string;
export interface NavItem {
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly href: string;
	readonly active: boolean;
	readonly badge?: string;
	readonly description?: string | null;
	readonly thumbnail?: string | null;
	readonly children?: readonly NavItem[];
	/** An app's pages, when it has more than one: the tab strip under its banner. */
	readonly pages?: readonly NavItem[];
	/** The icon tile's hue (ui's `FEATURE_COLORS`): an application wears `customApps`, for applications. */
	readonly feature_color?: FeatureColorKey;
}
export interface NavModel {
	/** The switcher's workspace: its handle, name and logo (the host's brand icon), else initials; `others` are its options. */
	readonly workspace: {
		readonly handle: string | null;
		readonly name: string;
		readonly logo: string | null;
		readonly others: readonly WorkspaceLink[];
	};
	readonly user: { readonly name: string; readonly email: string; readonly role: string };
	readonly sections: readonly {
		readonly key: 'operations' | 'applications';
		readonly label: string;
		readonly items: readonly NavItem[];
	}[];
	readonly utilities: readonly NavItem[];
}
const under = (path: string, href: string) =>
	path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`);

/** A workspace media path (`app-media/x.webp`, relative to the workspace's `assets/`) as the URL it is served at; absolute ones pass. */
export const media = (src: string): string =>
	/^([a-z][a-z0-9+.-]*:|\/)/i.test(src) ? src : based(`/assets/${src}`);

function item(n: NavNode, path: string, t: Translate): NavItem {
	const children = n.kind === 'group' ? n.children.map((c) => item(c, path, t)) : [];
	// the page whose address is the app's own folder sits above its siblings: the longest match is the open one
	const open =
		n.kind === 'app'
			? n.pages
					.filter((p) => under(path, p.href))
					.reduce<string | undefined>(
						(a, p) => (a === undefined || p.href.length > a.length ? p.href : a),
						undefined
					)
			: undefined;
	const pages =
		n.kind === 'app' && n.pages.length > 1
			? n.pages.map((p) => ({
					key: `${n.name}/${p.name}`,
					label: t(p.title),
					icon: p.icon ?? null,
					href: p.href,
					active: p.href === open
				}))
			: [];
	return {
		key: n.name,
		label: t(n.title),
		icon: n.icon,
		href: n.href,
		description: n.description === undefined ? null : t(n.description),
		thumbnail: n.kind === 'app' && n.banner !== undefined ? media(n.banner) : null,
		feature_color: 'customApps',
		active: n.kind === 'app' ? under(path, `/app/${n.name}`) : children.some((c) => c.active),
		...(children.length === 0 ? {} : { children }),
		...(pages.length === 0 ? {} : { pages })
	};
}
/** The tree without its portal pages: an app left with none drops, and a group left with no child. */
function ordinary(n: NavNode): NavNode | null {
	if (n.kind === 'app') {
		const pages = n.pages.filter((p) => p.portal !== true);
		const first = pages[0];
		return first === undefined ? null : { ...n, pages, href: first.href };
	}
	const children = n.children.map(ordinary).filter((c) => c !== null);
	const first = children[0];
	return first === undefined
		? null
		: {
				...n,
				children,
				href: children.some((c) => c.href === n.href) ? n.href : first.href
			};
}
const portalPages = (n: NavNode): (NavPage & { app: string })[] =>
	n.kind === 'app'
		? n.pages.filter((p) => p.portal === true).map((p) => ({ ...p, app: n.name }))
		: n.children.flatMap(portalPages);

/** The open app's row (in a group or not): its banner and page tabs sit above the page. */
export function active_app(model: NavModel): NavItem | null {
	const find = (items: readonly NavItem[]): NavItem | null => {
		for (const i of items) {
			if (!i.active) continue;
			return i.children === undefined ? i : find(i.children);
		}
		return null;
	};
	return find(model.sections.find((s) => s.key === 'applications')?.items ?? []);
}

export function navigation_model(boot: ShellBoot, path: string, t: Translate): NavModel {
	const actor = boot.actor?.kind === 'member' ? boot.actor : null;
	const s = boot.surfaces;
	const apps = boot.nav
		.map(ordinary)
		.filter((n) => n !== null)
		.map((n) => item(n, path, t));
	const leaf = (key: string, label: string, icon: string, href: string): NavItem => ({
		key,
		label: t(label),
		icon,
		href,
		active: under(path, href)
	});
	const ops = [
		...(s.agent
			? [
					{
						key: 'norbius',
						label: t('Norbius'),
						icon: 'concept:agents',
						href: NORBIUS,
						active: false
					}
				]
			: []),
		...(s.inbox
			? [
					{
						...leaf('approvals', 'Approvals', 'concept:approvals', '/inbox'),
						...(boot.inbox > 0 ? { badge: String(boot.inbox) } : {})
					}
				]
			: [])
	]; // hook:agent-ui
	const group = (key: string, label: string, children: NavItem[]): NavItem[] => {
		const first = children[0];
		return first === undefined ? [] : [{
			key,
			label: t(label),
			icon: null,
			href: first.href,
			active: children.some((c) => c.active),
			children
		}];
	};
	const preview = boot.workspace.live !== undefined;
	const utilities = [
		...group(
			'settings',
			'Settings',
			s.settings
				? [
						leaf('organization', 'Organization', 'concept:workspace', '/settings/organization'),
						// a preview serves no integration endpoints: they are the live workspace's (`preview_route`)
						...(preview
							? []
							: [leaf('integrations', 'Integrations', 'concept:integrations', '/settings/integrations')]),
						leaf('secrets', 'Secrets', 'lucide:key-round', '/settings/secrets')
					]
				: []
		),
		...group('system', 'System', [
			...(command_center_tabs(s, boot.admin, preview).length > 0
				? [leaf('command-center', 'Command center', 'lucide:radar', '/command-center')]
				: []),
			...(s.studio ? [leaf('studio', 'Workspace Studio', 'concept:studio', '/studio')] : [])
		]),
		...group(
			'portals',
			'Portals',
			boot.nav
				.flatMap(portalPages)
				.map((p) => leaf(`${p.app}/${p.name}`, p.title, p.icon ?? 'lucide:app-window', p.href))
		),
		...group(
			'kiosks',
			'Kiosks',
			boot.kiosks.map((k) => leaf(k.name, k.title, k.icon ?? 'lucide:app-window', k.href))
		)
	];
	return {
		workspace: {
			handle: boot.workspace.handle ?? null,
			name: boot.workspace.name,
			logo: boot.workspace.logo ?? null,
			others: boot.workspaces ?? []
		},
		user: {
			name: boot.name ?? actor?.email ?? '',
			email: actor?.email ?? '',
			role: boot.admin ? t('Administrator') : actor?.external ? t('External') : t('Member')
		},
		sections: [
			...(ops.length > 0
				? [{ key: 'operations' as const, label: t('Operations'), items: ops }]
				: []),
			{ key: 'applications', label: t('Applications'), items: apps }
		],
		utilities
	};
}
