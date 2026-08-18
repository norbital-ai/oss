export type AiModelOption = {
	readonly id: string;
	readonly label: string;
	readonly contextLength?: number;
	/**
	 * The model family this option belongs to — `anthropic/claude-opus-4` for every dated or
	 * suffixed variant of it. The picker groups by family so a provider offering eight snapshots of
	 * one model shows as one entry rather than eight.
	 */
	readonly canonicalSlug?: string;
};

export type AiModelCatalog = {
	readonly defaultModel: string;
	readonly options: readonly AiModelOption[];
};
