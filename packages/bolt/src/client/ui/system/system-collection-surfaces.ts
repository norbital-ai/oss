import type {
	CollectionRepresentationComponent,
	CollectionSurfaceRegistry
} from '@norbital-ai/ui/collection-runtime';
import AutomationRunRepresentation from './automation-run-representation.svelte';
import UserRepresentation from './user-representation.svelte';

export const SYSTEM_COLLECTION_SURFACES: CollectionSurfaceRegistry = {
	automation_run: {
		representation: AutomationRunRepresentation as CollectionRepresentationComponent
	},
	user: { representation: UserRepresentation as CollectionRepresentationComponent },
	workspace_members: { representation: UserRepresentation as CollectionRepresentationComponent }
};
