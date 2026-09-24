import type { Effect } from 'effect';
import { getContext, setContext } from 'svelte';

/** One field the picker offers, described for a model: what a condition on it may say. */
export interface CollectionFilterInferenceField {
	readonly value: string;
	readonly label: string;
	readonly kind: string;
	readonly nullable: boolean;
	readonly array?: boolean;
	readonly values?: readonly string[];
	readonly target?: string;
	readonly operators: readonly string[];
}

/** One builder row, in or out of an inference. */
export interface CollectionFilterInferenceCondition {
	readonly field: string;
	readonly operator: string;
	readonly value?: unknown;
}

export interface CollectionFilterInferenceRequest {
	readonly collection: string;
	readonly text: string;
	readonly fields: readonly CollectionFilterInferenceField[];
	readonly current: readonly CollectionFilterInferenceCondition[];
}

export interface CollectionFilterInferenceAnswer {
	readonly conditions: readonly CollectionFilterInferenceCondition[];
	readonly unresolved: readonly string[];
}

/**
 * Turns a description into filter rows. Supplied by the host that mounted the collection; absent,
 * the builder offers no composer and stays the manual one it always was.
 */
export type CollectionFilterInfer = (
	request: CollectionFilterInferenceRequest,
	signal?: AbortSignal
) => Effect.Effect<CollectionFilterInferenceAnswer, Error>;

const COLLECTION_FILTER_INFERENCE = Symbol.for('@norbital-ai/ui/collection-filter-inference');

export function getCollectionFilterInference(): CollectionFilterInfer | undefined {
	return getContext<CollectionFilterInfer | undefined>(COLLECTION_FILTER_INFERENCE);
}

export function setCollectionFilterInference(infer: CollectionFilterInfer): void {
	setContext(COLLECTION_FILTER_INFERENCE, infer);
}
