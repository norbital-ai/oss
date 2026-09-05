import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { WorkspaceAuthoringManifest } from './bundle.js';
import {
	CollectionAnchoredPage,
	CollectionGroupedQueryRequest,
	CollectionMutateRequest,
	CollectionQueryRequest
} from './collections.js';
import { CommandHeaders, commandContract } from './host.js';
import {
	AgentId,
	DirectiveId,
	DirectiveMode,
	DirectivePriority,
	MessageId,
	ModelCatalogEntry,
	ModelId,
	TaskId,
	TaskStatus
} from './facilities.js';

export {
	CommandHeaders,
	commandContract,
	type CommandContract,
	type CommandResponseContract
} from './host.js';

/** The only public admission contract. A first submit atomically creates Task, message, and directive. */
export const TaskSubmitRequest = Schema.Struct({
	taskId: TaskId,
	agentId: AgentId,
	message: Schema.toEncoded(Prompt.Message),
	mode: DirectiveMode,
	priority: DirectivePriority,
	modelId: Schema.optionalKey(ModelId)
});
export interface TaskSubmitRequest extends Schema.Schema.Type<typeof TaskSubmitRequest> {}

export const TaskSubmitResult = Schema.Struct({ directiveId: DirectiveId });
export interface TaskSubmitResult extends Schema.Schema.Type<typeof TaskSubmitResult> {}

/** Host-configured language models available to an authorized agent caller. */
export const TaskModelCatalog = Schema.Struct({
	languageModels: Schema.Array(ModelCatalogEntry),
	defaultLanguageModelId: ModelId
});
export interface TaskModelCatalog extends Schema.Schema.Type<typeof TaskModelCatalog> {}

/**
 * The only public revision contract. A revision supersedes exactly one of the subject's own durable
 * user messages: the original row is never edited or deleted, the revision is appended as the newest
 * message of the Task, and the same admission queues the Agent directive that continues from it.
 */
export const TaskEditMessageRequest = Schema.Struct({
	taskId: TaskId,
	messageId: MessageId,
	message: Schema.toEncoded(Prompt.Message),
	modelId: Schema.optionalKey(ModelId)
});
export interface TaskEditMessageRequest extends Schema.Schema.Type<typeof TaskEditMessageRequest> {}

export const TaskEditMessageResult = Schema.Struct({
	directiveId: DirectiveId,
	messageId: MessageId,
	supersedesId: MessageId
});
export interface TaskEditMessageResult extends Schema.Schema.Type<typeof TaskEditMessageResult> {}

export const TaskControlRequest = Schema.Struct({
	taskId: TaskId,
	action: Schema.Literals(['stop', 'resume']),
	modelId: Schema.optionalKey(ModelId)
});
export interface TaskControlRequest extends Schema.Schema.Type<typeof TaskControlRequest> {}

export const TaskControlResult = Schema.Struct({ taskId: TaskId, status: TaskStatus });
export interface TaskControlResult extends Schema.Schema.Type<typeof TaskControlResult> {}

/**
 * Host Task-origin execution. The browser never calls this; admit writes a `bolt_task` row
 * that the schedule tick dispatches. `bolt_run_as` is the minted subject — do not add a
 * top-level `subject` key; Task dispatch refuses minted identity fields.
 */
export const TaskExecuteRequest = Schema.Struct({
	taskId: TaskId,
	bolt_run_as: Schema.Json
});
export interface TaskExecuteRequest extends Schema.Schema.Type<typeof TaskExecuteRequest> {}

export const TaskExecuteResult = Schema.Struct({
	taskId: TaskId,
	status: Schema.Literals(['idle', 'running', 'waiting', 'done', 'failed', 'attention'])
});
export interface TaskExecuteResult extends Schema.Schema.Type<typeof TaskExecuteResult> {}

/** The approval state exchanged by the browser approval commands and their runtime handler. */
export const ApprovalState = Schema.TaggedUnion({
	Pending: {
		requestId: Schema.NonEmptyString,
		step: Schema.Number.check(Schema.isInt()),
		operation: Schema.Json
	},
	Approved: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		superseded: Schema.optionalKey(Schema.Literal(true)),
		reason: Schema.optionalKey(Schema.NonEmptyString),
		operation: Schema.optionalKey(Schema.Json)
	},
	Rejected: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.String,
		operation: Schema.optionalKey(Schema.Json)
	},
	ChangesRequested: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	Conflicted: {
		requestId: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	Withdrawn: {
		requestId: Schema.NonEmptyString,
		withdrawnBy: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	}
});
export type ApprovalState = typeof ApprovalState.Type;

