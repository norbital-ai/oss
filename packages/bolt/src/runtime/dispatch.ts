import { Clock, Effect, Number as ENumber, Result, Schema } from 'effect';
import {
	CollectionMutateRequest,
	CollectionQueryRequestFields,
	ApprovalState,
	ChatDocumentRef,
	HOST_AGENT_EXECUTE_CHILD_COMMAND,
	HOST_RECOVER_COMMAND,
	HOST_SCHEDULE_DISCOVER_COMMAND,
	HOST_SCHEDULE_SETTLE_COMMAND,
	HostAgentExecuteChildRequest,
	HostScheduleDiscoverRequest,
	HostScheduleSettleRequest,
	SyncAdvanceRequest,
	SyncConnectRequest,
	EffectId,
	PluginTrustedContext,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { AutomationProgression } from '#lib/authoring/automations-schema.js';
import * as SystemPrincipal from '#lib/runtime/access/system-principal.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import {
	AI,
	Files,
	type AIInterface,
	type FilesInterface
} from '#lib/runtime/facilities/services.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Envoys from '#lib/runtime/envoys/envoys.js';
import { EnvoyDelivery } from '#lib/runtime/envoys/envoys.js';
import {
	automationPrincipalId,
	envoyPrincipalId,
	SEED_PRINCIPAL_ID
} from '#lib/runtime/identity/static-identity.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import * as Integrations from '#lib/runtime/integrations/integrations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { ADMIN_STATUS, Subject } from '#lib/runtime/identity/identity.js';
import * as Notifications from '#lib/runtime/notifications/notifications.js';
import { Notification } from '#lib/runtime/notifications/notifications.js';
import { RemoteRegistry, type RuntimeRemoteRegistry } from '#lib/runtime/remotes.js';
import * as WorkspaceSchema from '#lib/runtime/schema/workspace-schema.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import { Secrets, type Interface as SecretsInterface } from '#lib/runtime/secrets/secrets.js';
import * as Sync from '#lib/runtime/sync/sync.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import {
	AuthoredRuntimeService,
	guardAuthoringOps,
	makeAutomationApi,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler,
	type AuthoredRuntime
} from '#lib/runtime/collections/authored.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';

export { DispatchError } from '#lib/runtime/workspace.js';

const VisibleAppsInput = Schema.Struct({ subject: Subject });
const ImpersonateTeamInput = Schema.Struct({ actor: Subject, teamId: Schema.NonEmptyString });
/**
 * Both halves are minted by the boundary, never read from the payload.
 *
 * `actor` is the credential holder and `impersonatedTeam` is what the boundary resolved out of the
 * host's header — so this command reports the preview the runtime is *actually* running, not the one
 * a browser believes it asked for. A sidebar that trusted its own cookie would keep showing a team
 * as active after the runtime had refused it.
 */
const ImpersonationStateInput = Schema.Struct({
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String)
});
const ApprovalDecideInput = Schema.Struct({
	subject: Subject,
	state: ApprovalState,
	decision: Schema.Literals(['approve', 'reject', 'request_changes', 'supersede']),
	reason: Schema.optionalKey(Schema.String)
});
const AuthenticatedSyncConnect = Schema.Struct({
	subject: Subject,
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String),
	...SyncConnectRequest.fields
});
/** Only a verified host principal may submit opaque credentials for batched advance. */
const AuthenticatedSyncAdvance = Schema.Struct({
	subject: Subject,
	...SyncAdvanceRequest.fields
});
const AuthenticatedHostScheduleDiscover = Schema.Struct({
	subject: Subject,
	...HostScheduleDiscoverRequest.fields
});
const AuthenticatedHostScheduleSettle = Schema.Struct({
	subject: Subject,
	...HostScheduleSettleRequest.fields
});
const AuthenticatedHostAgentExecuteChild = Schema.Struct({
	subject: Subject,
	...HostAgentExecuteChildRequest.fields
});

const AgentEnqueueInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	message: Schema.String,
	/** Caller-selected host model; absent means the catalog default. */
	model: Schema.optionalKey(Schema.NonEmptyString)
});
const AgentDocumentBindInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	file: ChatDocumentRef
});
const AgentDocumentInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	storageKey: Schema.NonEmptyString
});
const CollectionFindInput = Schema.Struct({
	subject: Subject,
	...CollectionQueryRequestFields
});
const SecretsWriteInput = Schema.Struct({
	subject: Subject,
	name: Schema.NonEmptyString,
	value: Schema.String
});
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const DataBrowserInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Struct({ limit: Schema.optionalKey(Schema.Number) }))
});
const RateLimitAddressInput = Schema.Struct({
	address: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String)
});
const decodeJsonObject = Schema.decodeUnknownResult(JsonObject);
/**
 * What a host may still assert once it has proved who it is, which is only ever *less* authority.
 *
 * This used to carry `subject`, `roles`, `teams` and `impersonatedUser` as well, and the branch below
 * minted a subject straight out of them whenever `subject` was absent — so
 * `POST /_bolt/plugin/data-browser/query` with `{"trustedContext":{"roles":["admin"]}}` read any
 * collection in the tenant, unauthenticated. Those four fields are gone rather than checked: a
 * credential names a session row, and that row's roles are the answer, so there was nothing for the
 * payload's copy to do except be believed. `impersonatedSubject` survives because it narrows rather
 * than widens — `AccessControl.impersonate` still has to authorize the authenticated actor for it.
 */
/** The protocol mutation body plus the subject minted from the authenticated credential. */
const AuthenticatedCollectionMutation = Schema.Struct({
	subject: Subject,
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String)
});
const CollectionMutation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json)
});
const CollectionImportInput = Schema.Struct({
	subject: Subject,
	records: Schema.Array(CollectionMutation)
});
/**
 * What a caller may say when starting an automation: which one, and what to hand it.
 *
 * No `subject`, and its absence is the point. It used to carry one — so the automation ran with
 * whatever authority the caller held, and an administrator tripping a nightly close ran it as an
 * administrator. An automation's authority is the policies its own declaration names, minted at the
 * enqueue point by `Automations.start`.
 */
const AutomationStartInput = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.Json
});
/** A lifecycle action names both the declared automation and one of its durable task ids. */
const AutomationLifecycleInput = Schema.Struct({
	name: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
/**
 * What a host may say about a message it took off a transport.
 *
 * `subject` is gone from this input and its absence is the point. It was a `Subject` the caller
 * supplied, which made the identity of an envoy turn something outside the runtime decided — and on
 * a `Command` the boundary overwrites `subject` from the credential anyway, so a host relaying a
 * WhatsApp message could only ever have run the turn as *itself*, an administrator. `Envoys.receive`
 * mints the subject from the release's own declarations now; the host supplies the wire's facts and
 * nothing about authority.
 */
const EnvoyReceiveInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	delivery: EnvoyDelivery
});
const EnvoyDrainInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const EnvoyCompleteInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	progressKey: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
});
/**
 * `binding` is what a scheduled pull carries and an enqueued one does not.
 *
 * The registration `activate` hands the host names one binding, because that is the granularity a
 * `+integrations.ts` cron is declared at; `install` and `reconcile` enqueue without it and mean
 * "every binding this integration has".
 */
const IntegrationPullInput = Schema.Struct({
	name: Schema.NonEmptyString,
	cursor: Schema.Json,
	binding: Schema.optionalKey(Schema.NonEmptyString)
});
const TaskInput = Schema.Struct({
	taskId: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
/** The task payload an authored automation runs from: the runtime's trigger context and the subject the runtime stamped at enqueue time. */
const AutomationTaskInput = Schema.Struct({
	// An authored input is any schema, not only a struct. The queue preserves the decoded JSON value
	// whole and the automation's own schema narrows it immediately before the handler runs.
	args: Schema.Json,
	scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	bolt_run_as: Subject,
	bolt_depth: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	),
	/** Injected by the trusted task runner, never accepted from the enqueue payload. */
	bolt_task_id: Schema.NonEmptyString
});
type AutomationTaskInputValue = Schema.Schema.Type<typeof AutomationTaskInput>;
const AgentOpenInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentLaneInput = Schema.Struct({ subject: Subject, conversationId: Schema.NonEmptyString });
const AgentVerifierInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	verifier: Schema.Json
});
const ApprovalStatusInput = Schema.Struct({
	subject: Subject,
	requestId: Schema.NonEmptyString
});
const ApprovalRequestIdInput = Schema.Struct({ requestId: Schema.NonEmptyString });
const ApprovalWithdrawInput = Schema.Struct({ subject: Subject, state: ApprovalState });
const EnvoyNameInput = Schema.Struct({ envoy: Schema.NonEmptyString });
/**
 * `input` is optional because the drain's own registration does not carry one.
 *
 * A scheduled flush means "empty this integration's outbox"; the only thing a caller may narrow is
 * how much of it to attempt in one invocation. It cannot name a delivery — a caller that could
 * would be a caller who can replay one.
 */
