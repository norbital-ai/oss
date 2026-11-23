// The product's feature colours (brand): one hue per platform feature, for its icon tile, its
// icon and its accent chip. Class strings are literal so Tailwind's scan of this package generates them.
import { ENTITY_ICONS } from '../primitives/icon/entity-icons.js';

/** A platform feature that has its own brand colour. */
export type FeatureColorKey =
	| 'accessControl'
	| 'agents'
	| 'applications'
	| 'approvals'
	| 'automations'
	| 'workspaceStudio'
	| 'builtIn'
	| 'customApps'
	| 'moduleStudio'
	| 'permissions'
	| 'dataBrowser'
	| 'tasks';
export type FeatureColorStyles = {
	icon: string;
	iconWrapperClass: string;
	icon_class: string;
	accentClass: string;
};

const m = ENTITY_ICONS.module;
const slate = {
	iconWrapperClass: 'border-feature-slate-border bg-feature-slate-bg text-feature-slate-text',
	icon_class: 'text-feature-slate-text',
	accentClass: 'bg-feature-slate-bg text-feature-slate-text ring-feature-slate-border'
};

/** Each feature's icon and Tailwind classes for its icon tile (`iconWrapperClass`), bare icon and accent chip. */
export const FEATURE_COLORS: { readonly [K in FeatureColorKey]: FeatureColorStyles } = {
	accessControl: {
		icon: m.accessControl,
		iconWrapperClass: 'border-feature-blue-border bg-feature-blue-bg text-feature-blue-text',
		icon_class: 'text-feature-blue-text',
		accentClass: 'bg-feature-blue-bg text-feature-blue-text ring-feature-blue-border'
	},
	agents: {
		icon: m.agents,
		iconWrapperClass: 'border-brand/25 bg-brand/15 text-brand',
		icon_class: 'text-brand',
		accentClass: 'bg-brand/15 text-brand ring-brand/25'
	},
	applications: { icon: m.applications, ...slate },
	customApps: { icon: m.customApps, ...slate },
	approvals: {
		icon: m.approvals,
		iconWrapperClass: 'border-feature-amber-border bg-feature-amber-bg text-feature-amber-text',
		icon_class: 'text-feature-amber-text',
		accentClass: 'bg-feature-amber-bg text-feature-amber-text ring-feature-amber-border'
	},
	automations: {
		icon: m.automations,
		iconWrapperClass: 'border-feature-violet-border bg-feature-violet-bg text-feature-violet-text',
		icon_class: 'text-feature-violet-text',
		accentClass: 'bg-feature-violet-bg text-feature-violet-text ring-feature-violet-border'
	},
	workspaceStudio: {
		icon: m.workspaceStudio,
		iconWrapperClass: 'border-feature-sky-border bg-feature-sky-bg text-feature-sky-text',
		icon_class: 'text-feature-sky-text',
		accentClass: 'bg-feature-sky-bg text-feature-sky-text ring-feature-sky-border'
	},
	builtIn: {
		icon: m.builtin,
		iconWrapperClass: 'border-feature-cyan-border bg-feature-cyan-bg text-feature-cyan-text',
		icon_class: 'text-feature-cyan-text',
		accentClass: 'bg-feature-cyan-bg text-feature-cyan-text ring-feature-cyan-border'
	},
	moduleStudio: {
		icon: m.moduleStudio,
		iconWrapperClass: 'border-feature-red-border bg-feature-red-bg text-feature-red-text',
		icon_class: 'text-feature-red-text',
		accentClass: 'bg-feature-red-bg text-feature-red-text ring-feature-red-border'
	},
	permissions: {
		icon: m.permissions,
		iconWrapperClass: 'border-feature-teal-border bg-feature-teal-bg text-feature-teal-text',
		icon_class: 'text-feature-teal-text',
		accentClass: 'bg-feature-teal-bg text-feature-teal-text ring-feature-teal-border'
	},
	dataBrowser: {
		icon: m.dataBrowser,
		iconWrapperClass: 'border-feature-indigo-border bg-feature-indigo-bg text-feature-indigo-text',
		icon_class: 'text-feature-indigo-text',
		accentClass: 'bg-feature-indigo-bg text-feature-indigo-text ring-feature-indigo-border'
	},
	tasks: {
		icon: m.tasks,
		iconWrapperClass: 'border-feature-emerald-border bg-feature-emerald-bg text-feature-emerald-text',
		icon_class: 'text-feature-emerald-text',
		accentClass: 'bg-feature-emerald-bg text-feature-emerald-text ring-feature-emerald-border'
	}
};