const response = <const Status extends number, const Value extends Schema.Top>(
	status: Status,
	value: Value
) => ({
	status,
	value,
	headers: CommandHeaders
});
const ok = <const Value extends Schema.Top>(value: Value) => response(200, value);

const EmptyInput = Schema.Struct({});

/** Vault projection: declarations plus whether a value is set, never the value itself. */
export const SecretsStatus = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		label: Schema.String,
		description: Schema.optionalKey(Schema.String),
		secret: Schema.Boolean,
		configured: Schema.Boolean,
		default: Schema.optionalKey(Schema.String),
		updatedAt: Schema.optionalKey(Schema.String),
		sourcePath: Schema.optionalKey(Schema.String)
	})
).annotate({ identifier: 'BoltSecretsStatus' });
export type SecretsStatus = typeof SecretsStatus.Type;

export const EnvoyStatus = Schema.Struct({
	envoy: Schema.NonEmptyString,
	received: Schema.Number,
	replied: Schema.Number
}).annotate({ identifier: 'BoltEnvoyStatus' });
export type EnvoyStatus = typeof EnvoyStatus.Type;

const WorkspaceAccessRole = Schema.Literals(['admin', 'manager', 'basic']);
export const WorkspaceAccess = Schema.Struct({
	members: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			email: Schema.String,
			name: Schema.String,
			role: WorkspaceAccessRole,
			status: Schema.Literals(['active', 'suspended', 'invited']),
			team: Schema.optionalKey(Schema.String)
		})
	),
	invitations: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			email: Schema.String,
			role: WorkspaceAccessRole,
			status: Schema.Literals(['pending', 'accepted', 'revoked', 'expired']),
			invitedBy: Schema.optionalKey(Schema.String),
			expiresAt: Schema.optionalKey(Schema.String)
		})
	),
	teams: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
			description: Schema.optionalKey(Schema.String)
		})
	),
	events: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			action: Schema.String,
			actor: Schema.String,
			subject: Schema.optionalKey(Schema.String),
			at: Schema.String
		})
	)
}).annotate({ identifier: 'BoltWorkspaceAccess' });
export type WorkspaceAccess = typeof WorkspaceAccess.Type;
const ApprovalCapabilityRows = Schema.Array(
	Schema.Struct({
		id: Schema.NonEmptyString,
		status: Schema.NonEmptyString,
		canDecide: Schema.Boolean,
		canSupersede: Schema.Boolean,
		canWithdraw: Schema.Boolean
	})
);
const RequestIdInput = Schema.Struct({ requestId: Schema.NonEmptyString });
const CollectionRecordInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString
});
const CollectionMutation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json)
});
const CollectionImportInput = Schema.Struct({ records: Schema.Array(CollectionMutation) });
const AutomationStartInput = Schema.Struct({ name: Schema.NonEmptyString, input: Schema.Json });
const AutomationStopInput = Schema.Struct({
	name: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const MaxInboundAttachmentBytes = 8 * 1024 * 1024;
const InboundAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	mimeType: Schema.Literals(['image/jpeg', 'image/png']),
	fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	byteLength: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: MaxInboundAttachmentBytes })
	),
	bytesBase64: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(Math.ceil(MaxInboundAttachmentBytes / 3) * 4),
		Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
	)
});
const EnvoyDelivery = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	conversationKind: Schema.Literals(['dm', 'group']),
	messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	sentAt: Schema.String.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
	),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Schema.Array(InboundAttachment).check(
		Schema.makeFilter(
			(attachments) => attachments.length <= 8 || 'at most 8 inbound attachments are accepted'
		)
	),
	sender: Schema.optionalKey(
		Schema.Struct({
			id: Schema.NonEmptyString,
			displayName: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
});
const NotificationInput = Schema.Struct({
	id: Schema.NonEmptyString,
	recipient: Schema.NonEmptyString,
	payload: Schema.Json,
	read: Schema.Boolean
});
const AutomationTaskInput = Schema.Struct({
	args: Schema.Json,
	scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	bolt_run_as: Schema.Json,
	bolt_depth: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	),
	bolt_task_id: Schema.NonEmptyString
});

