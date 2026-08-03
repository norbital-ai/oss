import type { AnySchema } from '$lib/authoring/schema/types.js';
import type { AnyCollectionBehavior } from '$lib/authoring/schema/collection-behavior.js';
import type { HandlerDefinition } from '$lib/authoring/automations/handlers.js';
import { mergePlatformSchema } from '$lib/authoring/schema/system-workspace.js';
import { createDbApi, type RemoteDbTransport } from './db-api.js';
import { getWorkspaceRemoteTransport } from './remote-transport.js';

function buildLazyRemoteTransport(): RemoteDbTransport {
	return {
		findMany: (input) => getWorkspaceRemoteTransport().db.findMany(input),
		findFirst: (input) => getWorkspaceRemoteTransport().db.findFirst(input),
		findGrouped: (input) => getWorkspaceRemoteTransport().db.findGrouped(input),
		findHistory: (input) => getWorkspaceRemoteTransport().db.findHistory(input),
		count: (input) => getWorkspaceRemoteTransport().db.count(input),
		create: (input) => getWorkspaceRemoteTransport().db.create(input),
		createMany: (input) => getWorkspaceRemoteTransport().db.createMany(input),
		update: (input) => getWorkspaceRemoteTransport().db.update(input),
		updateMany: (input) => getWorkspaceRemoteTransport().db.updateMany(input),
		delete: (input) => getWorkspaceRemoteTransport().db.delete(input)
	};
}

function buildRemoteInvokeProxies(
	handlers: Record<string, HandlerDefinition>
): Record<string, unknown> {
	const proxies: Record<string, unknown> = {};
	for (const [name, def] of Object.entries(handlers)) {
		proxies[name] = (input: unknown) => {
			const transport = getWorkspaceRemoteTransport();
			const invoke = def.kind === 'command' ? transport.invokeCommand : transport.invokeQuery;
			return invoke({ name, payload: input });
		};
	}
	return proxies;
}

/**
 * Runtime construction of the workspace client api. Schema-erased on purpose:
 * `defineWorkspace` casts the result to the fully typed `WorkspaceApi`.
 */
export function buildWorkspaceApi(
	schema: AnySchema,
	behaviors: Readonly<Record<string, AnyCollectionBehavior>>,
	remotes: Record<string, HandlerDefinition>
) {
	const behaviorMap = Object.fromEntries(Object.values(behaviors).map((b) => [b.name, b]));

	const db = createDbApi(
		mergePlatformSchema(schema),
		{ mode: 'remote', transport: buildLazyRemoteTransport() },
		behaviorMap
	);

	return {
		db,
		invoke: buildRemoteInvokeProxies(remotes)
	};
}
