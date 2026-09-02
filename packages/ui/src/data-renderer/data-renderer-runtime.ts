import type { IFileUploadClient } from '#lib/file-upload';
import type { StaticMapImage, StaticMapRequest } from '#lib/static-map/static-map.types';
import type { TGeolocationPickerValue } from '#lib/data-renderer/geolocation/geolocation.utils';
import { getContext, setContext, type Component } from 'svelte';
import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
import type { Effect } from 'effect';

export type CustomTypeRenderer = Component<DataRendererProps>;
export type CustomTypeRendererState =
	| Readonly<{ status: 'loading' }>
	| Readonly<{ status: 'ready'; renderer: CustomTypeRenderer }>
	| Readonly<{ status: 'failed'; error: Error }>;

export interface DataRendererRuntime<E = Error> {
	autocompleteGeolocation(query: string): Effect.Effect<TGeolocationPickerValue[], E>;
	createFileUploadClient(): IFileUploadClient;
	/** Resolves a persisted storage key through the host that mounted the workspace. */
	fileUrl(key: string): string;
	renderStaticMap(input: StaticMapRequest): Effect.Effect<StaticMapImage, E>;
	/** Resolve a tenant datatype without conflating loading, failure, and absence. */
	customTypeRenderer(kind: string): CustomTypeRendererState | undefined;
}

const DATA_RENDERER_RUNTIME = Symbol.for('@norbital-ai/ui/data-renderer-runtime');

export function getDataRendererRuntimeContext(): DataRendererRuntime | undefined {
	return getContext<DataRendererRuntime | undefined>(DATA_RENDERER_RUNTIME);
}

export function setDataRendererRuntimeContext(runtime: DataRendererRuntime): void {
	setContext(DATA_RENDERER_RUNTIME, runtime);
}