export const SystemCommandContracts = [
	commandContract({
		name: 'secrets.status',
		input: EmptyInput,
		responses: [ok(SecretsStatus)],
		clientPath: ['secrets', 'status'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'secrets.write',
		input: Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String }),
		responses: [ok(Schema.Struct({ saved: Schema.Literal(true), name: Schema.NonEmptyString }))],
		clientPath: ['secrets', 'write'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'apps.visible',
		input: EmptyInput,
		responses: [ok(Schema.Struct({ apps: Schema.Array(Schema.String) }))],
		clientPath: ['apps', 'visible'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'access.impersonation',
		input: EmptyInput,
		responses: [
			ok(
				Schema.Struct({
					isAdmin: Schema.Boolean,
					isActive: Schema.Boolean,
					activeTeamIds: Schema.Array(Schema.String),
					teams: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
				})
			)
		],
		clientPath: ['access', 'impersonation'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'access.impersonateTeam',
		input: Schema.Struct({ teamId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)],
		clientPath: ['access', 'impersonateTeam'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'access.explain',
		input: Schema.Struct({ action: Schema.NonEmptyString, resource: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ allowed: Schema.Boolean, reason: Schema.NonEmptyString }))],
		clientPath: ['access', 'explain'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'identity.admitFounder',
		input: Schema.Struct({ email: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'identity.bootstrapFounder',
		input: Schema.Struct({ email: Schema.NonEmptyString, claimId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'identity.sendCode',
		input: Schema.Struct({ email: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ sent: Schema.Literal(true) }))]
	}),
	commandContract({
		name: 'identity.verifyCode',
		input: Schema.Struct({ email: Schema.NonEmptyString, code: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ credential: Schema.NonEmptyString }))]
	}),
	commandContract({
		name: 'identity.continueSession',
		input: Schema.Struct({ email: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ credential: Schema.NonEmptyString }))]
	}),
	commandContract({
		name: 'identity.workspaceAccess',
		input: EmptyInput,
		responses: [ok(WorkspaceAccess)],
		clientPath: ['identity', 'workspaceAccess'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'identity.invite',
		input: Schema.Struct({ email: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ invitationId: Schema.NonEmptyString }))]
	}),
	commandContract({
		name: 'identity.assignTeam',
		input: Schema.Struct({
			memberId: Schema.NonEmptyString,
			teamId: Schema.NullOr(Schema.NonEmptyString)
		}),
		responses: [ok(Schema.Json)],
		clientPath: ['identity', 'assignTeam'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'identity.setMemberAdmin',
		input: Schema.Struct({ memberId: Schema.NonEmptyString, admin: Schema.Boolean }),
		responses: [ok(Schema.Json)],
		clientPath: ['identity', 'setMemberAdmin'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'identity.invitation.inspect',
		input: Schema.Struct({ invitationId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'identity.invitation.accept',
		input: Schema.Struct({ invitationId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'approvals.decide',
		input: Schema.Struct({
			state: RequestIdInput,
			decision: Schema.Literals(['approve', 'reject', 'request_changes', 'supersede']),
			reason: Schema.optionalKey(Schema.String)
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'approvals.withdraw',
		input: Schema.Struct({ state: RequestIdInput }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'approvals.capabilities',
		input: RequestIdInput,
		responses: [ok(ApprovalCapabilityRows)]
	}),
	commandContract({
		name: 'approvals.status',
		input: RequestIdInput,
		responses: [ok(Schema.NullOr(ApprovalState))]
	}),
	commandContract({ name: 'collections.embed', input: EmptyInput, responses: [ok(Schema.Json)] }),
	commandContract({
		name: 'tasks.models',
		input: Schema.Struct({ agentId: AgentId }),
		responses: [ok(TaskModelCatalog)],
		clientPath: ['tasks', 'models'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'tasks.submit',
		input: TaskSubmitRequest,
		responses: [ok(TaskSubmitResult)],
		clientPath: ['tasks', 'submit'],
		clientMode: 'operation',
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'tasks.editMessage',
		input: TaskEditMessageRequest,
		responses: [ok(TaskEditMessageResult)],
		clientPath: ['tasks', 'editMessage'],
		clientMode: 'operation',
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'tasks.control',
		input: TaskControlRequest,
		responses: [ok(TaskControlResult)],
		clientPath: ['tasks', 'control'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'tasks.execute',
		input: TaskExecuteRequest,
		responses: [ok(TaskExecuteResult)],
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'workspace.manifest',
		input: EmptyInput,
		responses: [ok(WorkspaceAuthoringManifest)],
		clientPath: ['workspace', 'manifest'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'workspace.authoringManifest',
		input: EmptyInput,
		responses: [ok(WorkspaceAuthoringManifest)],
		clientPath: ['workspace', 'authoringManifest'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'collections.history',
		input: CollectionRecordInput,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.mutate',
		input: CollectionMutateRequest,
		responses: [ok(Schema.Json), response(202, Schema.Json)]
	}),
	commandContract({
		name: 'collections.resume',
		input: RequestIdInput,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.discard',
		input: RequestIdInput,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.import',
		input: CollectionImportInput,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.export',
		input: CollectionQueryRequest,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.count',
		input: CollectionQueryRequest,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'collections.findMany',
		input: CollectionQueryRequest,
		responses: [ok(CollectionAnchoredPage)]
	}),
	commandContract({
		name: 'collections.findFirst',
		input: CollectionQueryRequest,
		responses: [ok(Schema.NullOr(Schema.Record(Schema.String, Schema.Json)))]
	}),
	commandContract({
		name: 'collections.findGrouped',
		input: CollectionGroupedQueryRequest,
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'schema.plan',
		input: EmptyInput,
		responses: [ok(Schema.Json)],
		clientPath: ['schema', 'plan'],
		clientMode: 'query'
	}),
	commandContract({ name: 'schema.fingerprint', input: EmptyInput, responses: [ok(Schema.Json)] }),
	commandContract({
		name: 'schema.validate',
		input: EmptyInput,
		responses: [ok(Schema.Struct({ valid: Schema.Literal(true) }))],
		clientPath: ['schema', 'validate'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'schema.verify',
		input: EmptyInput,
		responses: [ok(Schema.Json)],
		clientPath: ['schema', 'verify'],
		clientMode: 'query'
	}),
	commandContract({ name: 'schema.migrate', input: EmptyInput, responses: [ok(Schema.Json)] }),
	commandContract({
		name: 'automations.start',
		input: AutomationStartInput,
		responses: [
			ok(Schema.Struct({ taskId: Schema.NonEmptyString, result: Schema.NullOr(Schema.Json) }))
		]
	}),
	commandContract({
		name: 'automations.stop',
		input: AutomationStopInput,
		responses: [ok(Schema.Struct({ stopped: Schema.Literal(true) }))]
	}),
	commandContract({
		name: 'envoys.receive',
		input: Schema.Struct({ envoy: Schema.NonEmptyString, delivery: EnvoyDelivery }),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration'
	}),
	commandContract({
		name: 'envoys.registration.inspect',
		input: Schema.Struct({ claimId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration'
	}),
	commandContract({
		name: 'envoys.registration.redeem',
		input: Schema.Struct({ claimId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration'
	}),
	commandContract({
		name: 'envoys.drain',
		input: Schema.Struct({ envoy: Schema.NonEmptyString, conversationId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'envoys.complete',
		input: Schema.Struct({
			envoy: Schema.NonEmptyString,
			conversationId: Schema.NonEmptyString,
			output: Schema.Json,
			progressKey: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'envoys.status',
		input: Schema.Struct({ envoy: Schema.NonEmptyString }),
		responses: [ok(EnvoyStatus)],
		clientPath: ['envoys', 'status'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'integrations.pull',
		input: Schema.Struct({
			name: Schema.NonEmptyString,
			cursor: Schema.Json,
			binding: Schema.optionalKey(Schema.NonEmptyString)
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'integrations.flush',
		input: Schema.Struct({ name: Schema.NonEmptyString, input: Schema.optionalKey(Schema.Json) }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'notifications.drain',
		input: NotificationInput,
		responses: [ok(Schema.Json)]
	})
] as const;

export const WorkspaceInvokeContract = commandContract({
	name: 'invoke.*',
	input: Schema.Struct({ input: Schema.Json }),
	responses: [ok(Schema.Json)]
});

export const WorkspaceAutomationContract = commandContract({
	name: 'automations.*',
	input: AutomationTaskInput,
	responses: [ok(Schema.Json)]
});

export const DataBrowserCommandContract = commandContract({
	name: 'data-browser/query',
	input: Schema.Struct({
		collection: Schema.NonEmptyString,
		input: Schema.optionalKey(Schema.Struct({ limit: Schema.optionalKey(Schema.Number) }))
	}),
	responses: [ok(Schema.Json)]
});