const IntegrationFlushInput = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
const IdentityContinueSessionInput = Schema.Struct({
	email: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	subject: Subject
});
const IdentitySendCodeInput = Schema.Struct({ email: Schema.NonEmptyString });
const IdentityAdmitFounderInput = Schema.Struct({
	email: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString
});
/**
 * Admitting the first administrator *and* starting their session, in one invocation.
 *
 * `claimId` is the id of a proof the host holds — Colony verified that whoever is completing this
 * signup controls `email` — and it is carried here for exactly one purpose: so this command can
 * refuse to act on the same proof twice. Bolt does not check that proof and could not; what it
 * checks is that the invocation came from the host, and that this particular claim is unspent.
 */
const IdentityBootstrapFounderInput = Schema.Struct({
	email: Schema.NonEmptyString,
	claimId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	subject: Subject
});
const IdentityVerifyCodeInput = Schema.Struct({
	email: Schema.NonEmptyString,
	code: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString
});

/**
 * The only commands reachable without a credential.
 *
 * Sign-in cannot require a session; producing one is what it is for. The exemption is stated here,
 * at the gate, as a closed set of exactly two names — not as a `case` that quietly skips the check.
 * Five `schema.*` commands each shipped unguarded because the check was per-case, and the comment
 * below the schema prefix gate says so; this is the same lesson applied in the other direction.
 *
 * Neither command answers anything about an address the caller did not supply, and neither reveals
 * whether an address is already known, so an unauthenticated caller learns nothing from either.
 * Rate limiting and bot checks are the host's: a bolt cannot see the request rate of a surface it
 * does not serve.
 */
const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set(['identity.sendCode', 'identity.verifyCode']);
const IdentitySettingsInput = Schema.Struct({ tenantId: Schema.NonEmptyString });
const IdentityAuthenticateInput = Schema.Struct({ credential: Schema.NonEmptyString });
const CollectionRecordInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString
});

/** Owns wire decoding, JSON responses, and credential extraction shared by every invocation kind. */
const DispatchValues = {
	decode: <S extends Schema.Top>(schema: S, value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() =>
					new DispatchError({
						code: 'invalid_input',
						message: 'Command input did not match its schema'
					})
			)
		),
	json: (value: Schema.Json): DispatchResponse => ({ status: 200, headers: {}, value }),
	/**
	 * Projects one record to the JSON a wire shape accepts.
	 *
	 * A Json boundary has no `undefined` — a key the caller left absent is a key that does not exist.
	 * Collecting the optional fields first and dropping their absent values here keeps the wire shape
	 * honest instead of rebuilding it field-by-field at every caller.
	 */
	jsonObject: (
		entry: Readonly<Record<string, Schema.Json | undefined>>
	): Readonly<Record<string, Schema.Json>> => {
		const value: Record<string, Schema.Json> = {};
		for (const [key, field] of Object.entries(entry)) {
			if (field !== undefined) value[key] = field;
		}
		return value;
	},
	// The page ceiling belongs to this boundary, not the collections service: a client asks for a
	// page, while an authored server-side handler asks for the exact rows its computation needs.
	collectionQuery: (input: typeof CollectionFindInput.Type) => ({
		collection: input.collection,
		limit: ENumber.clamp({ minimum: 1, maximum: 500 })(input.limit ?? 100),
		...(input.where === undefined ? {} : { where: input.where }),
		...(input.userFilter === undefined ? {} : { userFilter: input.userFilter }),
		...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
		...(input.with === undefined ? {} : { with: input.with }),
		...(input.search === undefined ? {} : { search: input.search }),
		...(input.after === undefined ? {} : { after: input.after })
		// Root `columns` is a read-time projection and therefore is not part of the service query.
		// Nested projections remain authored here; the authoritative page path removes them only from
		// its hydration read so the base store never receives a partial related row.
	}),
	/**
	 * The team this invocation asks to be viewed as, or `undefined`.
	 *
	 * The same `x-colony-impersonated-*` family the plugin path reads out of `trustedContext`, carried
	 * as a header because a `Command` has no `trustedContext` field — headers are already where it
	 * carries its credential, and a second channel would be a second thing to authenticate.
	 *
	 * Nothing here trusts the value. It names a policy the workspace itself declares, and
	 * `subjectAsTeam` grants it only after checking, against the subject this boundary just
	 * authenticated from the credential, that the actor holds `impersonator`.
	 */
	impersonatedTeamFromHeaders: (
		headers: Readonly<Record<string, ReadonlyArray<string>>>
	): string | undefined => {
		const value = Object.entries(headers)
			.find(([name]) => name.toLowerCase() === 'x-colony-impersonated-team')?.[1][0]
			?.trim();
		return value === undefined || value === '' ? undefined : value;
	},
	credentialFromHeaders: (
		headers: Readonly<Record<string, ReadonlyArray<string>>>
	): string | undefined => {
		const authorization = Object.entries(headers).find(
			([name]) => name.toLowerCase() === 'authorization'
		)?.[1][0];
		if (authorization !== undefined) return authorization.replace(/^Bearer\s+/i, '');
		const cookie = Object.entries(headers)
			.find(([name]) => name.toLowerCase() === 'cookie')?.[1]
			.join(';');
		return cookie
			?.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith('bolt_session='))
			?.slice('bolt_session='.length);
	}
};
const decode = DispatchValues.decode;

const json = DispatchValues.json;

/**
 * The authority a `schema.*` command requires, and the proof the caller holds it.
 *
 * These commands used to run for any authenticated subject in the tenant — and, on a `Task` or a
 * non-data-browser `Plugin` invocation, for no verified subject at all, because those tags carry
 * their input through untouched. `schema.migrate` opens a DDL transaction, so a tenant-wide
 * `create table` sat behind an ordinary employee's session token and behind an unauthenticated task
 * payload.
 *
 * `schema` is a named resource in the vocabulary `secrets` already uses, so an authored policy
 * grants it the way it grants everything else — `{ actions: ['read'], apps: ['schema'] }` — and the
 * admin policy the compiler always appends (`actions: ['*'], apps: ['*']`) covers it with no
 * template changing.
 *
 * Reading the plan is separated from applying it because they are different powers. `plan`,
 * `fingerprint`, `validate` and `verify` disclose the whole schema *unfiltered* — unlike
 * `workspace.manifest`, which drops the collections the subject may not read — while `migrate`
 * rewrites the database. `manage` is the default so that a sixth `schema.*` command added later is
 * gated as a mutation until somebody decides otherwise.
 */
const SCHEMA_RESOURCE = 'schema';
const SCHEMA_READ_COMMANDS: ReadonlySet<string> = new Set([
	'schema.plan',
	'schema.fingerprint',
	'schema.validate',
	'schema.verify'
]);
// Only a `Command` reaches here at all: `authorizeInvocationProvenance` has already refused the two
// credential-free tags, on which the `subject` this decodes would be whatever the payload claimed.
const authorizeSchemaCommand = Effect.fn('Bolt.authorizeSchemaCommand')(function* (
	command: string,
	commandInput: unknown
) {
	const action = SCHEMA_READ_COMMANDS.has(command) ? 'read' : 'manage';
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	yield* (yield* AccessControl.Service).authorize(input.subject, action, SCHEMA_RESOURCE);
});

const IDENTITY_RESOURCE = 'identity';
const authorizeFounderAdmission = Effect.fn('Bolt.authorizeFounderAdmission')(function* (
	commandInput: unknown
) {
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	yield* (yield* AccessControl.Service).authorize(input.subject, 'manage', IDENTITY_RESOURCE);
});

/**
 * Commands only the host may run, checked against the subject rather than against a policy.
 *
 * `identity.bootstrapFounder` is deliberately not authorized like
 * `admitFounder`, and the difference is the whole reason this set exists. `admitFounder` writes a
 * row; this one writes a row and hands back a **live session credential** for the address it was
 * given. Gated on `manage`/`identity`, any existing administrator could therefore POST it an
 * arbitrary address and receive a working session as that person — which is a strictly worse
 * primitive than the unchecked `admitFounder` that made the admission gate necessary in the
 * first place.
 *
 * `subject.system` is the narrower thing to gate on because it has exactly one constructor:
 * `SystemPrincipal.systemSubject`, minted only after `verifySystemSignature` accepts a digest over
 * the timestamp, the command, the tenant and the arguments. It cannot be decoded from a payload —
 * `subject` is a `MINTED_IDENTITY` field, refused on every other path — so there is no route from a
 * row, a cookie or an authored policy to holding it. An administrator is not enough, and an
 * administrator being not enough is the point.
 */
