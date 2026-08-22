import type { IFileUploadClient } from '#lib/file-upload';
import type { StaticMapImage, StaticMapRequest } from '#lib/static-map/static-map.types';
import type { TGeolocationPickerValue } from '#lib/data-renderer/geolocation/geolocation.utils';
import { getContext, setContext, type Component } from 'svelte';
import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
import type { Effect } from 'effect';

export type CustomTypeRendererMap = Readonly<Record<string, Component<DataRendererProps>>>;

export interface DataRendererRuntime {
	autocompleteGeolocation(query: string): Effect.Effect<TGeolocationPickerValue[], unknown>;
	createFileUploadClient(): IFileUploadClient;
	renderStaticMap(input: StaticMapRequest): Effect.Effect<StaticMapImage, unknown>;
	readonly customTypeRenderers: CustomTypeRendererMap;
}

const DATA_RENDERER_RUNTIME = Symbol.for('@norbital-ai/ui/data-renderer-runtime');

export function getDataRendererRuntimeContext(): DataRendererRuntime | undefined {
	return getContext<DataRendererRuntime | undefined>(DATA_RENDERER_RUNTIME);
}

export function setDataRendererRuntimeContext(runtime: DataRendererRuntime): void {
	setContext(DATA_RENDERER_RUNTIME, runtime);
}
