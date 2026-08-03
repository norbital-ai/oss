/**
 * One model the host offers for a turn.
 *
 * Structurally the Core-era `AgentModelOption`, restated here because Pod is the side that renders
 * the picker. Deliberately no list of ids alongside it: the catalog and the default are the host's,
 * reached through `agentModels`. A copy kept in this package would be a second answer to "what is
 * about to run", and Core's own baked list is the argument against one — it still names GPT-4o and
 * Claude Sonnet 4 as the frontier a year after they stopped being it.
 */
export type AgentModelOption = {
	readonly id: string;
	readonly label: string;
	readonly canonicalSlug: string;
};

export type AgentModelCatalog = {
	readonly defaultModel: string;
	readonly options: readonly AgentModelOption[];
};
