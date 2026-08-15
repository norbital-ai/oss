/** Dispatch tenant hooks, pipelines, and automations from the workspace registry. */
import type {
	CollectionHookParams,
	CollectionHookReturn
} from '$lib/authoring/automations/hooks.js';
import {
	adaptHookContextForAction,
	hookKeyToActionPhase
} from '$lib/server/collection/hook-context.js';
import {
	createBeforeApi,
	getElevatedAfterHookApi,
	restrictBeforeHookApi
} from '$lib/server/collection/hook-api.server.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { resolveSubjectToUser } from '$lib/server/identity/subject.server.js';
import {
	absoluteAcceptUrl,
	mintInvitation,
	provisionFoundingInvitation
} from '$lib/server/identity/invitation.server.js';
import type {
	CollectionExportPipeline,
	CollectionImportPipeline
} from '$lib/authoring/automations/pipelines.js';
import {
	runCollectionExportPipeline as runExportPipeline,
	runCollectionImportPipeline as runImportPipeline,
	runIntegrationSendPipeline
} from '$lib/server/run/collection_pipeline.js';
import {
	getTenantWorkspace,
	getWorkspaceCollection
} from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { AfterHookApi, BeforeApi, HookApi } from '$lib/authoring/workspace/hook-api.js';
import type { ErasedHookActionContext } from '$lib/server/collection/hook-context.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';
import {
	dispatchSystemEvent,
	importIntegrationRecords
} from '$lib/server/integrations/tenant-inbound.server.js';
import {
	admitEventAutomations,
	admitScheduledAutomation,
	runAutomationReceipt
} from './automation-dispatch.server.js';
import {
	ChannelInboundSchema,
	deliverChannelMessage
} from '$lib/server/channel-delivery.server.js';
import {
	AgentChatInputSchema,
	AgentChatUpdateVerifierInputSchema,
	agentChatStart,
	agentChatUpdateVerifier
} from '$lib/remote/agent_chat.remote.js';
import { runPendingConversationTitles } from '$lib/server/agent/conversation-title.server.js';
import { isAutomationEffectYield, pendingAutomationEffect } from './automation-replay.server.js';
import {
	durableAgentSnapshotFromScope,
	runDurableAgentAutomation
} from '$lib/server/agent/agent-loop.server.js';

const recordSchema = z.record(z.string(), z.unknown());

