import type {
	CollectionSurface,
	CollectionSurfaceRegistry
} from '@norbital-ai/ui/collection-runtime';
import AutomationRunRepresentation from './automation-run-representation.svelte';
import UserRepresentation from './user-representation.svelte';

const representation = (component: unknown): NonNullable<CollectionSurface['representation']> =>
	component as NonNullable<CollectionSurface['representation']>; // stupidity: boundary-cast — concrete Svelte record props are supplied by CollectionRecordDetail after the registry erases the collection row generic.

/** Framework-owned record views for public system collections and host projections. */
export const SYSTEM_COLLECTION_SURFACES = {
	automation_run: { representation: representation(AutomationRunRepresentation) },
	user: { representation: representation(UserRepresentation) },
	workspace_members: { representation: representation(UserRepresentation) }
} as const satisfies CollectionSurfaceRegistry;
