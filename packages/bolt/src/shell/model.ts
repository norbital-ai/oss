// The boot as the sidebar's navigation model (`Nav.svelte`), as staging draws it: Operations (Norbius, the agent, opened
// by `NORBIUS` or ⌘K; Approvals) above Applications, one row per app (or a group of apps); an app's pages
// are the tab strip under its banner (`pages`), not sidebar rows. Everything else sits in the account row's ellipsis
// popover: Settings (People, Organization, Audit, Automations), System (Channels, Integrations, Environment secrets,
// Workspace Studio, whose runtime log is the workspace log) and Kiosks (every `kiosk: true` page the viewer may open — device surfaces, never a sidebar row or tab). Host plugins and the organisation list are the host's, so this model carries only the current workspace.
import type { FeatureColorKey } from '@norbital-ai/ui/brand';
import { based, type NavNode, type NavPage, type ShellBoot } from './nav.ts';

/** Norbius's row is no page: the shell opens the agent when the navigator is handed this href. */
export const NORBIUS = '#norbius';
export type Translate = (key: string) => string;
export interface NavItem {
	readonly key: string; readonly label: string; readonly icon: string | null; readonly href: string; readonly active: boolean;
	readonly badge?: string; readonly description?: string | null; readonly thumbnail?: string | null; readonly children?: readonly NavItem[];
	/** An app's pages, when it has more than one: the tab strip under its banner. */
	readonly pages?: readonly NavItem[];
	/** The icon tile's hue (ui's `FEATURE_COLORS`): an application wears `customApps`, as on staging. */
	readonly featureColor?: FeatureColorKey;
}
export interface NavModel {
	/** The switcher's workspace: its name and logo (the host's brand icon), else initials. */
	readonly workspace: { readonly name: string; readonly logo: string | null; readonly apex: string | null };
	readonly user: { readonly name: string; readonly email: string; readonly role: string };
	readonly sections: readonly { readonly key: 'operations' | 'applications'; readonly label: string; readonly items: readonly NavItem[] }[];
	readonly utilities: readonly NavItem[];
}
const under = (path: string, href: string) => path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}?`);

/** A workspace media path (`app-media/x.webp`, relative to the workspace's `assets/`) as the URL it is served at; absolute ones pass. */
export const media = (src: string): string => /^([a-z][a-z0-9+.-]*:|\/)/i.test(src) ? src : based(`/assets/${src}`);

function item(n: NavNode, path: string, t: Translate): NavItem {
	const children = n.kind === 'group' ? n.children.map((c) => item(c, path, t)) : [];
	const pages = n.kind === 'app' && n.pages.length > 1
		? n.pages.map((p) => ({ key: `${n.name}/${p.name}`, label: t(p.title), icon: p.icon ?? null, href: p.href, active: under(path, p.href) })) : [];
	return { key: n.name, label: t(n.title), icon: n.icon, href: n.href, description: n.description === undefined ? null : t(n.description),
		thumbnail: n.kind === 'app' && n.banner !== undefined ? media(n.banner) : null, featureColor: 'customApps',
		active: n.kind === 'app' ? under(path, `/app/${n.name}`) : children.some((c) => c.active),
		...(children.length === 0 ? {} : { children }), ...(pages.length === 0 ? {} : { pages }) };
}
/** The tree without its kiosk pages: an app left with none drops, and a group left with no child. */
function ordinary(n: NavNode): NavNode | null {
	if (n.kind === 'app') {
		const pages = n.pages.filter((p) => p.kiosk !== true);
		return pages.length === 0 ? null : { ...n, pages, href: pages[0]!.href };
	}
	const children = n.children.map(ordinary).filter((c) => c !== null);
	return children.length === 0 ? null : { ...n, children, href: children.some((c) => c.href === n.href) ? n.href : children[0]!.href };
}
const kioskPages = (n: NavNode): (NavPage & { app: string })[] =>
	n.kind === 'app' ? n.pages.filter((p) => p.kiosk === true).map((p) => ({ ...p, app: n.name })) : n.children.flatMap(kioskPages);

/** The open app's row (in a group or not): its banner and page tabs sit above the page. */
export function activeApp(model: NavModel): NavItem | null {
	const find = (items: readonly NavItem[]): NavItem | null => {
		for (const i of items) {
			if (!i.active) continue;
			return i.children === undefined ? i : find(i.children);
		}
		return null;
	};
	return find(model.sections.find((s) => s.key === 'applications')?.items ?? []);
}

export function navigationModel(boot: ShellBoot, path: string, t: Translate): NavModel {
	const actor = boot.actor?.kind === 'member' ? boot.actor : null;
	const s = boot.surfaces;
	const apps = boot.nav.map(ordinary).filter((n) => n !== null).map((n) => item(n, path, t));
	const leaf = (key: string, label: string, icon: string, href: string): NavItem => ({ key, label: t(label), icon, href, active: under(path, href) });
	const ops = [...(s.agent ? [{ key: 'norbius', label: t('Norbius'), icon: 'lucide:sparkles', href: NORBIUS, active: false, badge: '⌘K' }] : []),
		...(s.inbox ? [{ ...leaf('approvals', 'Approvals', 'lucide:shield-check', '/inbox'), ...(boot.inbox > 0 ? { badge: String(boot.inbox) } : {}) }] : []),
]; // hook:agent-ui
	const group = (key: string, label: string, children: NavItem[]): NavItem[] =>
		children.length === 0 ? [] : [{ key, label: t(label), icon: null, href: children[0]!.href, active: children.some((c) => c.active), children }];
	const utilities = [
		...group('settings', 'Settings', s.settings ? [leaf('people', 'People', 'lucide:users', '/settings/people'),
			leaf('organization', 'Organization', 'lucide:building-2', '/settings/organization'), leaf('audit', 'Audit', 'lucide:history', '/settings/audit'),
			leaf('automations', 'Automations', 'lucide:refresh-cw', '/settings/automations')] : []),
		...group('system', 'System', [
			...(s.settings ? [leaf('channels', 'Channels', 'lucide:radio-tower', '/settings/channels'), leaf('integrations', 'Integrations', 'lucide:plug', '/settings/integrations'),
				leaf('secrets', 'Environment secrets', 'lucide:key-round', '/settings/secrets')] : []),
			...(s.studio ? [leaf('studio', 'Workspace Studio', 'lucide:code-xml', '/studio')] : []),
		]),
		...group('kiosks', 'Kiosks', boot.nav.flatMap(kioskPages).map((p) => leaf(`${p.app}/${p.name}`, p.title, p.icon ?? 'lucide:scan-face', p.href))),
	];
	return {
		workspace: { name: boot.workspace.name, logo: boot.workspace.logo ?? null, apex: boot.workspace.apex ?? null },
		user: { name: boot.name ?? actor?.email ?? '', email: actor?.email ?? '', role: boot.admin ? t('Administrator') : actor?.external ? t('External') : t('Member') },
		sections: [...(ops.length > 0 ? [{ key: 'operations' as const, label: t('Operations'), items: ops }] : []),
			{ key: 'applications', label: t('Applications'), items: apps }],
		utilities,
	};
}