const SYSTEM_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	'identity.bootstrapFounder',
	'identity.continueSession',
	/**
	 * The inbound envoy port, which would otherwise be the widest hole in this runtime.
	 *
	 * `envoys.receive` decodes no `Subject` — it mints one from the envoy's declared policies — and
	 * that is exactly what makes this entry necessary. A command that names no identity is a command
	 * the credential path admits without one, so without this line anybody who could reach the port
	 * could post a JSON body and make a workspace's agent run a turn, under that envoy's authority,
	 * against that workspace's data. The sender address in the payload is attacker-chosen, so they
	 * could also choose *whose* assignments the turn narrowed to.
	 *
	 * Gating it on the gateway signature is the honest expression of what an envoy message is: proof
	 * that a message came from WhatsApp requires WhatsApp's credential, which the tenant does not
	 * hold, so the host authenticates the wire and says so with a signature over the timestamp, the
	 * command, the tenant and the arguments. Nothing else can assert that a message arrived.
	 */
	'envoys.receive',
	/**
	 * The live update path. It evaluates probes and patches under each subscription's own stored
	 * credential, so what a connection receives is exactly what its subject's policy surface
	 * admits. Host-invocable because the pump calls it per commit batch, with the connections'
	 * opaque credentials riding the request for the guest to authenticate afresh.
	 */
	'sync.advance',
	HOST_RECOVER_COMMAND,
	HOST_SCHEDULE_DISCOVER_COMMAND,
	HOST_SCHEDULE_SETTLE_COMMAND,
	HOST_AGENT_EXECUTE_CHILD_COMMAND,
	/**
	 * Fills in record embeddings a bulk write could not.
	 *
	 * Host-authenticated: it is called after a seed, spends provider credit, and belongs to the
	 * deployment rather than to any workspace's authority model.
	 */
	'collections.embed'
]);

/** The prefix a spent founder claim is filed under, so it cannot collide with a sign-in code's row. */
const FOUNDER_CLAIM_IDENTIFIER = 'founder-claim:';

/**
 * How long a spent claim stays on the ledger: a day, against a signature that is stale in five
 * minutes.
 *
 * The number only has to exceed `SIGNATURE_LIFETIME_MILLIS`, because after that a replayed
 * invocation is refused by arithmetic and needs no row to refuse it. A day is that with three
 * orders of magnitude of headroom for clock skew and for a founder who left the tab open.
 */
const FOUNDER_CLAIM_LEDGER_MILLIS = 86_400_000;

const authorizeSystemCommand = Effect.fn('Bolt.authorizeSystemCommand')(function* (
	command: string,
	commandInput: unknown
) {
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	if (input.subject.system === true) return;
	return yield* new AccessControl.AccessDenied({
		action: 'manage',
		resource: command,
		reason: `${command} is reachable only by the host proving itself per invocation; an administrator's own authority is not enough`
	});
});

/**
 * The commands the runtime enqueues for itself, which is the whole of what a `Task` may run.
 *
 * A durable task is a message the runtime posted to itself and the host handed back; nothing about
 * the message proves that, because a `Task` carries no credential and never did. What can be checked
 * is the other end: whether this command is one the runtime ever enqueues. Everything here is
 * addressed by a name the workspace declared or by a record the runtime already wrote, and none of
 * it takes an identity — `integrations.pull`/`flush` and `automations.<name>` are the runtime's own
 * machinery, while `collections.resume` takes `{ requestId }` and derives its authority from the
 * stored approval:
 * `Collections.resume` refuses a request that is not `Approved` and replays the write under the
 * subject recorded when the original create was authenticated.
 *
 * `automations.<name>` is resolved against the declared automations rather than matched on the
 * prefix, because `automations.start`, `.register` and `.stop`
 * share it and are host commands rather than enqueued ones.
 */
const ENQUEUED_COMMANDS: ReadonlySet<string> = new Set([
	'integrations.pull',
	'integrations.flush',
	'envoys.drain',
	'envoys.complete',
	'collections.resume',
	'collections.discard',
	// Better Auth persists a sign-in challenge, then posts this private courier task. It carries no
	// caller identity and can only deliver the exact code/address pair the runtime stored in the row.
	Identity.DELIVER_CODE_COMMAND
]);

/**
 * Which invocation tags may reach the command switch, and on what authority.
 *
 * `POST /_bolt/plugin/<anything>/<command>` builds a `Plugin` invocation out of a URL and a request
 * body with no authentication anywhere, and a `Task` carries no credential by construction. Both
 * handed their input to the switch untouched, so the switch was a second, unauthenticated command
 * port. The provenance gate now defaults both tags to deny and admits only commands the runtime
 * itself enqueues.
 *
 * So the gate is default-deny and it is one gate, at the point where a credential is turned into a
 * subject rather than in the thirty-eight cases that lacked one: a `Plugin` gets the plugin surface
 * (`data-browser`, resolved above from its host-supplied context) and nothing else, and a `Task`
 * gets exactly what the runtime enqueues. A case added tomorrow is refused on both tags until
 * somebody enqueues it — the opposite polarity to the per-command list that let five `schema.*`
 * commands each ship without a check.
 */
/**
 * Whether a command belongs to a set the runtime enqueues, resolving authored automations by name.
 *
 * `automations.<name>` is checked against the declared automations rather than matched on the
 * prefix, because lifecycle commands share it and are not enqueued turns.
 */
const isRunnable = Effect.fn('Bolt.isRunnable')(function* (
	command: string,
	allowed: ReadonlySet<string>
) {
	if (allowed.has(command)) return true;
	return (yield* Workspace.Service).definition.automations.some(
		({ name }) => `automations.${name}` === command
	);
});

const authorizeInvocationProvenance = Effect.fn('Bolt.authorizeInvocationProvenance')(function* (
	tag: Invocation['_tag'],
	command: string
) {
	const enqueued = tag === 'Task' && (yield* isRunnable(command, ENQUEUED_COMMANDS));
	if (!enqueued) {
		yield* new AccessControl.AccessDenied({
			action: 'invoke',
			resource: command,
			reason: `a ${tag} invocation carries no credential, and ${command} is not a command the runtime enqueues`
		});
	}
});

/**
 * The identity fields this boundary mints, and why a payload may never supply one.
 *
 * On a `Command` the fields below are overwritten with values derived from an authenticated
 * credential, so whatever the input claimed about who it is has already been discarded before any
 * case reads it. A `Task` carries no credential, and a non-data-browser `Plugin` is an
 * unauthenticated `POST /_bolt/plugin/<anything>/<command>` — both hand their input to the switch
 * untouched, so on those tags these keys are claims rather than facts. Every case that decodes
 * `subject: Subject` then authorises that claim. The boundary therefore refuses minted identity
 * fields on credential-free invocations before any command-specific decoder runs.
 *
 * So the refusal lives where identity is minted, once, rather than in the cases that consume it: a
 * per-case check is exactly what let five `schema.*` commands each ship without one, and the next
 * case to decode a `Subject` would have shipped without one too.
 *
 * It still earns its place behind `authorizeInvocationProvenance`, which now refuses every command a
 * credential-free tag has no business running: what survives that gate is the enqueued set, and
 * `automations.<name>` forwards its whole input to an authored automation. Without this, a task
 * payload could smuggle a subject in through that input.
 */
const MINTED_IDENTITY = [
	'subject',
	'actor',
	'tenantId',
	'impersonatedTeam',
	/**
	 * The policies a subject holds directly, which only a *declaration* may name.
	 *
	 * It is here for the same reason `system` is refused on `Subject` itself: a static identity's
	 * authority is the policies its declaration named, and if a payload could carry the field then the
	 * answer to "what can a stranger do to my database?" would stop being "read the envoy declaration"
	 * and start being "whatever they typed". There is no row that produces one either, so a subject
	 * holding policies directly is one this runtime minted and nothing else.
	 */
	'policies'
] as const;

/**
 * Exported for the boundary test.
 *
 * This function has silently dropped a query field twice — `where`/`orderBy` once, then `with` —
 * because it rebuilds the query field by field, so anything not explicitly listed disappears
 * without an error anywhere. The test asserts every field survives the crossing.
 */
export const collectionQuery = DispatchValues.collectionQuery;
const credentialFromHeaders = DispatchValues.credentialFromHeaders;
const impersonatedTeamFromHeaders = DispatchValues.impersonatedTeamFromHeaders;

type DispatchServices =
	| AccessControl.Interface
	| Agents.Interface
	| AIInterface
	| Approvals.Interface
	| AuthoredRuntime
	| Automations.Interface
	| Collections.Interface
	| Envoys.Interface
	| FilesInterface
	| Identity.Interface
	| Integrations.Interface
	| Notifications.Interface
	| RateLimits.Interface
	| RuntimeRemoteRegistry
	| SecretsInterface
	| Sync.Interface
	| TaskQueue.Interface
	| TenantScope.Interface
	| Workspace.Interface
	| WorkspaceSchema.Interface;

