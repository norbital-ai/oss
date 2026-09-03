import { makeAiBinding } from '@norbital-ai/bolt-server';

/** Catalog payload both `catalogAi` and `recordedAi` answer Catalog with. */
export const testAiCatalog = {
	_tag: 'Catalog' as const,
	languageModels: [{ id: 'test/language' }],
	defaultLanguageModelId: 'test/language',
	embeddingModels: [{ id: 'test/embedding' }],
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
