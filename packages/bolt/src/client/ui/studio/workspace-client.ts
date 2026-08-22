import type { CollectionField } from '@norbital-ai/ui/data-renderer';
import type { CollectionClient } from '@norbital-ai/std/collection';
import type { CollectionRegistryFor, PlatformSchema } from '#lib/authoring/internals.js';
import type { SystemClientApi } from '#lib/client/runtime.js';

/** A record of an unknown collection: this surface renders whichever workspace it was compiled into. */
type ErasedRecord = Readonly<Record<string, unknown>>;

/**
 * The collection registry, spelled out rather than imported.
 *
 * The equivalent erased registry is `ErasedCollectionRegistry` in `@norbital-ai/std/collection`, and
 * these surfaces depend only on the neutral client seam and the design system — Studio never reaches
 * into a workspace's own data layer. The shape is three members, so writing them out keeps that seam
 * whole.
 */
type ErasedCollections = Readonly<
	Record<
		string,
		{ readonly row: ErasedRecord; readonly create: ErasedRecord; readonly update: ErasedRecord }
	>
>;

/** Runtime-owned collections retain their generated row types even on the workspace shell seam. */
type WorkspaceCollections = ErasedCollections & CollectionRegistryFor<PlatformSchema>;

/**
 * The compiled workspace's own collection client.
 *
 * It is the only place a browser can learn what a column *is* — kind, nullability, whether the
 * database computes it, whether free-text search may reach it, which enum members it accepts.
 * `workspace.manifest` publishes none of that, so Studio reads both: the manifest for what this
 * subject may see, the catalog for what each column declares.
 *
 * It used to be declared against `virtual:colony-client`, a host-side Vite module that resolved a
 * workspace by tenant at the host's build time. There is no such module any more: this component
 * ships inside the tenant's own bundle, so the client it reads is that workspace's and no lookup can
 * pick the wrong one.
 */
export type WorkspaceClient = CollectionClient<WorkspaceCollections> & {
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
