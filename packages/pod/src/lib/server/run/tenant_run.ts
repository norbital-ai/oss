/** Dispatch tenant hooks, pipelines, and automations from the workspace registry. */
import type {
	CollectionHookParams,
	CollectionHookReturn
} from '$lib/authoring/automations/hooks.js';
import {
	adaptHookContextForAction,
	hookKeyToActionPhase
} from '$lib/server/collection/hook-context.js';
import { createBeforeApi, restrictBeforeHookApi } from '$lib/server/collection/hook-api.server.js';
import { getElevatedAfterHookApi } from '$lib/server/collection/hook-api-context.server.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import {
	resolveSubjectToUser,
	seatCensus,
	workspaceMembership
} from '$lib/server/identity/subject.server.js';
import {
	inviteeEmailForToken,
	mintInvitation,
	provisionFoundingInvitation
} from '$lib/server/identity/invitation.server.js';
import type {
	CollectionExportPipeline,
	CollectionImportPipeline,
	TExportManifest
} from '$lib/authoring/automations/pipelines.js';
import {
	runCollectionExportPipeline as runExportPipeline,
	runCollectionImportPipeline as runImportPipeline,
	runIntegrationReceivePipeline,
	runIntegrationSendPipeline
} from '$lib/server/run/collection_pipeline.js';
import {
	getTenantManifest,
	getTenantWorkspace
} from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { AfterHookApi, BeforeApi, HookApi } from '$lib/authoring/workspace/hook-api.js';
import {
	getWorkspaceCollection,
	allowsMutation
} from '$lib/server/collection/workspace-collections.js';
import type { ErasedHookActionContext } from '$lib/server/collection/hook-context.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { z } from 'zod';
import { AutomationRunTriggerSchema } from '@norbital-ai/platform-utils/system/types';
import { typeGuard } from '@norbital-ai/std/schema';
import { runTenantOutbox } from '$lib/server/integrations/tenant-outbox.server.js';
import { runNotificationOutbox } from '$lib/server/notifications/notification-outbox.server.js';
import { pumpRegisteredAutomations } from './automation-dispatch.server.js';
import { runAgent } from '$lib/server/agent/agent-loop.server.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';

const recordSchema = z.record(z.string(), z.unknown());
const collectionSchema = z.object({ id: z.string(), name: z.string() });
const actorScopeSchema = z.object({
	requestor: recordSchema,
	organization: z.object({ norbital_id: z.string(), name: z.string() }),
	requestor_subordinates: z.array(recordSchema)
});

const collectionHookParamsSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('create'),
		payload: recordSchema,
		scope: actorScopeSchema.extend({ incoming_record: recordSchema }),
		collection: collectionSchema
	}),
	z.object({
		type: z.literal('update'),
		payload: recordSchema,
		scope: actorScopeSchema.extend({
			incoming_record: recordSchema,
			original_record: recordSchema
		}),
		collection: collectionSchema
	}),
	z.object({
		type: z.literal('delete'),
		scope: actorScopeSchema.extend({ original_record: recordSchema }),
		collection: collectionSchema
	}),
	z.object({
		type: z.literal('view'),
		scope: actorScopeSchema.extend({ record: recordSchema }),
		collection: collectionSchema,
		approval_request: recordSchema.optional(),
		event: z.unknown().optional()
	})
]);

