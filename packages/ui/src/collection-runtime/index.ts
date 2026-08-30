import type {
	CollectionClient,
	CollectionRegistry,
	ErasedCollectionRegistry
} from '@norbital-ai/std/collection';
import { getContext, hasContext, setContext, type Component } from 'svelte';
export { setRelationshipDirectoryContext } from './relationship-directory.js';

const COLLECTION_CLIENT_CONTEXT = Symbol.for('@norbital-ai/ui/collection-client');
const COLLECTION_SURFACE_CONTEXT = Symbol.for('@norbital-ai/ui/collection-surface');
const COLLECTION_RECORD_SCOPE_CONTEXT = Symbol.for('@norbital-ai/ui/collection-record-scope');

export type CollectionClientGetter = () => CollectionClient<ErasedCollectionRegistry>;

/** The registry erases each representation's generated row type at its shared UI boundary. */
export type CollectionRepresentationComponent = Component;

export interface CollectionSurface {
	readonly representation?: CollectionRepresentationComponent;
	/** Static `bolt:banner` URL declared on the collection's `+representation.svelte`, if any. */
	readonly banner?: string | null;
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
	CollectionClient<ErasedCollectionRegistry> | undefined {
	return getOptionalCollectionClientGetter()?.();
}

/**
 * Captures the context capability without freezing the client it currently resolves.
 *
 * Host projections can replace their in-memory client when asynchronously loaded rows arrive. A
 * record detail therefore keeps this getter and reads it inside derived state, while ordinary
 * callers retain `getOptionalCollectionClientContext()` as the one-shot convenience.
 */
export function getOptionalCollectionClientGetter(): CollectionClientGetter | undefined {
	return hasContext(COLLECTION_CLIENT_CONTEXT)
		? getContext<CollectionClientGetter>(COLLECTION_CLIENT_CONTEXT)
		: undefined;
}

function isCollectionClient<TCollections extends CollectionRegistry>(
	candidate: object
): candidate is CollectionClient<TCollections> {
	const db = Reflect.get(candidate, 'db');
	const collections = Reflect.get(candidate, 'collections');
	const records = Reflect.get(candidate, 'records');
	return (
		db !== null &&
		typeof db === 'object' &&
		collections !== null &&
		typeof collections === 'object' &&
		records !== null &&
		typeof records === 'object' &&
		typeof Reflect.get(records, 'findMany') === 'function'
	);
}

export function resolveCollectionClient<
	TCollections extends CollectionRegistry = ErasedCollectionRegistry
>(candidate: object): CollectionClient<TCollections> | undefined {
	return isCollectionClient<TCollections>(candidate) ? candidate : undefined;
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

/**
 * The record a detail surface is currently mounted for, as a view-persistence scope segment.
 *
 * A table nested inside a `+representation.svelte` shows one record's children, so its saved
 * columns/filters/sort must be keyed per parent record — otherwise every employee shares one
 * "employments" view. Authored source used to build that key by interpolating the parent's
 * `id`, which is exactly the system column authored code must not reach into. The
 * surface that mounts the representation already knows the id, so it publishes it here and
 * `view` stays a readable, stable name the author chose.
 *
 * A getter rather than a value: the mounting surface's active record is reactive state, and the
 * scope has to follow it without the consumer re-reading context.
 */
export function setCollectionRecordScope(scope: () => string | undefined): void {
	setContext(COLLECTION_RECORD_SCOPE_CONTEXT, scope);
}

export function getCollectionRecordScope(): (() => string | undefined) | undefined {
	return hasContext(COLLECTION_RECORD_SCOPE_CONTEXT)
		? getContext<() => string | undefined>(COLLECTION_RECORD_SCOPE_CONTEXT)
		: undefined;
}

/**
 * The persistence key a collection surface saves its view state under.
 *
 * Composed rather than concatenated at each call site so the table and the board agree on the
 * shape, and so a nested surface inside a record detail cannot accidentally share the outer key.
 */
export function resolveCollectionViewKey(
	view: string | undefined,
	fallback: string,
	recordScope: string | undefined
): string {
	const base = view ?? fallback;
	return recordScope === undefined || recordScope === '' ? base : `${base}:${recordScope}`;
}
