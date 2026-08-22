import { ENTITY_ICONS } from '#lib/icon-wrapper/entity-icons';
import { Schema } from 'effect';

export const FeatureColorKeySchema = Schema.Literals([
	'accessControl',
	'agents',
	'applications',
	'approvals',
	'automations',
	'workspaceStudio',
	'builtIn',
	'customApps',
	'moduleStudio',
	'permissions',
	'dataBrowser',
	'tasks'
]);
export type FeatureColorKey = typeof FeatureColorKeySchema.Type;

export const FeatureColorStylesSchema = Schema.Struct({
	icon: Schema.String,
	navIcon: Schema.String,
	iconWrapperClass: Schema.String,
	iconClass: Schema.String,
	accentClass: Schema.String
});
export type FeatureColorStyles = typeof FeatureColorStylesSchema.Type;

const m = ENTITY_ICONS.module;

export const FEATURE_COLOR_STYLES: Record<FeatureColorKey, FeatureColorStyles> = {
	accessControl: {
		icon: m.accessControl,
		navIcon: m.accessControl,
		iconWrapperClass:
			'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/12 dark:text-blue-200',
		iconClass: 'text-blue-700 dark:text-blue-200',
		accentClass:
			'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-400/12 dark:text-blue-200 dark:ring-blue-400/25'
	},
	agents: {
		icon: m.agents,
		navIcon: m.agents,
		iconWrapperClass: 'border-brand/25 bg-brand/15 text-brand',
		iconClass: 'text-brand',
		accentClass: 'bg-brand/15 text-brand ring-brand/25'
	},
	applications: {
		icon: m.applications,
		navIcon: m.applications,
		iconWrapperClass:
			'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-400/20 dark:bg-slate-400/10 dark:text-slate-200',
		iconClass: 'text-slate-700 dark:text-slate-200',
		accentClass:
			'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-400/10 dark:text-slate-200 dark:ring-slate-400/20'
	},
	approvals: {
		icon: m.approvals,
		navIcon: m.approvals,
		iconWrapperClass:
			'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/12 dark:text-amber-200',
		iconClass: 'text-amber-700 dark:text-amber-200',
		accentClass:
			'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/12 dark:text-amber-200 dark:ring-amber-400/25'
	},
	automations: {
		icon: m.automations,
		navIcon: m.automations,
		iconWrapperClass:
			'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/12 dark:text-violet-200',
		iconClass: 'text-violet-700 dark:text-violet-200',
		accentClass:
			'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-400/12 dark:text-violet-200 dark:ring-violet-400/25'
	},
	customApps: {
		icon: m.customApps,
		navIcon: m.customApps,
		iconWrapperClass:
			'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-400/20 dark:bg-slate-400/10 dark:text-slate-200',
		iconClass: 'text-slate-700 dark:text-slate-200',
		accentClass:
			'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-400/10 dark:text-slate-200 dark:ring-slate-400/20'
	},
	workspaceStudio: {
		icon: m.workspaceStudio,
		navIcon: m.workspaceStudio,
		iconWrapperClass:
			'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/12 dark:text-sky-200',
		iconClass: 'text-sky-700 dark:text-sky-200',
		accentClass:
			'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-400/12 dark:text-sky-200 dark:ring-sky-400/25'
	},
	builtIn: {
		icon: m.builtin,
		navIcon: m.builtin,
		iconWrapperClass:
			'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-400/12 dark:text-cyan-200',
		iconClass: 'text-cyan-700 dark:text-cyan-200',
		accentClass:
			'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-400/12 dark:text-cyan-200 dark:ring-cyan-400/25'
	},
	moduleStudio: {
		icon: m.moduleStudio,
		navIcon: m.moduleStudio,
		iconWrapperClass:
			'border-red-200 bg-red-50 text-red-700 dark:border-red-400/25 dark:bg-red-400/12 dark:text-red-200',
		iconClass: 'text-red-700 dark:text-red-200',
		accentClass:
			'bg-red-50 text-red-700 ring-red-200 dark:bg-red-400/12 dark:text-red-200 dark:ring-red-400/25'
	},
	permissions: {
		icon: m.permissions,
		navIcon: m.permissions,
		iconWrapperClass:
			'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-400/25 dark:bg-teal-400/12 dark:text-teal-200',
		iconClass: 'text-teal-700 dark:text-teal-200',
		accentClass:
			'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-400/12 dark:text-teal-200 dark:ring-teal-400/25'
	},
	dataBrowser: {
		icon: m.dataBrowser,
		navIcon: m.dataBrowser,
		iconWrapperClass:
			'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-400/12 dark:text-indigo-200',
		iconClass: 'text-indigo-700 dark:text-indigo-200',
		accentClass:
			'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-400/12 dark:text-indigo-200 dark:ring-indigo-400/25'
	},
	tasks: {
		icon: m.tasks,
		navIcon: m.tasks,
		iconWrapperClass:
			'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/12 dark:text-emerald-200',
		iconClass: 'text-emerald-700 dark:text-emerald-200',
		accentClass:
			'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/12 dark:text-emerald-200 dark:ring-emerald-400/25'
	}
};