export const runtimeRunRequestSchema = z.union([
	z.object({
		kind: z.literal('hook'),
		collectionName: z.string().min(1),
		hookKey: z.string().min(1),
		context: collectionHookParamsSchema
	}),
	z.object({
		kind: z.literal('pipeline'),
		collectionName: z.string().min(1),
		pipelineKey: z.literal('export'),
		context: z.object({
			scope: z.object({ records: z.array(recordSchema) }),
			collection: z.object({ name: z.string() })
		})
	}),
	z.object({
		kind: z.literal('integration'),
		direction: z.literal('receive'),
		integrationName: z.string().min(1),
		bindingName: z.string().min(1),
		collectionName: z.string().min(1),
		importData: z.unknown()
	}),
	z.object({
		kind: z.literal('integration'),
		direction: z.literal('send'),
		integrationName: z.string().min(1),
		bindingName: z.string().min(1),
		collectionName: z.string().min(1),
		records: z.array(recordSchema)
	}),
	z.object({
		kind: z.literal('system-event'),
		eventId: z.string().min(1),
		event: z.string().min(1),
		payload: recordSchema
	}),
	z.object({
		kind: z.literal('pipeline'),
		collectionName: z.string().min(1),
		pipelineKey: z.literal('import'),
		context: z.object({
			scope: z.object({ import_data: z.unknown() }),
			collection: z.object({ name: z.string() })
		})
	}),
	z
		.object({
			kind: z.literal('automation'),
			automationName: z.string().min(1),
			triggeredBy: AutomationRunTriggerSchema.optional()
		})
		.strict(),
	// The host's drain of collection-event automations. Cron automations name themselves; these are
	// discovered from the change feed, so the host asks the runtime to advance rather than guessing
	// which automation to run.
	z
		.object({
			kind: z.literal('automation'),
			action: z.literal('pump'),
			limit: z.number().int().positive().max(1000).optional()
		})
		.strict(),
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('claim'),
		limit: z.number().int().optional()
	}),
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('delivered'),
		ids: z.array(z.string().uuid())
	}),
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('failed'),
		ids: z.array(z.string().uuid()),
		error: z.string(),
		retryAt: z.string().datetime()
	}),
	z.object({
		kind: z.literal('notification'),
		action: z.literal('claim'),
		limit: z.number().int().optional()
	}),
	z.object({
		kind: z.literal('notification'),
		action: z.literal('delivered'),
		ids: z.array(z.string().uuid())
	}),
	z.object({
		kind: z.literal('notification'),
		action: z.literal('failed'),
		ids: z.array(z.string().uuid()),
		error: z.string(),
		retryAt: z.string().datetime()
	}),
	z.object({
		kind: z.literal('automation-events'),
		limit: z.number().int().min(1).max(1000).optional()
	}),
	z.object({ kind: z.literal('getManifest') }),
	// Identity work the host cannot do for itself: it holds the credential, Pod holds the directory.
	z.object({
		kind: z.literal('identity'),
		action: z.literal('resolve-subject'),
		email: z.string().trim().min(1).max(320),
		displayName: z.string().trim().max(255).optional(),
		subjectHmac: z.string().min(1).optional()
	}),
	z.object({ kind: z.literal('identity'), action: z.literal('seats') }),
	z.object({ kind: z.literal('identity'), action: z.literal('membership') }),
	// Which address an invitation token belongs to. Lookup only — the claim happens during subject
	// resolution, so this cannot consume an invitation and cannot be used to enumerate them.
	z.object({
		kind: z.literal('identity'),
		action: z.literal('invite-email'),
		token: z.string().min(1).max(512)
	}),
	z.object({
		kind: z.literal('identity'),
		action: z.literal('invite'),
		email: z.string().trim().min(1).max(320),
		role: z.string().trim().min(1).max(32).optional(),
		invitedByUserId: z.string().uuid().optional(),
		publicUrl: z.string().trim().min(1)
	}),
	// Mints the founding invitation for a freshly provisioned tenant. The token is generated here and
	// leaves only by email, so the provisioning host never sees a redeemable credential.
	z.object({
		kind: z.literal('provision'),
		adminEmail: z.string().trim().min(1).max(320),
		publicUrl: z.string().trim().min(1)
	})
]);

export type RuntimeRunRequest = z.infer<typeof runtimeRunRequestSchema>;

export function parseRuntimeRunRequest(input: unknown): RuntimeRunRequest {
	return runtimeRunRequestSchema.parse(input);
}

export async function runCollectionHook(params: {
	readonly collectionName: string;
	readonly hookKey: string;
	readonly context: CollectionHookParams;
}): Promise<Awaited<CollectionHookReturn>> {
	const mapping = hookKeyToActionPhase(params.hookKey);
	if (!mapping) {
		throw new Error(
			`Collection hook not declared in workspace: ${params.collectionName}.${params.hookKey}`
		);
	}
	const behavior = getWorkspaceCollection(params.collectionName);
	const hooks =
		mapping.action === 'create'
			? behavior?.create?.hooks
			: mapping.action === 'update'
				? behavior?.update?.hooks
				: behavior?.delete?.hooks;
	if (hooks && (mapping.phase === 'before' ? hooks.before : hooks.after)) {
		const adapted = adaptHookContextForAction(params.hookKey, params.context);
		if ('type' in adapted) {
			throw new Error(
				`Collection hook context mismatch: ${params.collectionName}.${params.hookKey}`
			);
		}
		const result =
			mapping.phase === 'before'
				? await runCollectionActionHook({
						collectionName: params.collectionName,
						action: mapping.action,
						phase: 'before',
						context: adapted,
						api: restrictBeforeHookApi(createBeforeApi())
					})
				: await runCollectionActionHook({
						collectionName: params.collectionName,
						action: mapping.action,
						phase: 'after',
						context: adapted,
						api: await getElevatedAfterHookApi()
					});
		return typeGuard(recordSchema, result) ? result : {};
	}

	throw new Error(
		`Collection hook not declared in workspace: ${params.collectionName}.${params.hookKey}`
	);
}

export async function runCollectionExportPipeline(params: {
	readonly collectionName: string;
	readonly context: CollectionExportPipeline['params'];
}): Promise<Awaited<CollectionExportPipeline['return']>> {
	return runExportPipeline({
		...params,
		api: createBeforeApi()
	});
}

