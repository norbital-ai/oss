export type NeonBranchRow = {
	id: string;
	name: string;
	parent_id: string | null;
};

export function resolveBranchByNames(
	branches: NeonBranchRow[],
	names: readonly string[]
): NeonBranchRow | null {
	for (const name of names) {
		const match = branches.find((branch) => branch.name === name);
		if (match) return match;
	}
	return null;
}

/** Local dev + e2e fork parent — prefer the long-lived `dev` branch over prod `main`. */
export function resolveSystemDevBranch(branches: NeonBranchRow[]): NeonBranchRow {
	const dev = resolveBranchByNames(branches, ['dev']);
	if (dev) return dev;

	const fallback = resolveBranchByNames(branches, ['main', 'production']);
	if (fallback) return fallback;

	const root = branches.find((branch) => branch.parent_id == null);
	if (root) return root;

	throw new Error('Unable to resolve system dev branch');
}
