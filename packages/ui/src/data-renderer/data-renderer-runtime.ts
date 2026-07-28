import type { IFileUploadClient } from '#lib/file-upload';
import type { StaticMapImage, StaticMapRequest } from '../static-map/static-map.types.js';
import type { TGeolocationPickerValue } from './geolocation/geolocation.utils.js';
import { getContext, setContext, type Component } from 'svelte';
import type { DataRendererProps } from './data-renderer.types.js';

export type CustomTypeRendererMap = Readonly<Record<string, Component<DataRendererProps>>>;

export interface DataRendererRuntime {
	autocompleteGeolocation(query: string): Promise<TGeolocationPickerValue[]>;
	createFileUploadClient(): IFileUploadClient;
	renderStaticMap(input: StaticMapRequest): Promise<StaticMapImage>;
	readonly customTypeRenderers: CustomTypeRendererMap;
}

const DATA_RENDERER_RUNTIME = Symbol.for('@norbital-ai/ui/data-renderer-runtime');

export function getDataRendererRuntimeContext(): DataRendererRuntime | undefined {
	return getContext<DataRendererRuntime | undefined>(DATA_RENDERER_RUNTIME);
}

export function setDataRendererRuntimeContext(runtime: DataRendererRuntime): void {
	setContext(DATA_RENDERER_RUNTIME, runtime);
}
