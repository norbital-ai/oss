/** Picks the conversation agent from the workspace definition instead of a hardcoded name. */
export const resolveWorkspaceAgentName = (
	agents: ReadonlyArray<string>,
	selected?: string
): string | undefined => {
	if (selected !== undefined && selected.length > 0 && agents.includes(selected)) return selected;
	return agents.find((name) => name.length > 0);
};
