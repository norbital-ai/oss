import type { CollectionField } from '@norbital-ai/ui/data-renderer';
import type { CollectionClient } from '@norbital-ai/std/collection';
import type { CollectionRegistryFor, PlatformSchema } from '#lib/authoring/internals.js';
import type { SystemClientApi } from '#lib/client/workspace-api.js';
import type { ErasedAutomationClientApi } from '#lib/client/automation-client.svelte.js';

type ErasedRecord = Readonly<Record<string, unknown>>;
type ErasedCollections = Readonly<
	Record<string, { readonly row: ErasedRecord; readonly mutation: ErasedRecord }>
>;
type PlatformCollections = CollectionRegistryFor<PlatformSchema>;
type WorkspaceCollections = ErasedCollections & PlatformCollections;
type WorkspaceReads = CollectionClient<WorkspaceCollections>;

export type AutomationRunsClient = Readonly<{
	readonly automations: ErasedAutomationClientApi;
	readonly db: Pick<WorkspaceReads['db'], 'automation_run'>;
}>;

export type WorkspaceClient = Omit<WorkspaceReads, 'db' | 'collections'> &
	AutomationRunsClient & {
		readonly db: WorkspaceReads['db'] & {
			readonly bolt_notifications: Omit<
				WorkspaceReads['db']['bolt_notifications'],
				'mutate' | 'pending'
			> & {
				readonly mutate: WorkspaceReads['db']['bolt_notifications']['mutate'];
				readonly pending: number;
			};
		};
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