export const dispatchInvocation: (
	invocation: Invocation
) => Effect.Effect<DispatchResponse, unknown, DispatchServices> = Effect.fn('Bolt.dispatch')(
	function* (invocation: Invocation) {
		if (invocation._tag === 'Request') {
			if (new URL(invocation.url, 'http://bolt.invalid').pathname === '/health')
				return json({ status: 'ok' });
			const credential = credentialFromHeaders(invocation.headers);
			if (credential === undefined || credential === '')
				return yield* new DispatchError({
					code: 'unauthorized',
					message: 'Missing authorization credential'
				});
			const identity = yield* Identity.Service;
			const subject = yield* identity.authenticate(EffectId.make(invocation.id), credential);
			if (subject.tenantId !== invocation.scope.tenantId)
				return yield* new DispatchError({
					code: 'tenant_mismatch',
					message: 'Authenticated subject is outside the invocation tenant'
				});
			const access = yield* AccessControl.Service;
			return json({ subject, apps: access.visibleApps(subject) });
		}
		if (invocation._tag === 'Realtime') {
			if (invocation.event._tag === 'Open')
				return { status: 200, headers: {}, realtime: { frames: [], nextCursor: '0' } };
			if (invocation.event._tag === 'Input') {
				const cursor = String(invocation.event.frame.sequence);
				return {
					status: 200,
					headers: {},
					realtime: {
						frames: [
							{ cursor, kind: invocation.event.frame.kind, bytes: invocation.event.frame.bytes }
						],
						nextCursor: cursor
					}
				};
			}
			return {
				status: 200,
				headers: {},
				realtime: {
					frames: [],
					...(invocation.event._tag === 'Close' || invocation.event._tag === 'Cancel'
						? {
								close: {
									code: invocation.event._tag === 'Close' ? invocation.event.code : 1000,
									reason: invocation.event.reason
								}
							}
						: {})
				}
			};
		}
		if (
			invocation._tag !== 'Command' &&
			invocation._tag !== 'Plugin' &&
			invocation._tag !== 'Task'
		) {
			return yield* new DispatchError({
				code: 'unsupported_invocation',
				message: 'Unsupported Bolt invocation'
			});
		}
		const effectId = EffectId.make(invocation.id);
		if (invocation._tag === 'Plugin' && invocation.plugin === 'data-browser') {
			if (invocation.command !== 'query')
				return yield* new DispatchError({
					code: 'unknown_plugin_command',
					message: `Unknown Data Browser command: ${invocation.command}`
				});
			const input = yield* decode(DataBrowserInput, invocation.input);
			const context = yield* Schema.decodeUnknownEffect(PluginTrustedContext)(
				invocation.trustedContext
			);
			// The same credential the `Command` path reads, authenticated the same way, because the Data
			// Browser is a read of tenant data and there is no weaker thing it could be. Refused when it is
			// absent rather than downgraded to an empty role set: a silent empty result reads as "this
			// workspace has no rows" and sends the operator looking for the wrong fault.
			const credential = credentialFromHeaders(invocation.headers);
			if (credential === undefined || credential === '') {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: input.collection,
					reason:
						'a Plugin invocation must present a credential before its trustedContext is honoured'
				});
			}
			const identity = yield* Identity.Service;
			const actor = yield* identity.authenticate(effectId, credential);
			if (actor.tenantId !== invocation.scope.tenantId)
				return yield* new DispatchError({
					code: 'tenant_mismatch',
					message: 'Plugin actor is outside the invocation tenant'
				});
			const subject = yield* Effect.gen(function* () {
				if (context.impersonatedSubject === undefined) return actor;
				const target = yield* identity.resolveSubject(
					effectId,
					'colony',
					context.impersonatedSubject
				);
				if (target.tenantId !== invocation.scope.tenantId)
					return yield* new DispatchError({
						code: 'tenant_mismatch',
						message: 'Plugin target is outside the invocation tenant'
					});
				return yield* (yield* AccessControl.Service).impersonate(actor, target);
			});
			const collections = yield* Collections.Service;
			const limit = input.input?.limit;
			// The *effective* subject, which on an impersonated query is the target and not the actor.
			// A facility is being told who this read is on behalf of, and the whole content of an
			// impersonated read is that it is on behalf of somebody else — an operator opening a member's
			// rows must see that member's per-user state, not their own. The actor is not lost: the subject
			// `impersonate` returns carries `impersonatedBy`, and the audit row it writes names them.
			return json(
				yield* Effect.provideService(
					collections.findMany(effectId, subject, {
						collection: input.collection,
						limit
					}),
					Identity.CurrentSubject,
					subject
				)
			);
		}
		const authenticated = yield* Effect.gen(function* () {
			const fields = Result.getOrElse(decodeJsonObject(invocation.input), () => ({}));
			if (invocation._tag !== 'Command') {
				yield* authorizeInvocationProvenance(invocation._tag, invocation.command);
				// Refused, not stripped: a payload that names a subject is asking to run as somebody, and
				// answering `invalid_input` would report that as a malformed request rather than as the claim
				// it is. A task that names nobody passes here and fails to decode in its own case, which is
				// the same refusal by the schema each case already declares.
				const claimed = MINTED_IDENTITY.find((name) => name in fields);
				if (claimed !== undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'authenticate',
						resource: invocation.command,
						reason: `a ${invocation._tag} invocation carries no credential, so the ${claimed} its payload claims is refused`
					});
				}
				// Nobody is behind a `Task` or a bare `Plugin`, so it carries no subject and nothing is
				// provided below — a facility called from here sees the same absence the runtime does.
				return { input: invocation.input, subject: undefined };
			}
			// Checked before the credential is demanded, because a person signing in has none yet.
			//
			// The tenant is minted here rather than left out. A bolt serves exactly one workspace, so which
			// tenant a sign-in belongs to is a fact the invocation already carries — and the alternative was
			// not "no tenant" but a broken flow: Better Auth admits the address, the user row lands with a
			// null `tenantId`, and the credential it hands back fails `authenticate` as malformed on its
			// very first use. Nothing else set that column; `startSession` does, but it needs the working
			// credential this is supposed to produce, and `acceptInvitation` never touched it.
			//
			// It comes from `invocation.scope`, never from the payload, which is what `tenantId` being a
			// `MINTED_IDENTITY` field means — so the refusal below is the same one the credential-free tags
			// get, for the same reason. Whether an address may reach this command at all is the host's
			// question, answered in front of the forward by whatever gates the host puts there.
			if (SIGN_IN_COMMANDS.has(invocation.command)) {
				const claimed = MINTED_IDENTITY.find((name) => name in fields);
				if (claimed !== undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'authenticate',
						resource: invocation.command,
						reason: `a sign-in carries no credential, so the ${claimed} its payload claims is refused`
					});
				}
				return { input: { ...fields, tenantId: invocation.scope.tenantId }, subject: undefined };
			}
			/**
			 * The host, provisioning a workspace nobody belongs to yet.
			 *
			 * Checked before the credential is demanded, for the same structural reason a sign-in is: there
			 * is nobody to hold a credential. A freshly created database has no tables, so it has no
			 * `user` to be an administrator in and no `session` to authenticate
			 * against — and `schema.migrate` is the command that would create both. The authority to break
			 * that deadlock cannot come from the workspace's own membership.
			 *
			 * What it comes from instead is possession of `COLONY_GATEWAY_SECRET`, proved per invocation
			 * over the timestamp, the command, the tenant and the arguments. The subject that produces is
			 * an ordinary one carrying one role, and `COLONY_SYSTEM_POLICY` — merged into every workspace
			 * definition by `withSystemCollections` — is what that role matches. So this is not a branch
			 * that skips access control; it is the only constructor for one particular subject, which then
			 * goes through `decide` like everybody else and is refused everything the policy does not
			 * enumerate.
			 *
			 * The previous arrangement is what this replaces, rather than joins: the host used to write a
			 * `user` row and a `session` row straight into the tenant database over
			 * `pg`, then hand bolt the token. That made provisioning authority a *row* — created before it
			 * was needed, deleted afterwards if nothing crashed, and indistinguishable at the point of
			 * decision from a person's. Nothing is written here and nothing needs revoking; the authority
			 * exists for the length of one invocation and the signature that carries it is stale in five
			 * minutes.
			 *
			 * Logged rather than audited, and deliberately: `bolt_audit` is a table that does not exist yet
			 * during the migration this authorises, so a row would fail exactly when it mattered most. The
			 * line names `colony system` so an operator reading "who migrated this schema" sees the host and
			 * not a person; anything downstream that records a subject id records `colony-system` too.
			 */
			if (
				yield* SystemPrincipal.verifySystemSignature({
					headers: invocation.headers,
					command: invocation.command,
					tenantId: invocation.scope.tenantId,
					input: invocation.input,
					now: yield* Clock.currentTimeMillis
				})
			) {
				// Annotated rather than inferred, so the absence of `admin` is checked here rather than
				// discovered downstream: a system principal that ever gained that key would short-circuit
				// `decide`, `rowPredicate` and `visibleApps` and stop being the enumerated thing it is.
				const subject: Subject = SystemPrincipal.systemSubject(invocation.scope.tenantId);
				yield* Effect.log(
					`bolt.dispatch: ${invocation.command} authorized as colony system for ${invocation.scope.tenantId}`
				);
				// The same minting the credential path does, so no payload field survives to be read as
				// identity. `actor` is the system principal itself: nobody is impersonating anybody, and a
				// preview header is dropped rather than honoured — `subjectAsTeam` refuses a non-administrator
				// anyway, and a system principal must never be narrowed into a workspace role.
				return {
					input: {
						...fields,
						subject,
						actor: subject,
						tenantId: invocation.scope.tenantId,
						impersonatedTeam: null
					},
					subject
				};
			}
			const credential = credentialFromHeaders(invocation.headers);
			if (credential === undefined || credential === '')
				return yield* new DispatchError({
					code: 'unauthorized',
					message: 'Missing command credential'
				});
			const actor = yield* (yield* Identity.Service).authenticate(effectId, credential);
			if (actor.tenantId !== invocation.scope.tenantId)
				return yield* new DispatchError({
					code: 'tenant_mismatch',
					message: 'Authenticated subject is outside the invocation tenant'
				});
			/**
			 * The one place a team preview changes what this invocation is.
			 *
			 * It substitutes the *subject* rather than filtering any particular answer, which is the whole
			 * point: `visibleApps` decides what the sidebar offers, but the row predicate is what decides
			 * whether a read is served, and both read the subject's team. Narrowing the subject once here moves
			 * every decision below together — the ninety-odd cases in `runCommand`, the collection predicates,
			 * the field masks — so there is no path where the navigation hides an app the runtime would still
			 * serve rows for.
			 *
			 * `actor` stays the real credential holder. `subject` is who the command runs as, `actor` is who
			 * is really here, and the audit trail and `access.impersonation`'s own answer both need the
			 * second — an admin previewing `Employee` must still be told they may impersonate, or
			 * the picker disappears and there is no way back.
			 *
			 * `impersonatedTeam` is minted unconditionally, as `null` when there is no preview, so a payload
			 * claiming one is overwritten in both directions rather than only while a preview is running.
			 */
			const team = impersonatedTeamFromHeaders(invocation.headers);
			const subject =
				team === undefined
					? actor
					: yield* (yield* AccessControl.Service).subjectAsTeam(actor, team);
			return {
				input: {
					...fields,
					subject,
					actor,
					tenantId: actor.tenantId,
					impersonatedTeam: team ?? null
				},
				subject
			};
		});
		/**
		 * Who the facilities are told this invocation is acting for.
		 *
		 * Provided once around the whole command body rather than threaded through the services under it,
		 * because the alternative is a parameter on every facility method and a decision, per call site,
		 * about what to pass — which is how a facility ends up seeing tenant and environment and nothing
		 * finer. `invokeBinding` reads it back out of the Effect context, so a per-user secret or a
		 * signed-in browser session finally has a key to be stored under.
		 *
		 * The value is the one `authenticate` returned above and nothing else. The payload's own
		 * `subject` was already overwritten before this point — that is what `MINTED_IDENTITY` is for —
		 * so there is no route from a request body to what a facility is told. A credential-free tag
		 * reaches here with `subject: undefined` and provides nothing, leaving `currentSubject` `None`
		 * rather than a fabricated stand-in a facility would have to learn to distrust.
		 */
		/**
		 * The workspace's own rate policy, applied after identity is settled and before the command runs.
		 *
		 * Here rather than at the edge because this is the first point at which the three facts a real
		 * limit is written in terms of all exist: which command was called, which tenant it belongs to,
		 * and who is behind it. A reverse proxy sees none of them — behind Traefik it does not reliably
		 * see even the client IP, which is how one Colony bucket keyed on `getClientAddress()` came to be
		 * shared by every visitor to the host.
		 *
		 * After authentication, so a signed-in person is counted as themselves rather than pooled with
		 * every other anonymous caller; before the command body, so a refusal costs a map lookup rather
		 * than the work it was protecting.
		 */
		yield* (yield* RateLimits.Service).admit(
			invocation.command,
			{
				tenantId: String(invocation.scope.tenantId),
				userId: authenticated.subject?.userId,
				...(rateLimitAddress(invocation.input) === undefined
					? {}
					: { address: rateLimitAddress(invocation.input) as string })
			},
			// The holder's own budget, resolved from the policies they hold. It is passed in rather than
			// looked up inside the limiter for the reason the limiter states: it counts, and something
			// that already knows who holds what decides which rule to count against.
			authenticated.subject === undefined
				? undefined
				: (yield* AccessControl.Service).limits(authenticated.subject)
		);
		const invoked = runCommand(invocation.command, effectId, authenticated.input);
		return yield* authenticated.subject === undefined
			? invoked
			: Effect.provideService(invoked, Identity.CurrentSubject, authenticated.subject);
	}
);

