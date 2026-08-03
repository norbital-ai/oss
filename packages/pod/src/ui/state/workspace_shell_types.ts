import type { NorbitalManifest } from '$lib/manifest';
import type { UserOrganizationInfo } from '$lib/server/bootstrap/workspace_store.js';
import type { TBaseScope, TScopeRequestor } from '$lib/ui/state/types.js';
import type { CollectionColumnMap } from '@norbital-ai/platform-utils/manifest/context';
import type { WorkspaceBillingSummary } from '@norbital-ai/platform-utils/runtime/binding';

export type TenantWorkspacePolicyGrant = {
	readonly id: string;
	readonly policy_id: string;
	readonly team_id: string;
	readonly collection_name: string;
	readonly action: 'create' | 'read' | 'update' | 'delete';
	readonly conditions: Record<string, unknown>;
	readonly approval_config: Record<string, unknown> | null;
};

export type TenantWorkspaceShellData = {
	readonly user: TScopeRequestor;
	readonly organization: {
		readonly id: string;
		readonly name: string;
		readonly logo_url: string | null;
	};
	readonly initialWorkspaceLatest: {
		readonly nodeId: string;
		readonly manifest: NorbitalManifest;
		readonly columns: Readonly<Record<string, CollectionColumnMap>>;
	};
	/**
	 * Everything the local replica needs to open, delivered with the shell rather than fetched
	 * separately.
	 *
	 * The replica used to cost a second serialized round trip (`GET /_runtime/sync/schema`) before
	 * PGlite could even be opened, because the data directory name came back in that response's
	 * headers. Both responses are resolved from the same workspace context, so there was never a
	 * reason for two — and while the second one was in flight the app had already rendered and sent
	 * its first reads to the server.
	 *
	 * `replicaStamp` is `<organizationId>:<userId>`. It names the local database, which is what
	 * keeps one tenant's rows out of another's. An organization switch asks Core for a new document;
	 * the selected tenant then boots against its own stamp and replica.
	 */
	readonly sync: {
		readonly schemaSql: string;
		readonly replicaStamp: string;
		readonly replicaEpoch: string;
	};
	readonly baseScope?: TBaseScope;
	readonly userOrganizations?: readonly UserOrganizationInfo[];
	readonly billing?: WorkspaceBillingSummary;
	/**
	 * App names the requestor may open. `null` means unrestricted admin access.
	 * Resolved from policies assigned to the requestor's teams.
	 */
	readonly accessibleAppNames: string[] | null;
	/**
	 * Raw policy grants for the requestor's teams. `null` means unrestricted admin access.
	 */
	readonly policyGrants: readonly TenantWorkspacePolicyGrant[] | null;
	/**
	 * Host-owned navigation surfaces (Workspace Studio, transport credentials, billing, and so on), already filtered to what
	 * this requestor may see. Empty under a host that supplies none, which is every workspace running
	 * on `pod start` by default.
	 */
	readonly hostPlugins: readonly TenantWorkspaceHostPlugin[];
};

/** The client-visible projection of a `HostAppPlugin`; `adminOnly` is resolved server-side. */
export type TenantWorkspaceHostPlugin = {
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	readonly entry: string;
	readonly placement: 'sidebar' | 'settings';
};
