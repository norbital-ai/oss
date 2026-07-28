import type {
	CollectionClient,
	ErasedCollectionRegistry
} from '@norbital-ai/platform-utils/collection';
import { getContext, hasContext, setContext, type Component } from 'svelte';

const COLLECTION_CLIENT_CONTEXT = Symbol.for('@norbital-ai/ui/collection-client');
const COLLECTION_SURFACE_CONTEXT = Symbol.for('@norbital-ai/ui/collection-surface');

type CollectionClientGetter = () => CollectionClient<ErasedCollectionRegistry>;

export type CollectionRepresentationSurface = Component;

export interface CollectionSurface {
	readonly representation?: CollectionRepresentationSurface;
}

export type CollectionSurfaceRegistry = Readonly<Record<string, CollectionSurface>>;

export interface CollectionSurfaceRuntime {
	readonly appId: () => string;
	readonly surfaces: CollectionSurfaceRegistry;
	claimView(view: string): () => void;
}

export function getCollectionClientContext(): CollectionClient<ErasedCollectionRegistry> {
	const client = getOptionalCollectionClientContext();
	if (!client) throw new Error('Collection client context is unavailable.');
	return client;
}

export function getOptionalCollectionClientContext():
	| CollectionClient<ErasedCollectionRegistry>
	| undefined {
	return hasContext(COLLECTION_CLIENT_CONTEXT)
		? getContext<CollectionClientGetter>(COLLECTION_CLIENT_CONTEXT)()
		: undefined;
}

export function resolveCollectionClient(
	candidate: object
): CollectionClient<ErasedCollectionRegistry> | undefined {
	const collections = Reflect.get(candidate, 'collections');
	const records = Reflect.get(candidate, 'records');
	if (collections == null || typeof collections !== 'object') return undefined;
	if (records == null || typeof records !== 'object') return undefined;
	return candidate as CollectionClient<ErasedCollectionRegistry>; // stupidity: boundary-cast — collection surfaces consume the platform client capability after its runtime shape is verified.
}

export function getCollectionClientForSurface(
	candidate: object,
	surfaceName: string
): CollectionClient<ErasedCollectionRegistry> {
	const client = resolveCollectionClient(candidate) ?? getOptionalCollectionClientContext();
	if (!client) throw new Error(`${surfaceName} requires a collection client.`);
	return client;
}

export function setCollectionClientContext(
	context: () => CollectionClient<ErasedCollectionRegistry>
): void {
	setContext(COLLECTION_CLIENT_CONTEXT, context);
}

export function resolveCollectionSurface(
	registry: CollectionSurfaceRegistry | undefined,
	collectionName: string
): CollectionSurface | undefined {
	return registry?.[collectionName];
}

export function setCollectionSurfaceRuntime(runtime: CollectionSurfaceRuntime): void {
	setContext(COLLECTION_SURFACE_CONTEXT, runtime);
}

export function getCollectionSurfaceRuntime(): CollectionSurfaceRuntime | undefined {
	return getContext<CollectionSurfaceRuntime>(COLLECTION_SURFACE_CONTEXT);
}
