import type {
	CollectionSurface,
	CollectionSurfaceRegistry
} from '@norbital-ai/ui/collection-runtime';
import AutomationRunRepresentation from './automation-run-representation.svelte';
import UserRepresentation from './user-representation.svelte';

const representation = (component: unknown): NonNullable<CollectionSurface['representation']> =>
	component as NonNullable<CollectionSurface['representation']>;

export const SYSTEM_COLLECTION_SURFACES = {
	automation_run: { representation: representation(AutomationRunRepresentation) },
	user: { representation: representation(UserRepresentation) },
	workspace_members: { representation: representation(UserRepresentation) }
} as const satisfies CollectionSurfaceRegistry;
