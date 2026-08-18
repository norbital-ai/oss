/** Derives the workspace agent name from the package name so authored workspaces are not called `workspace`. */
export const workspaceAgentNameFromPackage = (packageName: string): string => {
	const segment = (packageName.split('/').at(-1) ?? packageName).trim().toLowerCase();
	const slug = segment.replaceAll(/[^a-z0-9_.-]+/g, '-').replaceAll(/^-+|-+$/g, '');
	return /^[a-z][a-z0-9_.-]*$/.test(slug) ? slug : 'workspace';
};