export const runtimeRunRequestSchema = z.union([
	z.object({
		kind: z.literal('integration'),
		direction: z.literal('receive'),
		integrationName: z.string().min(1),
		bindingName: z.string().min(1),
		collectionName: z.string().min(1),
		importData: z.unknown(),
		// Present when the delivery can be repeated by whoever sent it — a webhook. The ledger row is
		// claimed on it before the import runs, so a redelivery is refused rather than re-imported.
		eventId: z.string().min(1).max(512).optional()
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
	z
		.object({
			kind: z.literal('automation'),
			automationName: z.string().min(1),
			action: z.literal('admit'),
			occurrenceId: z.string().min(1).max(512),
			artifact: z.object({
				artifactId: z.string().min(1).max(512),
				checkpointId: z.string().min(1).max(512),
				treeHash: z.string().min(1).max(512),
				runtimeVersion: z.string().min(1).max(128)
			})
		})
		.strict(),
	z.object({
		kind: z.literal('automation-events'),
		action: z.enum(['admit', 'run']),
		artifact: z
			.object({
				artifactId: z.string().min(1).max(512),
				checkpointId: z.string().min(1).max(512),
				treeHash: z.string().min(1).max(512),
				runtimeVersion: z.string().min(1).max(128)
			})
			.optional(),
		receiptId: z.string().uuid().optional(),
		limit: z.number().int().min(1).max(1000).optional()
	}),
	z.object({
		kind: z.literal('agent-conversation-titles'),
		limit: z.number().int().min(1).max(50).optional()
	}),
	// Host-owned interactive door. Not an API-client remote — only the trusted host and the
	// dedicated `/_runtime/agent/*` shell routes may start a turn.
	AgentChatInputSchema.extend({
		kind: z.literal('agent'),
		action: z.literal('start')
	}),
	AgentChatUpdateVerifierInputSchema.extend({
		kind: z.literal('agent'),
		action: z.literal('updateVerifier')
	}),
	// A channel message the host already authenticated on its own wire. Deliberately reachable only
	// here: Pod holds no transport credential, so it cannot verify a webhook signature, and a public
	// inbound route would be a way to make the agent answer as anyone.
	ChannelInboundSchema,
	// Identity work the host cannot do for itself: it holds the credential, Pod holds the directory.
	z.object({
		kind: z.literal('identity'),
		action: z.literal('resolve-subject'),
		email: z.string().trim().min(1).max(320),
		displayName: z.string().trim().max(255).optional(),
		subjectHmac: z.string().min(1).optional()
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
	// leaves only by email, so the provisioning host never sees a redeemable credential. `lang`
	// carries the recipient-side locale the host resolved (e.g. from the `?lang=` the admin used).
	z.object({
		kind: z.literal('provision'),
		adminEmail: z.string().trim().min(1).max(320),
		publicUrl: z.string().trim().min(1),
		lang: z.string().trim().min(1).max(32).optional()
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

export async function executeAutomationHandler(params: {
	readonly automationName: string;
	/** Change-feed dispatch populates `scope.incoming_record` with the committed row. */
	readonly scope?: Record<string, unknown>;
	readonly args?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	if (
		params.automationName === 'agent:interactive' ||
		params.automationName.startsWith('channel:')
	) {
		const snapshot = durableAgentSnapshotFromScope(params.scope);
		if (!snapshot)
			throw new Error(`Agent turn receipt '${params.automationName}' is missing its snapshot`);
		try {
			return await runDurableAgentAutomation({
				automationName:
					params.automationName === 'agent:interactive' ? null : params.automationName,
				spec: snapshot.spec,
				scope: params.scope,
				snapshot
			});
		} catch (error) {
			const pending = pendingAutomationEffect();
			if (pending) throw pending;
			if (isAutomationEffectYield(error)) throw error;
			throw error;
		}
	}

	const workspaceAutomation = getTenantWorkspace().registered.automations?.[params.automationName];
	if (
		typeof workspaceAutomation === 'object' &&
		workspaceAutomation !== null &&
		'spec' in workspaceAutomation
	) {
		const spec = (workspaceAutomation as { spec: { handler?: unknown } }).spec;
		if (typeof spec.handler !== 'function') {
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
			const pending = pendingAutomationEffect();
			if (pending) throw pending;

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
			const pending = pendingAutomationEffect();
			if (pending) throw pending;
			if (isAutomationEffectYield(error)) throw error;
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
		case 'automation': {
			return admitScheduledAutomation(getWorkspace({ provision: true }), {
				automationName: request.automationName,
				occurrenceId: request.occurrenceId,
				artifact: request.artifact
			});
		}
		case 'integration': {
			// Inbound writes what the import pipeline produced; outbound only shapes a payload the host
			// still has to deliver. That asymmetry is the boundary, not an oversight: a `receive` has
			// nowhere else to land its rows, a `send` has no network here to send them over.
			if (request.direction === 'receive') {
				return importIntegrationRecords({
					integrationName: request.integrationName,
					bindingName: request.bindingName,
					collectionName: request.collectionName,
					importData: request.importData,
					...(request.eventId ? { eventId: request.eventId } : {})
				});
			}
			return runIntegrationSendPipeline({
				integrationName: request.integrationName,
				bindingName: request.bindingName,
				collectionName: request.collectionName,
				records: request.records,
				api: createBeforeApi()
			});
		}
		case 'system-event':
			return dispatchSystemEvent({
				eventId: request.eventId,
				event: request.event,
				payload: request.payload
			});
		case 'automation-events':
			if (request.action === 'admit') {
				if (!request.artifact) throw new Error('Automation admission requires an artifact binding');
				return admitEventAutomations(
					getWorkspace({ provision: true }),
					request.artifact,
					request.limit
				);
			}
			if (request.action === 'run') {
				if (!request.receiptId || !request.artifact) {
					throw new Error('Automation run requires receipt and artifact binding');
				}
				return runAutomationReceipt(
					getWorkspace({ provision: true }),
					request.receiptId,
					request.artifact
				);
			}
			request.action satisfies never;
			throw new Error('Unknown automation-events host-command action');
		case 'agent-conversation-titles':
			return runPendingConversationTitles(request.limit);
		case 'agent':
			switch (request.action) {
				case 'start': {
					const { kind: _kind, action: _action, ...input } = request;
					return agentChatStart(input);
				}
				case 'updateVerifier': {
					const { kind: _kind, action: _action, ...input } = request;
					return agentChatUpdateVerifier(input);
				}
				default:
					request satisfies never;
					throw new Error('Unknown agent host-command action');
			}
		case 'channel':
			return deliverChannelMessage(request);
		case 'identity': {
			switch (request.action) {
				case 'invite': {
					// The host-command path, unlike the settings surface, has no browser to compose an origin
					// against — `pod invite` prints the link to a terminal — so it builds an absolute one from
					// the `publicUrl` the host already had to configure.
					const minted = await mintInvitation({
						email: request.email,
						...(request.role ? { role: request.role } : {}),
						...(request.invitedByUserId ? { invitedByUserId: request.invitedByUserId } : {})
					});
					return {
						invitationId: minted.invitationId,
						acceptUrl: absoluteAcceptUrl(request.publicUrl, minted.acceptPath)
					};
				}
				case 'resolve-subject':
					return resolveSubjectToUser({
						email: request.email,
						...(request.displayName ? { displayName: request.displayName } : {}),
						subjectHmac: request.subjectHmac ?? null
					});
				default:
					request satisfies never;
					throw new Error('Unknown identity host-command action');
			}
		}
		case 'provision':
			return provisionFoundingInvitation({
				adminEmail: request.adminEmail,
				publicUrl: request.publicUrl,
				...(request.lang ? { locale: request.lang } : {})
			});
		default:
			request satisfies never;
			throw new Error('Unknown runtime run kind');
	}
}
