import type { NorbitalManifest } from '$lib/manifest';
import type { AppPlugin, HostPluginRegistry } from '$lib/client/plugin/contract.js';
import type { UserOrganizationInfo } from '$lib/server/bootstrap/workspace_store.js';
import type { TBaseScope, TScopeRequestor } from '$lib/client/types.js';
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
	readonly baseScope?: TBaseScope;
	readonly hostPlugins?: HostPluginRegistry;
	readonly sidebarPlugins?: readonly AppPlugin[];
	readonly userOrganizations?: readonly UserOrganizationInfo[];
	readonly billing?: WorkspaceBillingSummary;
	readonly signOut?: () => Promise<void>;
	/**
	 * App names the requestor may open. `null` means unrestricted admin access.
	 * Resolved from policies assigned to the requestor's teams.
	 */
	readonly accessibleAppNames: string[] | null;
	/**
	 * Raw policy grants for the requestor's teams. `null` means unrestricted admin access.
	 */
	readonly policyGrants: readonly TenantWorkspacePolicyGrant[] | null;
};

export type TenantWorkspacePageData = Pick<
	TenantWorkspaceShellData,
	'user' | 'organization' | 'initialWorkspaceLatest' | 'accessibleAppNames' | 'policyGrants'
> &
	Partial<
		Pick<
			TenantWorkspaceShellData,
			'baseScope' | 'hostPlugins' | 'sidebarPlugins' | 'userOrganizations'
		>
	>;
