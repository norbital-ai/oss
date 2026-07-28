export interface NeonBranchConfig {
	projectId: string;
	branchId: string;
	connectionString: string;
}

export interface BranchOptions {
	name?: string;
	expiresAt?: Date;
}

export interface RestorePointTimestamp {
	timestamp: string;
}

export interface RestorePointLsn {
	lsn: string;
}

export interface TenantDbProvider {
	createOrgProject(
		orgId: string,
		orgName: string
	): Promise<{ projectId: string; mainBranch: NeonBranchConfig }>;
	deleteOrgProject(projectId: string): Promise<void>;
	/** Reset cleanup — list Neon projects whose name exactly matches `name`. */
	listProjectsByName(name: string): Promise<Array<{ id: string; name: string }>>;
	/** Environment reset — reuse an existing org project when present instead of creating a new one. */
	resolveExistingOrgProject(
		orgName: string
	): Promise<{ projectId: string; mainBranch: NeonBranchConfig } | null>;

	createBranch(
		projectId: string,
		parentBranchId: string,
		options?: BranchOptions
	): Promise<NeonBranchConfig>;
	deleteBranch(projectId: string, branchId: string): Promise<void>;
	resetBranchFromParent(projectId: string, branchId: string): Promise<void>;

	restoreBranch(
		projectId: string,
		branchId: string,
		point: RestorePointTimestamp | RestorePointLsn,
		preserveName?: string
	): Promise<{ backupBranchId: string }>;

	provisionOrgZones(
		orgId: string,
		orgName: string
	): Promise<{
		projectId: string;
		live: NeonBranchConfig;
	}>;

	ensureDevBranch(
		projectId: string,
		previewBranchId: string,
		containerId: string
	): Promise<NeonBranchConfig>;
}
