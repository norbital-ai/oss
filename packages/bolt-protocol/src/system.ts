import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { WorkspaceAuthoringManifest } from './bundle.js';
import {
	CollectionAnchoredPage,
	CollectionGroupedQueryRequest,
	CollectionHistoryAnchor,
	CollectionMutationPush,
	CollectionQueryRequest
} from './collections.js';
import {
	ChannelEvent,
	ChannelStatus,
	HistoryChange,
	HistoryState,
	PushSubscription
} from './channels.js';
import { CommandHeaders, commandContract } from './host.js';
import { IntegrationSyncStatus } from './integration-http.js';
import {
	AgentId,
	PlanAction,
	DirectiveMode,
	DirectivePriority,
	MessageId,
	ModelCatalogEntry,
	ModelId,
	ConversationId,
	ConversationStatus,
	GeocodingRequest,
	GeocodingResponse
} from './facilities.js';

export {
	CommandHeaders,
	commandContract,
	type CommandContract,
	type CommandResponseContract
} from './host.js';

/** The only public admission contract. A first submit atomically creates Task, message, and directive. */
export const ConversationSendRequest = Schema.Struct({
	conversationId: ConversationId,
	/** Stable across retries of one send, distinct for intentional repeated messages. */
	submissionId: Schema.optionalKey(MessageId),
	agentId: AgentId,
	message: Schema.toEncoded(Prompt.Message),
	mode: DirectiveMode,
	planAction: Schema.optionalKey(PlanAction),
	priority: DirectivePriority,
	modelId: Schema.optionalKey(ModelId)
});
export interface ConversationSendRequest extends Schema.Schema.Type<
	typeof ConversationSendRequest
> {}

export const ConversationSendResult = Schema.Struct({ messageId: MessageId });
export interface ConversationSendResult extends Schema.Schema.Type<typeof ConversationSendResult> {}

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
export const ConversationEditMessageRequest = Schema.Struct({
	conversationId: ConversationId,
	messageId: MessageId,
	message: Schema.toEncoded(Prompt.Message),
	modelId: Schema.optionalKey(ModelId)
});
export interface ConversationEditMessageRequest extends Schema.Schema.Type<
	typeof ConversationEditMessageRequest
> {}

export const ConversationEditMessageResult = Schema.Struct({
	messageId: MessageId,
	supersedesId: MessageId
});
export interface ConversationEditMessageResult extends Schema.Schema.Type<
	typeof ConversationEditMessageResult
> {}

/** Changes waiting messages without editing their content or transcript sequence. */
export const ConversationQueueRequest = Schema.Struct({
	conversationId: ConversationId,
	change: Schema.Union([
		Schema.Struct({ action: Schema.Literals(['steer', 'remove']), messageId: MessageId }),
		Schema.Struct({
			action: Schema.Literal('reorder'),
			messageIds: Schema.Array(MessageId).check(Schema.isMinLength(1))
		})
	])
});
export interface ConversationQueueRequest extends Schema.Schema.Type<
	typeof ConversationQueueRequest
> {}

export const ConversationControlRequest = Schema.Struct({
	conversationId: ConversationId,
	action: Schema.Literals(['stop', 'resume']),
	modelId: Schema.optionalKey(ModelId)
});
export interface ConversationControlRequest extends Schema.Schema.Type<
	typeof ConversationControlRequest
> {}

export const ConversationControlResult = Schema.Struct({
	conversationId: ConversationId,
	status: ConversationStatus
});
export interface ConversationControlResult extends Schema.Schema.Type<
	typeof ConversationControlResult
> {}

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

/** One team row, as a team write answers with it. Mirrors the nested shape inside `WorkspaceAccess`. */
export const WorkspaceTeam = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	description: Schema.optionalKey(Schema.String)
}).annotate({ identifier: 'BoltWorkspaceTeam' });
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
	id: Schema.NonEmptyString,
	/** RFC §4.7: a revision ordinal or an instant; absent reads the latest revision. */
	at: Schema.optionalKey(CollectionHistoryAnchor)
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