export async function runCollectionImportPipeline(params: {
	readonly collectionName: string;
	readonly context: CollectionImportPipeline['params'];
}): Promise<Awaited<CollectionImportPipeline['return']>> {
	return runImportPipeline({
		...params,
		api: createBeforeApi()
	});
}

export type CollectionActionHookPhase = 'before' | 'after';

type RunCollectionActionHookParams =
	| {
			readonly collectionName: string;
			readonly action: 'create' | 'update' | 'delete';
			readonly phase: 'before';
			readonly context: ErasedHookActionContext;
			readonly api: HookApi;
	  }
	| {
			readonly collectionName: string;
			readonly action: 'create' | 'update' | 'delete';
			readonly phase: 'after';
			readonly context: ErasedHookActionContext;
			readonly api: AfterHookApi;
	  };

async function runCreateActionHook(params: RunCollectionActionHookParams): Promise<unknown> {
	const hooks = getWorkspaceCollection(params.collectionName)?.create?.hooks;
	if (!hooks) return undefined;
	if (params.phase === 'before') {
		if (!('input' in params.context)) return undefined;
		return hooks.before?.({ input: params.context.input, api: params.api });
	}
	if (!('record' in params.context)) return undefined;
	return hooks.after?.({ record: params.context.record, api: params.api });
}

async function runUpdateActionHook(params: RunCollectionActionHookParams): Promise<unknown> {
	const hooks = getWorkspaceCollection(params.collectionName)?.update?.hooks;
	if (!hooks) return undefined;
	if (params.phase === 'before') {
		if (!('input' in params.context) || !('existing' in params.context)) return undefined;
		return hooks.before?.({
			input: params.context.input,
			existing: params.context.existing,
			api: params.api
		});
	}
	if (!('record' in params.context)) return undefined;
	return hooks.after?.({ record: params.context.record, api: params.api });
}

async function runDeleteActionHook(params: RunCollectionActionHookParams): Promise<unknown> {
	const hooks = getWorkspaceCollection(params.collectionName)?.delete?.hooks;
	if (!hooks) return undefined;
	if (params.phase === 'before') {
		if (!('existing' in params.context)) return undefined;
		return hooks.before?.({ existing: params.context.existing, api: params.api });
	}
	if (!('record' in params.context)) return undefined;
	return hooks.after?.({ record: params.context.record, api: params.api });
}

export async function runCollectionActionHook(
	params: RunCollectionActionHookParams
): Promise<unknown> {
	const behavior = getWorkspaceCollection(params.collectionName);
	if (!behavior) {
		throw new Error(`Collection not declared in workspace: ${params.collectionName}`);
	}

	switch (params.action) {
		case 'create':
			return runCreateActionHook(params);
		case 'update':
			return runUpdateActionHook(params);
		case 'delete':
			return runDeleteActionHook(params);
		default:
			params.action satisfies never;
	}
}

