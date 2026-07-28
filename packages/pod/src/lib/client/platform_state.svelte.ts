import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
import {
	AccessControlService,
	type AccessControlServiceOptions
} from '$lib/client/subservices/access_control.service.js';
import type {
	TenantWorkspacePolicyGrant,
	TenantWorkspaceShellData
} from '$lib/client/workspace_shell_types.js';
import type { TScopeRequestor } from '$lib/client/types.js';
import { createContext } from 'svelte';

type WorkspaceOrganization = TenantWorkspaceShellData['organization'];

const [getSvelteSurfaceStateContext, setSvelteSurfaceStateContext] =
	createContext<() => PlatformState>();

export function getPlatformStateContext(): () => PlatformState {
	return getSvelteSurfaceStateContext();
}

export function setPlatformStateContext(context: () => PlatformState): void {
	setSvelteSurfaceStateContext(context);
}

export type PlatformStateParams = {
	getManifestContext: () => ManifestContext;
	getUser: () => TScopeRequestor;
	getOrganization: () => WorkspaceOrganization;
	getPolicyGrants?: () => readonly TenantWorkspacePolicyGrant[] | null | undefined;
	accessControlOptions?: AccessControlServiceOptions;
};

/** Manifest + requestor scope shared by Core host shell and inline tenant apps. */
export class PlatformState {
	#getManifestContext!: () => ManifestContext;
	#getUser!: () => TScopeRequestor;
	#getOrganization!: () => WorkspaceOrganization;
	#getPolicyGrants!: () => readonly TenantWorkspacePolicyGrant[] | null | undefined;

	manifestContext = $derived.by(() => this.#getManifestContext());
	user = $derived.by(() => this.#getUser());
	organizationData = $derived.by(() => this.#getOrganization());
	organization = $derived.by(() => this.organizationData.name);
	policyGrants = $derived(this.#getPolicyGrants() ?? null);
	readonly access_control: AccessControlService;

	constructor(params: PlatformStateParams) {
		this.#getManifestContext = params.getManifestContext;
		this.#getUser = params.getUser;
		this.#getOrganization = params.getOrganization;
		this.#getPolicyGrants = params.getPolicyGrants ?? (() => null);
		this.access_control = new AccessControlService(() => this.user, params.accessControlOptions);
	}

	destroy(): void {
		this.access_control.destroy();
	}
}
