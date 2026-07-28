import type {
	CollectionExportPipeline,
	CollectionImportPipeline,
	TExportManifest
} from '$lib/authoring/automations/pipelines.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { BeforeApi } from '$lib/authoring/workspace/hook-api.js';

function integrationBinding(integrationName: string, bindingName: string) {
	const binding =
		getTenantWorkspace().registered.integrationBindings[`${integrationName}:${bindingName}`];
	if (!binding)
		throw new Error(`Integration binding not declared: ${integrationName}.${bindingName}`);
	return binding;
}

export async function runCollectionExportPipeline(params: {
	readonly collectionName: string;
	readonly context: CollectionExportPipeline['params'];
	readonly api: BeforeApi;
}): Promise<Awaited<CollectionExportPipeline['return']>> {
	const workspacePipelines = getTenantWorkspace().registered.pipelines?.[params.collectionName];
	const fn = workspacePipelines?.export as
		| ((
				ctx: CollectionExportPipeline['params'],
				capabilities: BeforeApi
		  ) => Promise<TExportManifest>)
		| undefined;
	if (!fn) {
		throw new Error(`Export pipeline not declared in workspace: ${params.collectionName}`);
	}
	return fn(params.context, params.api);
}

export async function runCollectionImportPipeline(params: {
	readonly collectionName: string;
	readonly context: CollectionImportPipeline['params'];
	readonly api: BeforeApi;
}): Promise<Awaited<CollectionImportPipeline['return']>> {
	const workspacePipelines = getTenantWorkspace().registered.pipelines?.[params.collectionName];
	const fn = workspacePipelines?.import as
		| ((
				ctx: CollectionImportPipeline['params'],
				capabilities: BeforeApi
		  ) => CollectionImportPipeline['return'])
		| undefined;
	if (!fn) {
		throw new Error(`Import pipeline not declared in workspace: ${params.collectionName}`);
	}
	return fn(params.context, params.api);
}

export async function runIntegrationReceivePipeline(params: {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly importData: unknown;
	readonly api: BeforeApi;
}): Promise<Awaited<CollectionImportPipeline['return']>> {
	const binding = integrationBinding(params.integrationName, params.bindingName);
	if (binding.direction !== 'receive') {
		throw new Error(
			`Integration binding is not inbound: ${params.integrationName}.${params.bindingName}`
		);
	}
	const importData = binding.input ? binding.input.parse(params.importData) : params.importData;
	return runCollectionImportPipeline({
		collectionName: params.collectionName,
		context: {
			scope: { import_data: importData },
			collection: { name: params.collectionName }
		},
		api: params.api
	});
}

export async function runIntegrationSendPipeline(params: {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly records: Record<string, unknown>[];
	readonly api: BeforeApi;
}): Promise<unknown> {
	const binding = integrationBinding(params.integrationName, params.bindingName);
	if (binding.direction !== 'send') {
		throw new Error(
			`Integration binding is not outbound: ${params.integrationName}.${params.bindingName}`
		);
	}
	const output = await runCollectionExportPipeline({
		collectionName: params.collectionName,
		context: {
			scope: { records: params.records },
			collection: { name: params.collectionName }
		},
		api: params.api
	});
	return binding.transform ? binding.transform({ output }, params.api) : output;
}