/**
 * The address a payload names, for a limit keyed on one.
 *
 * Read off the raw payload rather than a decoded one because it is needed before the command's own
 * schema has run — the point of an `address` limit is to bound anonymous traffic, and anonymous
 * traffic is exactly what has no subject to key on. Read defensively for the same reason: this is
 * untrusted input, and a payload that carries something other than a string simply keys on nothing
 * and shares the fallback bucket.
 *
 * It is a *key*, never an authorisation. Naming an address here says nothing about who the caller
 * is; it only decides which counter they spend from, and a caller who varies it is spending from a
 * fresh counter each time — which is why an address limit exists to protect what sending to that
 * address costs, and never to establish identity.
 */
const rateLimitAddress = (payload: unknown): string | undefined => {
	const decoded = Schema.decodeUnknownResult(RateLimitAddressInput)(payload);
	if (Result.isFailure(decoded)) return undefined;
	const value = decoded.success.address ?? decoded.success.email;
	return value === undefined || value.trim() === '' ? undefined : value;
};

/** Runs one authored automation body in the invocation that already owns it. */
const executeAutomationBody = Effect.fn('Bolt.executeAutomationBody')(function* (
	effectId: EffectId,
	name: string,
	input: AutomationTaskInputValue
) {
	const automation = (yield* AuthoredRuntimeService).automations[name];
	if (automation === undefined) {
		return yield* new DispatchError({
			code: 'unknown_command',
			message: `Unknown Bolt automation: ${name}`
		});
	}
	const collections = yield* Collections.Service;
	const ai = yield* AI.Service;
	const files = yield* Files.Service;
	const automations = yield* Automations.Service;
	const guard = Automations.stoppageGuard(automations, effectId, input.bolt_task_id);
	const ops = guardAuthoringOps(
		makeBoundAuthoringOps(
			effectId,
			input.bolt_run_as,
			collections,
			ai,
			files,
			automations,
			(name, nestedInput, options) =>
				collections.runAutomation(
					effectId,
					name,
					nestedInput,
					{},
					{
						...options,
						...(input.bolt_depth === undefined ? {} : { parentDepth: input.bolt_depth })
					}
				)
		),
		guard
	);
	const api = makeAutomationApi(makeAuthoringApi(ops), (value) =>
		guard('progress').pipe(
			Effect.andThen(Schema.decodeUnknownEffect(AutomationProgression)(value)),
			Effect.flatMap((progression) =>
				automations.progress(effectId, input.bolt_task_id, progression)
			)
		)
	);
	const args = yield* decode(automation.input ?? Schema.Json, input.args);
	const output = yield* runAuthoredHandler(() =>
		automation.handler(api, { args, scope: input.scope ?? {} })
	);
	const declaredOutput = yield* decode(automation.output ?? Schema.Unknown, output);
	return yield* decode(Schema.Json, declaredOutput);
});

/** Claims and runs an immediate automation without handing its body to the scheduler. */
const executeDirectAutomation = Effect.fn('Bolt.executeDirectAutomation')(function* (
	effectId: EffectId,
	name: string,
	taskId: string
) {
	return yield* (yield* Automations.Service).execute(
		effectId,
		name,
		taskId,
		(raw, attemptEffectId) =>
			Effect.gen(function* () {
				const input = yield* decode(AutomationTaskInput, {
					...(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}),
					bolt_task_id: taskId
				});
				return yield* executeAutomationBody(EffectId.make(attemptEffectId), name, input);
			})
	);
});

/**
 * Everything a command does once its identity is settled, which is why it is a function.
 *
 * The switch used to be the tail of `dispatchInvocation`, and there was nowhere to stand between
 * "the credential has been checked" and "the command runs" — authentication happens inside the
 * block that builds the command input. Splitting the body out gives the subject a scope to be
 * provided over, so a facility called from any of the ninety-odd cases below carries it without
 * one of them being edited.
 */
