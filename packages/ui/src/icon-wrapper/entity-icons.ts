// Canonical entity→icon mapping. Every entity/concept in the Norbital
// system maps to exactly one icon. All icon consumers resolve through this
// registry — never hardcode icon strings directly.
//
// References may point to Iconify or the canonical `product:*` icon family.
// Render them through `IconWrapper` so product concepts never drift to a
// substitute glyph in another surface.

export const ENTITY_ICONS = {
	// ── Data types (Postgres column types) ──────────────────────────
	datatype: {
		bool: 'lucide:toggle-left',
		instant_range: 'lucide:calendar-range',
		enum: 'lucide:list',
		extension: 'lucide:puzzle',
		file: 'lucide:file-image',
		geolocation: 'lucide:map-pin',
		instant: 'lucide:clock',
		money: 'lucide:banknote',
		numeric: 'lucide:hash',
		range: 'lucide:sliders-horizontal',
		record_ref: 'lucide:link',
		relationship: 'lucide:table-2',
		team: 'lucide:users',
		text: 'lucide:text',
		user: 'lucide:user',
		uuid: 'lucide:key'
	},

	// ── System modules / features ───────────────────────────────────
	module: {
		accessControl: 'product:organization',
		agents: 'product:agent',
		applications: 'product:apps',
		approvals: 'product:approvals',
		automations: 'product:automations',
		workspaceStudio: 'product:studio',
		builtin: 'lucide:blocks',
		customApps: 'product:apps',
		dataBrowser: 'product:models',
		moduleStudio: 'product:studio',
		permissions: 'product:policies',
		tasks: 'lucide:list-todo'
	},

	// ── Common UI states ────────────────────────────────────────────
	state: {
		success: 'lucide:circle-check',
		error: 'lucide:circle-x',
		info: 'lucide:info',
		warning: 'lucide:triangle-alert',
		empty: 'lucide:package-open',
		loading: 'lucide:loader-circle'
	},

	// ── Shared UI / common entities ─────────────────────────────────
	ui: {
		add: 'lucide:plus',
		calendar: 'lucide:calendar',
		chart: 'lucide:chart-line',
		close: 'lucide:x',
		dashboard: 'lucide:layout-dashboard',
		delete: 'lucide:trash-2',
		document: 'lucide:file-text',
		edit: 'lucide:square-pen',
		externalLink: 'lucide:external-link',
		filter: 'lucide:filter',
		maximize: 'lucide:maximize-2',
		moreHorizontal: 'lucide:ellipsis',
		moreVertical: 'lucide:ellipsis-vertical',
		play: 'lucide:play',
		search: 'lucide:search',
		settings: 'lucide:settings',
		share: 'lucide:share-2',
		star: 'lucide:star',
		variable: 'lucide:braces'
	}
} as const;

type EntityCategory = keyof typeof ENTITY_ICONS;
type EntityName<C extends EntityCategory> = keyof (typeof ENTITY_ICONS)[C];

export function resolveIcon(name: EntityName<EntityCategory> | string): string {
	for (const category of Object.values(ENTITY_ICONS)) {
		if (name in category) {
			return category[name as keyof typeof category];
		}
	}
	return name;
}
