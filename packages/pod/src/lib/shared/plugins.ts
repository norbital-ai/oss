import { z } from 'zod';

/** Named mount points inside tenant app chrome (overlays, topbar, collection actions). */
export type SlotPlacement = 'app.topbar' | 'collection.actions' | 'app.overlay';

/** Sidebar entries are framework-owned routes backed by host plugin components. */
export type AppPluginPlacement = 'sidebar' | SlotPlacement;

export type PluginCapability = string;

/**
 * Host-injected UI plugin. For `sidebar` placement, `entry` is a host page URL embedded via
 * iframe. For slot placements, `entry` is an ESM URL whose default export is a Svelte component.
 */
export type AppPlugin = {
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly route: string;
	readonly entry: string;
	readonly placement: AppPluginPlacement;
	readonly requiredCapability?: PluginCapability;
};

/** Default sidebar plugin keys rendered as tenant-owned routes. */
export const DEFAULT_SIDEBAR_APP_PLUGIN_KEYS = {
	agent: 'agent',
	workspaceStudio: 'workspace-studio'
} as const;

export type HostPluginRegistry = {
	readonly apps?: readonly AppPlugin[];
	readonly opsAccess?: boolean;
};

export const AppPluginSchema = z.object({
	key: z.string(),
	label: z.string(),
	icon: z.string().nullable(),
	route: z.string(),
	entry: z.string(),
	placement: z.enum(['sidebar', 'app.topbar', 'collection.actions', 'app.overlay']),
	requiredCapability: z.string().optional()
}) satisfies z.ZodType<AppPlugin>;

export const HostPluginRegistrySchema = z.object({
	apps: z.array(AppPluginSchema).optional(),
	opsAccess: z.boolean().optional()
}) satisfies z.ZodType<HostPluginRegistry>;

export function parseHostPluginRegistry(raw: string): HostPluginRegistry | undefined {
	try {
		const parsed = HostPluginRegistrySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