export async function runAutomation(params: {
	readonly automationName: string;
	readonly triggeredBy?: 'MANUAL' | 'CRON' | 'AGENT' | 'EVENT';
	/** Change-feed dispatch populates `scope.incoming_record` with the committed row. */
	readonly scope?: Record<string, unknown>;
	readonly args?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	const workspaceAutomation = getTenantWorkspace().registered.automations?.[params.automationName];
	if (
		typeof workspaceAutomation === 'object' &&
		workspaceAutomation !== null &&
		'spec' in workspaceAutomation
	) {
		const spec = (
			workspaceAutomation as {
				spec: { kind: string; handler?: unknown } | AgentAutomationSpec;
			}
		).spec;
		if (spec.kind === 'agent' && 'task' in spec && typeof spec.task === 'string') {
			const result = await runAgent({
				automationName: params.automationName,
				spec,
				input: spec.task
			});
			return { runId: result.runId, text: result.text };
		}
		if (spec.kind !== 'deterministic' || typeof spec.handler !== 'function') {
			throw new Error(`Automation '${params.automationName}' has an invalid runtime specification`);
		}
		const handler = spec.handler as (
			api: BeforeApi,
			context: { readonly args: Record<string, unknown>; readonly scope: Record<string, unknown> }
		) => Promise<Record<string, unknown>>;
		const startedAt = new Date().toISOString();

		const api = createBeforeApi();
		const ctx = getWorkspace({ provision: true });
		const requestedByUserId = ctx.baseScope.requestor.norbital_id;

		try {
			const result = await handler(api, {
				args: params.args ?? {},
				scope: params.scope ?? {}
			});

			// `automation_run` is a system collection: no workspace declares mutations on it, so an
			// unelevated write is refused. Recording the run is the runtime's own bookkeeping, not a
			// tenant mutation — and without elevation the refusal replaces the automation's result
			// with a 403, reporting every successful scheduled run as a failure.
			await createRecord(
				ctx,
				'automation_run',
				{
					requested_by_user_id: requestedByUserId,
					automation_name: params.automationName,
					status: 'success',
					output: result,
					error: null,
					started_at: startedAt,
					completed_at: new Date().toISOString()
				},
				{ isElevated: true }
			);

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Best-effort: the automation's own failure is the one worth propagating, so a failure to
			// record it must not mask the cause with a bookkeeping error.
			try {
				await createRecord(
					ctx,
					'automation_run',
					{
						requested_by_user_id: requestedByUserId,
						automation_name: params.automationName,
						status: 'failed',
						output: null,
						error: message,
						started_at: startedAt,
						completed_at: new Date().toISOString()
					},
					{ isElevated: true }
				);
			} catch (recordingCause) {
				console.error('[pod] failed to record automation run', recordingCause);
			}
			throw error;
		}
	}

	throw new Error(`Automation not declared in workspace: ${params.automationName}`);
}

export async function dispatchRuntimeRun(request: RuntimeRunRequest): Promise<unknown> {
	switch (request.kind) {
		case 'hook':
			return runCollectionHook({
				collectionName: request.collectionName,
				hookKey: request.hookKey,
				context: request.context
			});
		case 'pipeline':
			if (request.pipelineKey === 'export') {
				return runCollectionExportPipeline({
					collectionName: request.collectionName,
					context: request.context
				});
			}
			return runCollectionImportPipeline({
				collectionName: request.collectionName,
				context: request.context
			});
		case 'automation': {
			if ('action' in request) {
				const { pumpAutomations } = await import('./automation-dispatch.server.js');
				return pumpAutomations(getWorkspace({ provision: true }), request.limit);
			}
			return runAutomation({
				automationName: request.automationName,
				triggeredBy: request.triggeredBy
			});
		}
		case 'integration': {
			const api = createBeforeApi();
			return request.direction === 'receive'
				? runIntegrationReceivePipeline({
						integrationName: request.integrationName,
						bindingName: request.bindingName,
						collectionName: request.collectionName,
						importData: request.importData,
						api
					})
				: runIntegrationSendPipeline({
						integrationName: request.integrationName,
						bindingName: request.bindingName,
						collectionName: request.collectionName,
						records: request.records,
						api
					});
		}
		case 'system-event': {
			const ctx = getWorkspace({ provision: true });
			const workspace = getTenantWorkspace();
			const matchingBindings = Object.entries(workspace.registered.integrationBindings).filter(
				(
					entry
				): entry is [
					string,
					Extract<
						(typeof workspace.registered.integrationBindings)[string],
						{ direction: 'receive' }
					>
				] => entry[1].direction === 'receive' && entry[1].systemEvent === request.event
			);
			await Promise.all(
				matchingBindings.map(async ([bindingKey, binding]) => {
					const separator = bindingKey.indexOf(':');
					if (separator < 1) throw new Error(`Invalid integration binding key: ${bindingKey}`);
					const records = await runIntegrationReceivePipeline({
						integrationName: bindingKey.slice(0, separator),
						bindingName: bindingKey.slice(separator + 1),
						collectionName: binding.collection,
						importData: {
							event_id: request.eventId,
							event: request.event,
							payload: request.payload
						},
						api: createBeforeApi()
					});
					await Promise.all(
						records.map((record) =>
							createRecord(ctx, binding.collection, record, { isElevated: true })
						)
					);
				})
			);
			return { handled: matchingBindings.length };
		}
		case 'outbox':
			return runTenantOutbox(request);
		case 'notification':
			return runNotificationOutbox(request);
		case 'automation-events':
			return pumpRegisteredAutomations(getWorkspace({ provision: true }), request.limit);
		case 'getManifest':
			return getTenantManifest();
		case 'identity': {
			if (request.action === 'seats') return seatCensus();
			if (request.action === 'membership') return workspaceMembership();
			if (request.action === 'invite-email') {
				return { email: await inviteeEmailForToken(request.token) };
			}
			if (request.action === 'invite') {
				return mintInvitation({
					email: request.email,
					...(request.role ? { role: request.role } : {}),
					...(request.invitedByUserId ? { invitedByUserId: request.invitedByUserId } : {}),
					publicUrl: request.publicUrl
				});
			}
			return resolveSubjectToUser({
				email: request.email,
				...(request.displayName ? { displayName: request.displayName } : {}),
				subjectHmac: request.subjectHmac ?? null
			});
		}
		case 'provision':
			return provisionFoundingInvitation({
				adminEmail: request.adminEmail,
				publicUrl: request.publicUrl
			});
		default:
			request satisfies never;
			throw new Error('Unknown runtime run kind');
	}
}
