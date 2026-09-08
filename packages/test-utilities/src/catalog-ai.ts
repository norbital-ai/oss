import { makeAiBinding } from '@norbital-ai/bolt-server';

/**
 * The window every test model claims: large enough that no suite compacts by accident.
 *
 * Compaction is driven by the model's own context window, so a fixture that understated it would
 * make unrelated suites checkpoint halfway through and assert against a transcript nobody wrote.
 * A suite that wants to *test* compaction states a small window of its own.
 */
export const TEST_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Catalog payload both `catalogAi` and `recordedAi` answer Catalog with. */
export const testAiCatalog = {
	_tag: 'Catalog' as const,
	languageModels: [{ id: 'test/language', contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS }],
	defaultLanguageModelId: 'test/language',
	embeddingModels: [{ id: 'test/embedding', contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS }],
	defaultEmbeddingModelId: 'test/embedding'
};

/**
 * Catalog-only test double via `makeAiBinding`. Not a vendor and not the only legal AI binding —
 * any `AiProvider` the host supplies is valid.
 */
export const catalogAi = () =>
	makeAiBinding({
		call: async () => testAiCatalog
	});