/** The host config key naming the VAPID public key a browser subscribes against. */
export const WEB_PUSH_PUBLIC_KEY_CONFIG_KEY = 'BOLT_WEB_PUSH_PUBLIC_KEY';
/** The failure code a push service answering 404 or 410 becomes; the runtime drops the subscription on it. */
export const WEB_PUSH_SUBSCRIPTION_GONE = 'communication_recipient_gone';
export const PushConfiguration = Schema.Struct({ publicKey: Schema.NullOr(Schema.NonEmptyString) });
export interface PushConfiguration extends Schema.Schema.Type<typeof PushConfiguration> {}

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
		responses: [ok(Schema.Struct({ invitationId: Schema.NonEmptyString }))],
		clientPath: ['identity', 'invite'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'identity.createTeam',
		input: Schema.Struct({
			name: Schema.NonEmptyString,
			parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
			description: Schema.optionalKey(Schema.String)
		}),
		responses: [ok(WorkspaceTeam)],
		clientPath: ['identity', 'createTeam'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'identity.updateTeam',
		input: Schema.Struct({
			teamId: Schema.NonEmptyString,
			name: Schema.optionalKey(Schema.String),
			parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
			description: Schema.optionalKey(Schema.NullOr(Schema.String))
		}),
		responses: [ok(WorkspaceTeam)],
		clientPath: ['identity', 'updateTeam'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'identity.deleteTeam',
		input: Schema.Struct({ teamId: Schema.NonEmptyString }),
		responses: [ok(WorkspaceTeam)],
		clientPath: ['identity', 'deleteTeam'],
		clientMode: 'operation'
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
		responses: [ok(Schema.Json)],
		clientPath: ['identity', 'invitation', 'accept'],
		clientMode: 'operation'
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
	/**
	 * A host liveness answer with no side effect.
	 *
	 * The routed-release probe needs a signed command that proves the route, the artifact and the
	 * database are standing without doing work: an embedding checkpoint that finds a queue would
	 * spend a provider call and could fail the probe for a reason unrelated to health.
	 */
	commandContract({
		name: 'host.ping',
		input: EmptyInput,
		responses: [ok(Schema.Struct({ ok: Schema.Literal(true) }))]
	}),
	/**
	 * One seed plan (RFC seeding.md §4): fixtures ordered by the runtime's model graph, each
	 * collection one declared `createMany` as the administering subject. Host-origin only.
	 */
	commandContract({
		name: 'seed.apply',
		input: Schema.Struct({
			fixtures: Schema.Array(
				Schema.Struct({
					collection: Schema.NonEmptyString,
					rows: Schema.Array(Schema.JsonObject)
				})
			)
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'conversations.models',
		input: Schema.Struct({ agentId: AgentId }),
		responses: [ok(TaskModelCatalog)],
		clientPath: ['conversations', 'models'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'conversations.answer',
		input: Schema.Struct({ messageId: MessageId }),
		responses: [ok(Schema.Json)],
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'conversations.send',
		input: ConversationSendRequest,
		responses: [ok(ConversationSendResult)],
		clientPath: ['conversations', 'send'],
		clientMode: 'operation',
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'conversations.editMessage',
		input: ConversationEditMessageRequest,
		responses: [ok(ConversationEditMessageResult)],
		clientPath: ['conversations', 'editMessage'],
		clientMode: 'operation',
		budgetKey: 'agents.turn'
	}),
	commandContract({
		name: 'conversations.updateQueue',
		input: ConversationQueueRequest,
		responses: [ok(Schema.Struct({ conversationId: ConversationId }))],
		clientPath: ['conversations', 'updateQueue'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'conversations.control',
		input: ConversationControlRequest,
		responses: [ok(ConversationControlResult)],
		clientPath: ['conversations', 'control'],
		clientMode: 'operation',
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
	/**
	 * One browser write (RFC §4.2): the declared inputs under the idempotent push envelope. 200 is
	 * the committed settlement; 202 is a write committed provisionally under an approval hold.
	 */
	commandContract({
		name: 'collections.write',
		input: CollectionMutationPush,
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
		name: 'envoys.registration.inspect',
		input: Schema.Struct({ claimId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration'
	}),
	commandContract({
		name: 'envoys.registration.redeem',
		input: Schema.Struct({ claimId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration',
		clientPath: ['envoys', 'registration', 'redeem'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'envoys.drain',
		input: Schema.Struct({ envoy: Schema.NonEmptyString, conversationId: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	/**
	 * A host hands the runtime changes to one channel's history: live traffic, a backfill page, or
	 * the re-listing after a reconnect. Applied idempotently, keyed by the provider's message id.
	 */
	commandContract({
		name: 'channels.ingest',
		input: Schema.Struct({
			channel: Schema.NonEmptyString,
			changes: Schema.Array(HistoryChange).check(Schema.isMaxLength(500)),
			state: Schema.optionalKey(HistoryState),
			horizon: Schema.optionalKey(Schema.String)
		}),
		responses: [ok(Schema.Json)],
		budgetKey: 'envoys.registration'
	}),
	/** Provider reports about messages the channel sent, correlated by the provider's message id. */
	commandContract({
		name: 'channels.event',
		input: Schema.Struct({
			channel: Schema.NonEmptyString,
			events: Schema.Array(ChannelEvent).check(Schema.isMaxLength(500))
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'channels.drain',
		input: Schema.Struct({ channel: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'channels.status',
		input: Schema.Struct({ channel: Schema.NonEmptyString }),
		responses: [ok(ChannelStatus)],
		clientPath: ['channels', 'status'],
		clientMode: 'query'
	}),
	/**
	 * One raw webhook delivery for an `http` channel or an integration sync's `subscribe.webhook`.
	 * `body` is the raw request body: the signature was taken over those bytes.
	 */
	commandContract({
		name: 'webhooks.receive',
		input: Schema.Struct({
			target: Schema.Union([
				Schema.Struct({ channel: Schema.NonEmptyString }),
				Schema.Struct({ integration: Schema.NonEmptyString, sync: Schema.NonEmptyString })
			]),
			headers: Schema.Record(Schema.String, Schema.String),
			body: Schema.String
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'integrations.run',
		input: Schema.Struct({
			integration: Schema.NonEmptyString,
			sync: Schema.NonEmptyString,
			mode: Schema.Literals(['changes', 'reconcile'])
		}),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'integrations.push',
		input: Schema.Struct({ integration: Schema.NonEmptyString, sync: Schema.NonEmptyString }),
		responses: [ok(Schema.Json)]
	}),
	commandContract({
		name: 'integrations.status',
		input: EmptyInput,
		responses: [ok(Schema.Array(IntegrationSyncStatus))],
		clientPath: ['integrations', 'status'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'integrations.control',
		input: Schema.Struct({
			integration: Schema.NonEmptyString,
			sync: Schema.NonEmptyString,
			action: Schema.Literals(['start', 'reconcile', 'pause', 'resume', 'retry'])
		}),
		responses: [ok(Schema.Json)],
		clientPath: ['integrations', 'control'],
		clientMode: 'operation'
	}),
	/**
	 * Push: the host's VAPID public key (null when the host sends no pushes, so the shell offers
	 * nothing), then one subscription per browser, keyed by its push-service endpoint.
	 */
	commandContract({
		name: 'notifications.pushConfiguration',
		input: EmptyInput,
		responses: [ok(PushConfiguration)],
		clientPath: ['notifications', 'pushConfiguration'],
		clientMode: 'query'
	}),
	commandContract({
		name: 'notifications.subscribe',
		input: PushSubscription,
		responses: [ok(Schema.Struct({ subscribed: Schema.Literal(true) }))],
		clientPath: ['notifications', 'subscribe'],
		clientMode: 'operation'
	}),
	/** Address search for a location picker, answered by the host's geocoding provider. */
	commandContract({
		name: 'geocoding.search',
		input: GeocodingRequest,
		responses: [ok(GeocodingResponse)],
		clientPath: ['geocoding', 'search'],
		clientMode: 'operation'
	}),
	commandContract({
		name: 'notifications.unsubscribe',
		input: Schema.Struct({ endpoint: Schema.NonEmptyString }),
		responses: [ok(Schema.Struct({ subscribed: Schema.Literal(false) }))],
		clientPath: ['notifications', 'unsubscribe'],
		clientMode: 'operation'
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