const runCommand = Effect.fn('Bolt.runCommand')(function* (
	command: string,
	effectId: EffectId,
	commandInput: unknown
) {
	if (command.startsWith('invoke.')) {
		const values = yield* decode(
			Schema.Struct({ subject: Subject, input: Schema.Json }),
			commandInput
		);
		return json(
			yield* (yield* RemoteRegistry).invoke(
				command.slice('invoke.'.length),
				values.input,
				values.subject,
				effectId
			)
		);
	}
	// Gated before the switch, not case by case: the five schema commands were each written without a
	// check, and one gate on the prefix is the only form a sixth cannot be added past.
	if (command.startsWith('schema.')) yield* authorizeSchemaCommand(command, commandInput);
	if (command === 'identity.admitFounder') yield* authorizeFounderAdmission(commandInput);
	if (SYSTEM_ONLY_COMMANDS.has(command)) yield* authorizeSystemCommand(command, commandInput);
	switch (command) {
		/**
		 * There is deliberately no `secrets.read`.
		 *
		 * A value never crosses this boundary: `status` reports which names are declared and whether
		 * each is set, and `write` stores one. Server-side code reads values through the service. A
		 * read command would be the single line that put every credential one fetch away from a
		 * browser, so it does not exist.
		 */
		case 'secrets.status': {
			const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
			yield* (yield* AccessControl.Service).authorize(input.subject, 'manage', 'secrets');
			const entries = yield* (yield* Secrets.Service).status(effectId);
			// Rebuilt field by field rather than passed through: whatever this boundary returns reaches a
			// browser, so the shape is written out here where it can be read, not inherited from a type.
			return json(
				entries.map((entry) =>
					DispatchValues.jsonObject({
						name: entry.name,
						label: entry.label,
						secret: entry.secret,
						configured: entry.configured,
						description: entry.description,
						default: entry.default,
						updatedAt: entry.updatedAt
					})
				)
			);
		}
		case 'secrets.write': {
			const input = yield* decode(SecretsWriteInput, commandInput);
			yield* (yield* AccessControl.Service).authorize(input.subject, 'manage', 'secrets');
			yield* (yield* Secrets.Service).write(
				effectId,
				input.name,
				input.value,
				input.subject.userId
			);
			return json({ saved: true, name: input.name });
		}
		case 'apps.visible': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			const access = yield* AccessControl.Service;
			return json({ apps: access.visibleApps(input.subject) });
		}
		/**
		 * What the sidebar needs to render the picker: may this actor impersonate, what may they
		 * become, and what are they right now.
		 *
		 * A command rather than something stamped onto the document, for the same reason `apps.visible`
		 * is one: the answer is this tenant's own `team` rows crossed with the credential's
		 * standing, and only the tenant runtime holds both.
		 */
		case 'access.impersonation': {
			const input = yield* decode(ImpersonationStateInput, commandInput);
			const access = yield* AccessControl.Service;
			// Awaited, because the teams are rows now rather than a projection of the policy list.
			const teams = yield* access.impersonationTeams();
			return json({
				isAdmin: access.mayImpersonate(input.actor),
				isActive: input.impersonatedTeam !== null,
				activeTeamIds: input.impersonatedTeam === null ? [] : [input.impersonatedTeam],
				teams
			});
		}
		/**
		 * Starting a preview, which is what writes the audit row.
		 *
		 * The host calls this once, before it stores the choice, so a refusal is reported where a person
		 * can see it rather than as every subsequent command failing. `subjectAsTeam` re-checks the same
		 * authority on every invocation afterwards — this is not the gate, it is the record.
		 */
		case 'access.impersonateTeam': {
			const input = yield* decode(ImpersonateTeamInput, commandInput);
			const access = yield* AccessControl.Service;
			const previewed = yield* access.impersonateTeam(input.actor, input.teamId);
			return json({ subject: previewed, apps: access.visibleApps(previewed) });
		}
		case 'access.explain': {
			const input = yield* decode(
				Schema.Struct({
					subject: Subject,
					action: Schema.NonEmptyString,
					resource: Schema.NonEmptyString
				}),
				commandInput
			);
			const access = yield* AccessControl.Service;
			const decision = access.explain(input.subject, input.action, input.resource);
			return json({ allowed: decision.allowed, reason: decision.reason });
		}
		case 'identity.authenticate': {
			const input = yield* decode(IdentityAuthenticateInput, commandInput);
			return json(yield* (yield* Identity.Service).authenticate(effectId, input.credential));
		}
		case 'identity.admitFounder': {
			const input = yield* decode(IdentityAdmitFounderInput, commandInput);
			/**
			 * The founder is an administrator, not a person holding every role at once.
			 *
			 * This used to derive `roles` from every policy the workspace declares, plus a synthetic
			 * `impersonator`. That made the first administrator simultaneously an employee, a
			 * supervisor, a manager and an HR controller — which is not a description of anybody, and
			 * which made their authority a function of the ladder: adding a policy changed what an
			 * administrator was, and anything that stopped supplying roles removed the workspace from
			 * them entirely. Administrative status is now explicit on their own row and bypasses
			 * authored access policy until an explicit team preview clears it.
			 *
			 * `roles` is therefore empty. There is nothing for it to hold: `admin` is not a role, and
			 * assigning the six real ones would be a lie about what this person does in the workspace.
			 *
			 * They are placed in no team, because administrator authority is not team membership.
			 *
			 * This used to *derive* a teams array by walking every policy, every grant and every approval
			 * step in the workspace and collecting each `approvers` name. A founder with no explicit
			 * tenant-data grant cannot raise an approval-gated record in the first place, and administrative
			 * status does not confer eligibility to decide one.
			 * With no team rows and no place to manage them, guessing was the only defence available.
			 *
			 * Teams are rows now and an operator puts people in them, so the guess goes. Immediately after
			 * provisioning the founder has the complete workspace; previewing a team intentionally replaces
			 * that bypass with the selected team's data and approval authority.
			 */
			// `tenantId` is stamped onto every command input from the invocation scope, never read from
			// the payload — so a caller cannot admit a founder into somebody else's workspace.
			const founderId = yield* (yield* Identity.Service).admit(
				effectId,
				input.tenantId,
				input.email,
				null,
				ADMIN_STATUS
			);
			return json({ admitted: true, userId: founderId, admin: true });
		}
		/**
		 * The founder, admitted and signed in, on the strength of a proof the host holds.
		 *
		 * ## What each side owns
		 *
		 * Colony proved an inbox. That proof is not an identity — no user, no session, no directory
		 * row — and Colony has no way to turn it into one, which is the property the whole split
		 * exists to preserve. This command is where the proven address becomes a person: `admit`
		 * writes the administrator row and `startSession` mints the credential, both inside the
		 * workspace that owns them. Bolt remains the only session issuer on the platform.
		 *
		 * Bolt does not verify the code, the challenge or the claim. It cannot — it never saw the
		 * mail. What it verifies is that the invocation is the *host*, proved per invocation by a
		 * signature over the timestamp, the command, the tenant and these arguments, and refused
		 * outright for everybody else by `SYSTEM_ONLY_COMMANDS`.
		 *
		 * `tenantId` is stamped from `invocation.scope`, never read from the payload, so a caller
		 * cannot bootstrap a founder into somebody else's workspace.
		 *
		 * ## The replay ledger, and what is deliberately not in it
		 *
		 * The ledger row records `claimId -> userId`. It does **not** record the credential, and that
		 * is a decision rather than an omission: a live session token at rest in a table of
		 * short-lived verification artifacts is a secret outliving the flow that made it. An
		 * idempotent retry therefore looks the founder up and mints a *fresh* session for them.
		 *
		 * The cost is that a retried call can leave more than one live session for the founder. That
		 * is accepted, not overlooked — same person, same tenant, same status, and sessions expire.
		 * Please do not "fix" it by storing the credential.
		 *
		 * `verification` is reused rather than a table added, because it already holds
		 * exactly this kind of thing and adding a collection would put a schema step in front of
		 * every existing tenant. Note what that reuse implies: Better Auth deletes every row whose
		 * `expires_at` has passed on each `findVerificationValue`, so this row is genuinely swept.
		 * That is harmless *because of the arithmetic*, and only because of it — a captured
		 * invocation is refused by `SIGNATURE_LIFETIME_MILLIS` five minutes after it was signed, so
		 * an expiry set well beyond that window means the ledger is always present for the entire
		 * period in which a replay is possible at all. Shortening the expiry below the signature
		 * lifetime would open exactly the hole this row closes.
		 */
		case 'identity.bootstrapFounder': {
			const input = yield* decode(IdentityBootstrapFounderInput, commandInput);
			const identity = yield* Identity.Service;
			const ledgerIdentifier = `${FOUNDER_CLAIM_IDENTIFIER}${input.claimId}`;
			const spentBy = yield* identity.readFounderClaim(effectId, ledgerIdentifier);
			if (spentBy !== undefined) {
				const [userId, ...rest] = spentBy.split(' ');
				const boundEmail = rest.join(' ');
				/**
				 * The same claim for a different address is a replay, and is refused.
				 *
				 * The same claim for the same address is the network having been retried, and is
				 * answered — with a new session for the founder already on the row, never by
				 * admitting anybody a second time.
				 */
				if (boundEmail !== input.email || userId === undefined || userId.length === 0) {
					return yield* new AccessControl.AccessDenied({
						action: 'manage',
						resource: command,
						reason: 'this founder claim has already been spent, and not for this address'
					});
				}
				return json({
					admitted: true,
					userId,
					admin: true,
					credential: yield* identity.startSession(effectId, userId, input.tenantId)
				});
			}
			// The same admission `identity.admitFounder` performs, and for the same reason: `admin` is
			// a status on the row rather than a bundle of roles, and `AccessControl.decide`
			// short-circuits on it before it consults a policy at all.
			const founderId = yield* identity.admit(
				effectId,
				input.tenantId,
				input.email,
				null,
				ADMIN_STATUS
			);
			const claimExpiresEpochMs = (yield* Clock.currentTimeMillis) + FOUNDER_CLAIM_LEDGER_MILLIS;
			// Written before the session is minted, so a crash between the two leaves a claim that is
			// spent rather than one that can be spent again. The founder is already an administrator
			// at that point and signs in the ordinary way, which is the safe direction to fail.
			yield* identity.recordFounderClaim(
				effectId,
				ledgerIdentifier,
				`${founderId} ${input.email}`,
				new Date(claimExpiresEpochMs).toISOString()
			);
			return json({
				admitted: true,
				userId: founderId,
				admin: true,
				credential: yield* identity.startSession(effectId, founderId, input.tenantId)
			});
		}
		case 'identity.sendCode': {
			const input = yield* decode(IdentitySendCodeInput, commandInput);
			yield* (yield* Identity.Service).sendCode(effectId, input.email);
			// Always the same answer. A response that differed for a known address would turn this
			// into an account-enumeration oracle for anyone who can reach the endpoint.
			return json({ sent: true });
		}
		case Identity.DELIVER_CODE_COMMAND: {
			const delivery = yield* decode(Identity.CodeDelivery, commandInput);
			return json({
				delivered: yield* (yield* Identity.Service).deliverCode(effectId, delivery)
			});
		}
		case 'identity.verifyCode': {
			const input = yield* decode(IdentityVerifyCodeInput, commandInput);
			return json({
				credential: yield* (yield* Identity.Service).verifyCode(
					effectId,
					input.email,
					input.code,
					input.tenantId
				)
			});
		}
		case 'identity.continueSession': {
			const input = yield* decode(IdentityContinueSessionInput, commandInput);
			return json({
				credential: yield* (yield* Identity.Service).startSessionForEmail(
					effectId,
					input.email,
					input.tenantId
				)
			});
		}
		case 'identity.workspaceAccess': {
			const input = yield* decode(IdentitySettingsInput, commandInput);
			return json(yield* (yield* Identity.Service).workspaceAccess(effectId, input.tenantId));
		}
		case 'approvals.decide': {
			const input = yield* decode(ApprovalDecideInput, commandInput);
			const approvals = yield* Approvals.Service;
			return json(
				yield* approvals.decide(effectId, input.subject, input.state, input.decision, input.reason)
			);
		}
		case 'approvals.withdraw': {
			const input = yield* decode(ApprovalWithdrawInput, commandInput);
			return json(yield* (yield* Approvals.Service).withdraw(effectId, input.subject, input.state));
		}
		case 'approvals.capabilities': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			const visible = yield* (yield* Collections.Service).findFirst(effectId, input.subject, {
				collection: 'approval_request',
				where: { id: { eq: input.requestId } }
			});
			// Visibility is the first capability. Returning no record keeps an unreadable request
			// indistinguishable from one that does not exist, just like `approvals.status` below.
			if (visible === undefined || typeof visible !== 'object' || visible === null) return json([]);
			const status = Reflect.get(visible, 'status');
			if (typeof status !== 'string') return json([]);
			const capabilities = yield* (yield* Approvals.Service).capabilities(
				effectId,
				input.subject,
				input.requestId
			);
			return json([{ id: input.requestId, status, ...capabilities }]);
		}
		case 'approvals.status': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			const visible = yield* (yield* Collections.Service).findFirst(effectId, input.subject, {
				collection: 'approval_request',
				where: { id: { eq: input.requestId } }
			});
			if (visible === undefined) return json(null);
			return json((yield* (yield* Approvals.Service).status(effectId, input.requestId)) ?? null);
		}
		case HOST_RECOVER_COMMAND: {
			yield* decode(Schema.Struct({ subject: Subject }), commandInput);
			yield* (yield* Agents.Service).recover(EffectId.make(`${effectId}:agents`));
			yield* (yield* Automations.Service).recover(EffectId.make(`${effectId}:automations`));
			yield* (yield* TaskQueue.Service).recover(EffectId.make(`${effectId}:tasks`));
			return json({ recovered: true });
		}
		case HOST_SCHEDULE_DISCOVER_COMMAND: {
			const input = yield* decode(AuthenticatedHostScheduleDiscover, commandInput);
			const discovered = yield* (yield* TaskQueue.Service).discover(effectId, input.nowEpochMs);
			return json({
				occurrences: discovered.occurrences,
				rejections: discovered.rejections,
				nextDueAtEpochMs: discovered.nextDueAtEpochMs ?? null
			});
		}
		case HOST_SCHEDULE_SETTLE_COMMAND: {
			const input = yield* decode(AuthenticatedHostScheduleSettle, commandInput);
			const nextDueAtEpochMs = yield* (yield* TaskQueue.Service).settle(
				effectId,
				input.occurrence.taskId,
				input.outcome
			);
			return json({ settled: true, nextDueAtEpochMs: nextDueAtEpochMs ?? null });
		}
		case HOST_AGENT_EXECUTE_CHILD_COMMAND: {
			const input = yield* decode(AuthenticatedHostAgentExecuteChild, commandInput);
			return json(
				yield* (yield* Agents.Service).execute(effectId, input.conversationId, input.turnId)
			);
		}
		case 'sync.connect': {
			const input = yield* decode(AuthenticatedSyncConnect, commandInput);
			return json(
				yield* (yield* Sync.Service).connect(
					effectId,
					input.actor,
					input.subject,
					input.impersonatedTeam,
					input
				)
			);
		}
		case 'sync.advance': {
			const input = yield* decode(AuthenticatedSyncAdvance, commandInput);
			if (input.subject.system !== true)
				return yield* new AccessControl.AccessDenied({
					action: 'invoke',
					resource: 'sync.advance',
					reason: 'sync.advance is a host-only commit hook'
				});
			return json(yield* (yield* Sync.Service).advance(effectId, input));
		}
		case 'collections.embed': {
			const collections = yield* Collections.Service;
			return json(yield* collections.embedRecords(effectId));
		}
		case 'agents.enqueue': {
			const input = yield* decode(AgentEnqueueInput, commandInput);
			const agents = yield* Agents.Service;
			return json(
				yield* agents.enqueue(
					effectId,
					input.subject,
					input.agent,
					input.conversationId,
					input.turnId,
					{
						kind: 'user_message',
						text: input.message
					},
					input.model
				)
			);
		}
		case 'agents.documents.attach': {
			const input = yield* decode(AgentDocumentBindInput, commandInput);
			yield* (yield* Agents.Service).attachFile(
				effectId,
				input.subject,
				input.conversationId,
				input.file
			);
			return json({ attached: true });
		}
		case 'agents.documents.read': {
			const input = yield* decode(AgentDocumentInput, commandInput);
			const media = yield* (yield* Agents.Service).readMedia(
				effectId,
				input.subject,
				input.conversationId,
				input.storageKey
			);
			return json({
				file: media.file,
				bytesBase64: Buffer.from(media.bytes).toString('base64')
			});
		}
		case 'agents.documents.remove': {
			const input = yield* decode(AgentDocumentInput, commandInput);
			yield* (yield* Agents.Service).removeFile(
				effectId,
				input.subject,
				input.conversationId,
				input.storageKey
			);
			return json({ removed: true });
		}
		case 'agents.open': {
			const input = yield* decode(AgentOpenInput, commandInput);
			yield* (yield* Agents.Service).open(
				effectId,
				input.subject,
				input.agent,
				input.conversationId
			);
			return json({ opened: true, conversationId: input.conversationId });
		}
		case 'agents.interrupt': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).interrupt(effectId, input.subject, input.conversationId);
			return json({ interrupted: true });
		}
		case 'agents.stop': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).stop(effectId, input.subject, input.conversationId);
			return json({ stopped: true });
		}
		case 'agents.resume': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).resume(effectId, input.subject, input.conversationId);
			return json({ resumed: true });
		}
		case 'agents.updateVerifier': {
			const input = yield* decode(AgentVerifierInput, commandInput);
			yield* (yield* Agents.Service).updateVerifier(effectId, input.conversationId, input.verifier);
			return json({ updated: true });
		}
		// The agent model picker asks for the models this deployment offers. Bolt does not decide that
		// — the host's AI facility does — so this forwards the question rather than answering it.
		case 'ai.models': {
			const ai = yield* AI.Service;
			return json((yield* ai.execute(effectId, { _tag: 'Models' })).output);
		}
		/**
		 * Runtime consumers receive only collections they may read. Studio has a separate authoring
		 * boundary: an administrator receives every authored collection and no runtime-owned one.
		 */
		case 'workspace.manifest':
		case 'workspace.authoringManifest': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			const workspace = yield* Workspace.Service;
			const access = yield* AccessControl.Service;
			const definition = workspace.definition;
			const authoring = command === 'workspace.authoringManifest';
			if (authoring && input.subject.admin !== true) {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: 'workspace.authoringManifest',
					reason: 'Workspace authoring is restricted to administrators'
				});
			}
			const visible = definition.collections.filter(({ name }) =>
				authoring
					? !SYSTEM_COLLECTION_NAMES.has(name)
					: access.predicate(input.subject, 'read', name).allowed
			);
			return json({
				name: definition.name,
				version: definition.version,
				collections: visible.map((collection) => ({
					name: collection.name,
					history: collection.history,
					hooks: [...(collection.hooks ?? [])],
					// Model presentation metadata projected for Studio and the data browser.
					...DispatchValues.jsonObject({
						description: collection.description,
						icon: collection.icon,
						sourcePath: collection.sourcePath
					}),
					// Every key a field description carries, not a chosen four. The projection named
					// `name`/`type`/`required`/`generated` and dropped the rest, so a studio could not
					// offer an enum's members, could not mark a searchable column, could not resolve a
					// `custom()` renderer and could not set an upload's accept list — each of them a
					// declaration a workspace makes, and this the last hop before it would be read.
					fields: Object.entries(collection.fields).map(([field, definition]) =>
						DispatchValues.jsonObject({
							name: field,
							type: definition.type,
							required: definition.required,
							generated: definition.generated !== undefined,
							values: definition.values === undefined ? undefined : [...definition.values],
							search: definition.search,
							customType: definition.customType,
							mimeTypes: definition.mimeTypes === undefined ? undefined : [...definition.mimeTypes]
						})
					),
					relations: definition.relations
						.filter((relation) => relation.source === collection.name)
						.map(({ name, target, cardinality }) => ({ name, target, cardinality }))
				})),
				apps: definition.apps.map(({ name, label }) => ({ name, label })),
				policies: definition.policies.map((policy) => ({
					name: policy.name,
					grants: policy.grants?.length ?? 0
				})),
				automations: definition.automations.map(({ name }) => ({ name })),
				// What identifies an envoy and what shape of traffic it carries, for the same reason the
				// field projection above stopped naming four keys: a studio that is told only an envoy's
				// name cannot say which transport it arrives over, and cannot tell a public envoy from one
				// only members reach.
				//
				// `policies` and `task` are declared and deliberately not published. `task` is the envoy's
				// standing instruction and `policies` names everything its runs may do; neither manifest
				// publishes those operational instructions.
				//
				// There is no `agent` key, because there is no agent to point at. An envoy *is* one, and
				// the back-pointer this used to publish had the same value for every envoy in every
				// workspace: the single synthesized agent the compiler invented.
				envoys: definition.envoys.map(({ name, transport, audience, groupMessages, delegation }) =>
					DispatchValues.jsonObject({ name, transport, audience, groupMessages, delegation })
				),
				/**
				 * Every static identity this release can mint, with the label a surface renders it as.
				 *
				 * `bolt_audit.subject_id` and `bolt_collection_history.subject_id` are plain `text` with no
				 * foreign key, which is what lets `envoy:sales_desk` and `automation:payroll_close` be
				 * valid values with no shadow user table. What was missing was the *label*: a client
				 * holding `envoy:sales_desk` had nothing to render but the id.
				 */
				principals: [
					{ id: SystemPrincipal.SYSTEM_PRINCIPAL_ID, label: 'Colony', kind: 'host', policies: [] },
					{ id: SEED_PRINCIPAL_ID, label: 'Sample data', kind: 'seed', policies: [] },
					...definition.envoys.map((envoy) => ({
						id: envoyPrincipalId(envoy.name),
						label: envoy.name,
						kind: 'envoy',
						policies: [...envoy.policies]
					})),
					...definition.automations.map((automation) => ({
						id: automationPrincipalId(automation.name),
						label: automation.name,
						kind: 'automation',
						policies: [...automation.policies]
					}))
				],
				integrations: definition.integrations.map(({ name }) => ({ name })),
				requiredFacilities: [...definition.requiredFacilities]
			});
		}
		case 'collections.history': {
			const input = yield* decode(CollectionRecordInput, commandInput);
			return json(
				yield* (yield* Collections.Service).history(
					effectId,
					input.subject,
					input.collection,
					input.id
				)
			);
		}
		/** The browser mutation lifecycle is owned by Collections. */
		case 'collections.mutate': {
			const authority = yield* decode(AuthenticatedCollectionMutation, commandInput);
			const input = yield* decode(CollectionMutateRequest, commandInput);
			return json(
				yield* (yield* Collections.Service).mutateBrowser(
					effectId,
					authority.actor,
					authority.subject,
					authority.impersonatedTeam,
					input
				)
			);
		}
		case 'collections.resume': {
			const input = yield* decode(ApprovalRequestIdInput, commandInput);
			yield* (yield* Collections.Service).resume(effectId, input.requestId);
			return json({ resumed: true, requestId: input.requestId });
		}
		case 'collections.discard': {
			const input = yield* decode(ApprovalRequestIdInput, commandInput);
			yield* (yield* Collections.Service).discard(effectId, input.requestId);
			return json({ discarded: true, requestId: input.requestId });
		}
		case 'collections.import': {
			const input = yield* decode(CollectionImportInput, commandInput);
			const records = input.records.map((record) => ({ ...record, subject: input.subject }));
			return json({
				imported: yield* (yield* Collections.Service).import(effectId, input.subject, records)
			});
		}
		case 'collections.export': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json(
				yield* (yield* Collections.Service).export(effectId, input.subject, collectionQuery(input))
			);
		}
		case 'schema.plan': {
			const schema = yield* WorkspaceSchema.Service;
			const plan = schema.plan();
			return json({
				fingerprint: plan.fingerprint,
				steps: plan.steps.map(({ id, sql }) => ({ id, sql }))
			});
		}
		case 'schema.fingerprint': {
			const schema = yield* WorkspaceSchema.Service;
			return json({ fingerprint: schema.fingerprint() });
		}
		case 'schema.validate': {
			yield* (yield* WorkspaceSchema.Service).validate();
			return json({ valid: true });
		}
		case 'schema.verify': {
			// The divergences ride along with the verdict: "not verified" on its own sends the reader
			// back to the database to find out what is wrong, which is the work this command just did.
			const divergences = yield* (yield* WorkspaceSchema.Service).verify(effectId);
			return json({ verified: divergences.length === 0, divergences });
		}
		case 'schema.migrate': {
			const schema = yield* WorkspaceSchema.Service;
			yield* schema.migrate(effectId);
			return json({ migrated: true, fingerprint: schema.fingerprint() });
		}
		case 'automations.start': {
			const input = yield* decode(AutomationStartInput, commandInput);
			const automations = yield* Automations.Service;
			const taskId = yield* automations.start(effectId, input.name, input.input);
			const result = yield* executeDirectAutomation(
				EffectId.make(`${effectId}:execute`),
				input.name,
				taskId
			);
			return json({
				taskId,
				result: result ?? null
			});
		}
		case 'automations.stop': {
			const input = yield* decode(AutomationLifecycleInput, commandInput);
			yield* (yield* Automations.Service).stop(effectId, input.name, input.taskId);
			return json({ stopped: true });
		}
		case 'envoys.receive': {
			const input = yield* decode(EnvoyReceiveInput, commandInput);
			const envoys = yield* Envoys.Service;
			return json(yield* envoys.receive(effectId, input.envoy, input.delivery));
		}
		case 'envoys.drain': {
			const input = yield* decode(EnvoyDrainInput, commandInput);
			return json(
				yield* (yield* Envoys.Service).drain(effectId, input.envoy, input.conversationId)
			);
		}
		case 'envoys.complete': {
			const input = yield* decode(EnvoyCompleteInput, commandInput);
			return json(
				yield* (yield* Envoys.Service).complete(
					effectId,
					input.envoy,
					input.conversationId,
					input.output,
					input.progressKey ?? null
				)
			);
		}
		case 'envoys.status': {
			const input = yield* decode(EnvoyNameInput, commandInput);
			return json(yield* (yield* Envoys.Service).status(effectId, input.envoy));
		}
		case 'integrations.pull': {
			const input = yield* decode(IntegrationPullInput, commandInput);
			const integrations = yield* Integrations.Service;
			return json(yield* integrations.pull(effectId, input.name, input.cursor, input.binding));
		}
		case 'integrations.flush': {
			const input = yield* decode(IntegrationFlushInput, commandInput);
			return json(
				yield* (yield* Integrations.Service).flush(effectId, input.name, input.input ?? null)
			);
		}
		case 'notifications.drain': {
			const input = yield* decode(Notification, commandInput);
			const notifications = yield* Notifications.Service;
			yield* notifications.drain(effectId, input);
			return json({ delivered: true, id: input.id });
		}
		default:
			// An enqueued `automations.<name>` task is an authored automation's turn to run: the
			// handler receives the Effect-native api and the trigger context, and its result is the
			// task's answer. Resolved against the declared automations rather than the prefix, so a
			// workspace can never route a stray command to a handler it did not declare. The
			// `bolt_run_as` subject is stamped by the runtime's own enqueue points (`Automations.start`
			// and the collection change events), never by the payload.
			if (command.startsWith('automations.')) {
				const name = command.slice('automations.'.length);
				const automation = (yield* AuthoredRuntimeService).automations[name];
				if (automation !== undefined) {
					const input = yield* decode(AutomationTaskInput, commandInput);
					return json(yield* executeAutomationBody(effectId, name, input));
				}
			}
			return yield* new DispatchError({
				code: 'unknown_command',
				message: `Unknown Bolt command: ${command}`
			});
	}
});
