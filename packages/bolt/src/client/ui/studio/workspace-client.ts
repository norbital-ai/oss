import type { CollectionField } from '@norbital-ai/ui/data-renderer';
import type { CollectionClient } from '@norbital-ai/std/collection';
import type { CollectionRegistryFor, PlatformSchema } from '#lib/authoring/internals.js';
import type { SystemClientApi } from '#lib/client/workspace-api.js';
import type { ErasedAutomationClientApi } from '#lib/client/automation-client.svelte.js';

type ErasedRecord = { readonly [field: string]: unknown };
type ErasedCollections = Readonly<
	Record<
		string,
		{ readonly row: ErasedRecord; readonly create: ErasedRecord; readonly update: ErasedRecord }
	>
>;
/**
 * The platform tables' rows, with erased write inputs: the shell writes one platform collection
 * (`bolt_notifications`) and its input is a system-owned shape no authored contract declares.
 */
type PlatformCollections = {
	readonly [N in keyof CollectionRegistryFor<PlatformSchema>]: {
		readonly row: CollectionRegistryFor<PlatformSchema>[N]['row'];
		readonly create: ErasedRecord;
		readonly update: ErasedRecord;
		readonly scalarColumns: CollectionRegistryFor<PlatformSchema>[N]['scalarColumns'];
	};
};
type WorkspaceCollections = ErasedCollections & PlatformCollections;
type WorkspaceReads = CollectionClient<WorkspaceCollections>;

export type AutomationRunsClient = Readonly<{
	readonly automations: ErasedAutomationClientApi;
	readonly db: Pick<WorkspaceReads['db'], 'automation_run'>;
	readonly collection: Pick<WorkspaceReads['collection'], 'automation_run'>;
}>;

export type WorkspaceClient = Omit<WorkspaceReads, 'collections'> &
	AutomationRunsClient & {
		readonly system: SystemClientApi;
		readonly collections: Readonly<
			Record<
				string,
				{
					readonly name: string;
					readonly recordLabel?: string;
					readonly fields: ReadonlyArray<CollectionField>;
					readonly relationships?: ReadonlyArray<{
						readonly name: string;
						readonly target: string;
						readonly cardinality: 'one' | 'many';
					}>;
				}
			>
		>;
	};
