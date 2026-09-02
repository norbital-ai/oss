import { Clock, Effect, Number as ENumber, Option, Result, Schema } from 'effect';
import {
	CollectionSearch,
	DataBrowserCommandContract,
	EffectId,
	FixedCommandCatalogue,
	PluginTrustedContext,
	WorkspaceAutomationContract,
	WorkspaceInvokeContract,
	type CommandContract,
	type DispatchResponse,
	type FixedCommandContract,
	type FixedCommandName,
	type TenantId
} from '@norbital-ai/bolt-protocol';
import { AutomationProgression } from '#lib/authoring/automations-schema.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import type { QueryInput } from '#lib/runtime/collections/collections.contract.js';
import {
	AuthoredRuntimeService,
	RemoteRegistry,
	guardAuthoringOps,
	makeAutomationApi,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler
} from '#lib/runtime/collections/authored.js';
import { AI, Files } from '#lib/runtime/facilities/services.js';
import * as Envoys from '#lib/runtime/envoys/envoys.js';
import * as Integrations from '#lib/runtime/integrations/integrations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { ADMIN_STATUS, Subject } from '#lib/runtime/identity/identity.js';
import {
	automationPrincipalId,
	envoyPrincipalId,
	SEED_PRINCIPAL_ID
} from '#lib/runtime/identity/static-identity.js';
import * as Notifications from '#lib/runtime/notifications/notifications.js';
import * as WorkspaceSchema from '#lib/runtime/schema/workspace-schema.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import { Secrets } from '#lib/runtime/secrets/secrets.js';
import * as Sync from '#lib/runtime/sync/sync.js';
import * as SystemPrincipal from '#lib/runtime/access/system-principal.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { authoredManifestDeclarations } from '#lib/runtime/workspace-manifest.js';

export type InvocationOrigin = 'Command' | 'Task' | 'Plugin';
type PrincipalRule = 'public' | 'session-or-system' | 'system' | 'runtime-task';

export type ExecutionContext = Readonly<{
	effectId: EffectId;
	tenantId: TenantId;
	origin: InvocationOrigin;
	principal?: Identity.Subject;
	actor?: Identity.Subject;
	impersonatedTeam?: string;
	trustedContext?: PluginTrustedContext;
}>;

type OriginRule = Readonly<{
	principal: PrincipalRule;
	authorization: string;
	authorize?: (
		context: ExecutionContext,
		input: unknown
	) => Effect.Effect<void, AccessControl.AccessDenied, unknown>;
}>;

export type CommandBinding<E = never> = Readonly<{
	contract: CommandContract;
	origins: Partial<Record<InvocationOrigin, OriginRule>>;
	handle: (context: ExecutionContext, input: unknown) => Effect.Effect<DispatchResponse, E, unknown>;
}>;

type ContractFor<Name extends FixedCommandName> = Extract<
	FixedCommandContract,
	Readonly<{ name: Name }>
>;
type InputOf<Contract extends CommandContract> = Schema.Schema.Type<Contract['input']>;

const fixedContract = <Name extends FixedCommandName>(name: Name): ContractFor<Name> => {
	const found = FixedCommandCatalogue.find((entry) => entry.name === name);
	if (found === undefined) throw new Error(`Missing fixed command contract: ${name}`);
	return found as ContractFor<Name>;
};

const binding = <Name extends FixedCommandName, E>(
	name: Name,
	origins: CommandBinding<E>['origins'],
	handle: (
		context: ExecutionContext,
		input: InputOf<ContractFor<Name>>
	) => Effect.Effect<DispatchResponse, E, unknown>
): CommandBinding<E> => ({
	contract: fixedContract(name),
	origins,
	handle: (context, input) => handle(context, input as InputOf<ContractFor<Name>>)
});

const json = (value: Schema.Json, status = 200): DispatchResponse => ({
	status,
	headers: {},
	value
});

const principal = (context: ExecutionContext): Identity.Subject => {
	if (context.principal !== undefined) return context.principal;
	throw new DispatchError({ code: 'unauthorized', message: 'Command requires a principal' });
};

const actor = (context: ExecutionContext): Identity.Subject => context.actor ?? principal(context);

const session = (authorization: string): OriginRule => ({
	principal: 'session-or-system',
	authorization
});
const system = (authorization: string): OriginRule => ({ principal: 'system', authorization });
const task = (authorization: string): OriginRule => ({ principal: 'runtime-task', authorization });
const publicCommand: OriginRule = { principal: 'public', authorization: 'public sign-in boundary' };

const protect = (
	action: string,
	resource: string
): NonNullable<OriginRule['authorize']> =>
	Effect.fn('Bolt.command.authorize')(function* (context) {
		yield* (yield* AccessControl.Service).authorize(principal(context), action, resource);
	});

const isNonEmptyRecord = (value: unknown): value is Readonly<Record<string, Schema.Json>> =>
	value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

const optionalQueryJson = (value: unknown): Schema.Json | undefined =>
	value == null || !isNonEmptyRecord(value) ? undefined : value;

const optionalSearch = (value: unknown): CollectionSearch | undefined => {
	if (value == null) return undefined;
	const decoded = Schema.decodeUnknownResult(CollectionSearch)(value);
	return Result.isFailure(decoded) ? undefined : decoded.success;
};

const optionalAfter = (value: string | undefined): string | undefined =>
	value === undefined || value === '' ? undefined : value;

const collectionQuery = (input: {
	readonly collection: string;
	readonly limit?: number;
	readonly where?: unknown;
	readonly userFilter?: unknown;
	readonly orderBy?: unknown;
	readonly with?: unknown;
	readonly search?: unknown;
	readonly after?: string;
	/** Accepted on the wire and dropped: selecting columns would strip cursor-order fields. */
	readonly columns?: unknown;
}): QueryInput => {
	const where = optionalQueryJson(input.where);
	const userFilter = optionalQueryJson(input.userFilter);
	const orderBy = optionalQueryJson(input.orderBy);
	const withRelations = optionalQueryJson(input.with);
	const search = optionalSearch(input.search);
	const after = optionalAfter(input.after);
	return {
		collection: input.collection,
		limit: ENumber.clamp({ minimum: 1, maximum: 500 })(input.limit ?? 100),
		...(where === undefined ? {} : { where }),
		...(userFilter === undefined ? {} : { userFilter }),
		...(orderBy === undefined ? {} : { orderBy }),
		...(withRelations === undefined ? {} : { with: withRelations }),
		...(search === undefined ? {} : { search }),
		...(after === undefined ? {} : { after })
	};
};
const groupedQuery = (input: {
	readonly collection: string;
	readonly where?: unknown;
	readonly userFilter?: unknown;
	readonly orderBy?: unknown;
	readonly with?: unknown;
	readonly search?: unknown;
	readonly columns?: unknown;
	readonly group: { readonly by: string; readonly lanes?: readonly Schema.Json[] };
}) => {
	const base = collectionQuery({ ...input, limit: 1 });
	const { limit: _limit, after: _after, ...rest } = base;
	return {
		...rest,
		groupBy: input.group.by,
		lanes: input.group.lanes ?? []
	};
};
export { collectionQuery };

const jsonObject = (
	entry: Readonly<Record<string, Schema.Json | undefined>>
): Readonly<Record<string, Schema.Json>> => {
	const value: Record<string, Schema.Json> = {};
	for (const [key, field] of Object.entries(entry)) if (field !== undefined) value[key] = field;
	return value;
};

const FOUNDER_CLAIM_IDENTIFIER = 'founder-claim:';
const FOUNDER_CLAIM_LEDGER_MILLIS = 86_400_000;

const workspaceManifest = Effect.fn('Bolt.command.workspaceManifest')(function* (
	context: ExecutionContext,
	authoring: boolean
) {
	const subject = principal(context);
	const workspace = yield* Workspace.Service;
	const access = yield* AccessControl.Service;
	const authoredRuntime = yield* AuthoredRuntimeService;
	if (authoring && subject.admin !== true)
		return yield* new AccessControl.AccessDenied({
			action: 'read',
			resource: 'workspace.authoringManifest',
			reason: 'Workspace authoring is restricted to administrators'
		});
	const definition = workspace.definition;
	const visible = definition.collections.filter(({ name }) =>
		authoring ? !SYSTEM_COLLECTION_NAMES.has(name) : access.predicate(subject, 'read', name).allowed
	);
	const { collections: declaredCollections, ...declarations } = authoredManifestDeclarations(
		definition,
		authoredRuntime
	);
	const declared = new Map(declaredCollections.map((collection) => [collection.name, collection]));
	return {
		...declarations,
		name: definition.name,
		version: definition.version,
		collections: visible.map((collection) => ({
			...declared.get(collection.name),
			name: collection.name,
			history: collection.history,
			hooks: [...(collection.hooks ?? [])],
			...jsonObject({
				description: collection.description,
				icon: collection.icon,
				sourcePath: collection.sourcePath
			}),
			fields: Object.entries(collection.fields).map(([field, definition]) =>
				jsonObject({
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
		principals: [
			{ id: SystemPrincipal.SYSTEM_PRINCIPAL_ID, label: 'Colony', kind: 'host', policies: [] },
			{ id: SEED_PRINCIPAL_ID, label: 'Sample data', kind: 'seed', policies: [] },
			...definition.envoys.map((envoy) => ({
				id: envoyPrincipalId(envoy.name), label: envoy.name, kind: 'envoy', policies: [...envoy.policies]
			})),
			...definition.automations.map((automation) => ({
				id: automationPrincipalId(automation.name), label: automation.name,
				kind: 'automation', policies: [...automation.policies]
			}))
		],
		requiredFacilities: [...definition.requiredFacilities]
	};
});

type AutomationTaskInput = Schema.Schema.Type<typeof WorkspaceAutomationContract.input>;

const executeAutomationBody = Effect.fn('Bolt.command.executeAutomationBody')(function* (
	context: ExecutionContext,
	name: string,
	input: AutomationTaskInput
) {
	const automation = (yield* AuthoredRuntimeService).automations[name];
	if (automation === undefined)
		return yield* new DispatchError({
			code: 'unknown_command',
			message: `Unknown Bolt automation: ${name}`
		});
	const runAs = yield* Schema.decodeUnknownEffect(Subject)(input.bolt_run_as).pipe(
		Effect.mapError(() =>
			new AccessControl.AccessDenied({
				action: 'invoke', resource: `automations.${name}`,
				reason: 'The runtime task carries no valid declared automation subject'
			})
		)
	);
	const collections = yield* Collections.Service;
	const ai = yield* AI.Service;
	const files = yield* Files.Service;
	const automations = yield* Automations.Service;
	const guard = Automations.stoppageGuard(automations, context.effectId, input.bolt_task_id);
	const ops = guardAuthoringOps(
		makeBoundAuthoringOps(
			context.effectId,
			runAs,
			collections,
			ai,
			files,
			automations,
			(nestedName, nestedInput, options) =>
				collections.runAutomation(context.effectId, nestedName, nestedInput, {}, {
					...options,
					...(input.bolt_depth === undefined ? {} : { parentDepth: input.bolt_depth })
				})
		),
		guard
	);
	const api = makeAutomationApi(makeAuthoringApi(ops), (value) =>
		guard('progress').pipe(
			Effect.andThen(Schema.decodeUnknownEffect(AutomationProgression)(value)),
			Effect.flatMap((progression) =>
				automations.progress(context.effectId, input.bolt_task_id, progression)
			)
		)
	);
	const args = yield* Schema.decodeUnknownEffect(automation.input ?? Schema.Json)(input.args);
	const output = yield* runAuthoredHandler(() => automation.handler(api, { args, scope: input.scope ?? {} }));
	const declared = yield* Schema.decodeUnknownEffect(automation.output ?? Schema.Unknown)(output);
	return yield* Schema.decodeUnknownEffect(Schema.Json)(declared);
});

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
// Named apart from the `jsonObject` builder above: that one drops `undefined` fields from a literal,
// this one decodes an unknown payload. Sharing the name made the later declaration win for every
// caller after it, including one that passes an object literal.
const decodeJsonObject = Schema.decodeUnknownOption(JsonObject);

const executeDirectAutomation = Effect.fn('Bolt.command.executeDirectAutomation')(function* (
	context: ExecutionContext,
	name: string,
	taskId: string
) {
	return yield* (yield* Automations.Service).execute(
		context.effectId,
		name,
		taskId,
		(raw, attemptEffectId) =>
			Effect.gen(function* () {
				const decoded = yield* Schema.decodeUnknownEffect(WorkspaceAutomationContract.input)({
					...Option.getOrElse(decodeJsonObject(raw), () => ({})),
					bolt_task_id: taskId
				});
				return yield* executeAutomationBody(
					{ ...context, effectId: EffectId.make(attemptEffectId) },
					name,
					decoded
				);
			})
	);
});

const fixedBindings = [
	binding('secrets.status', { Command: { ...session('manage secrets'), authorize: protect('manage', 'secrets') } },
		(context) => Effect.gen(function* () {
			const entries = yield* (yield* Secrets.Service).status(context.effectId);
			return json(entries.map((entry) => jsonObject({
				name: entry.name, label: entry.label, secret: entry.secret, configured: entry.configured,
				description: entry.description, default: entry.default, updatedAt: entry.updatedAt
			})));
		})),
	binding('secrets.write', { Command: { ...session('manage secrets'), authorize: protect('manage', 'secrets') } },
		(context, input) => Effect.gen(function* () {
			yield* (yield* Secrets.Service).write(context.effectId, input.name, input.value, principal(context).userId);
			return json({ saved: true, name: input.name });
		})),
	binding('apps.visible', { Command: session('visible application policy') },
		(context) => Effect.map(AccessControl.Service, (access) => json({ apps: access.visibleApps(principal(context)) }))),
	binding('access.impersonation', { Command: session('impersonation capability') },
		(context) => Effect.gen(function* () {
			const access = yield* AccessControl.Service;
			const teams = yield* access.impersonationTeams();
			return json({
				isAdmin: access.mayImpersonate(actor(context)),
				isActive: context.impersonatedTeam !== undefined,
				activeTeamIds: context.impersonatedTeam === undefined ? [] : [context.impersonatedTeam],
				teams
			});
		})),
	binding('access.impersonateTeam', { Command: session('team impersonation object check') },
		(context, input) => Effect.gen(function* () {
			const access = yield* AccessControl.Service;
			const previewed = yield* access.impersonateTeam(actor(context), input.teamId);
			return json({ subject: previewed, apps: access.visibleApps(previewed) });
		})),
	binding('access.explain', { Command: session('effective policy explanation') },
		(context, input) => Effect.map(AccessControl.Service, (access) => {
			const decision = access.explain(principal(context), input.action, input.resource);
			return json({ allowed: decision.allowed, reason: decision.reason });
		})),
	binding('identity.admitFounder', { Command: { ...session('manage identity'), authorize: protect('manage', 'identity') } },
		(context, input) => Effect.gen(function* () {
			const userId = yield* (yield* Identity.Service).admit(context.effectId, context.tenantId, input.email, null, ADMIN_STATUS);
			return json({ admitted: true, userId, admin: true });
		})),
	binding('identity.bootstrapFounder', { Command: system('host founder bootstrap') },
		(context, input) => Effect.gen(function* () {
			const identity = yield* Identity.Service;
			const ledger = `${FOUNDER_CLAIM_IDENTIFIER}${input.claimId}`;
			const spent = yield* identity.readFounderClaim(context.effectId, ledger);
			if (spent !== undefined) {
				const [userId, ...rest] = spent.split(' ');
				if (userId === undefined || userId.length === 0 || rest.join(' ') !== input.email)
					return yield* new AccessControl.AccessDenied({
						action: 'manage', resource: 'identity.bootstrapFounder',
						reason: 'this founder claim has already been spent for another address'
					});
				return json({ admitted: true, userId, admin: true,
					credential: yield* identity.startSession(context.effectId, userId, context.tenantId) });
			}
			const userId = yield* identity.admit(context.effectId, context.tenantId, input.email, null, ADMIN_STATUS);
			const expires = new Date((yield* Clock.currentTimeMillis) + FOUNDER_CLAIM_LEDGER_MILLIS).toISOString();
			yield* identity.recordFounderClaim(context.effectId, ledger, `${userId} ${input.email}`, expires);
			return json({ admitted: true, userId, admin: true,
				credential: yield* identity.startSession(context.effectId, userId, context.tenantId) });
		})),
	binding('identity.sendCode', { Command: publicCommand },
		(context, input) => Effect.gen(function* () {
			yield* (yield* Identity.Service).sendCode(context.effectId, input.email);
			return json({ sent: true });
		})),
];

const remainingBindings = [
	binding('identity.verifyCode', { Command: publicCommand },
		(context, input) => Effect.gen(function* () {
			const credential = yield* (yield* Identity.Service).verifyCode(context.effectId, input.email, input.code, context.tenantId);
			return json({ credential });
		})),
	binding('identity.continueSession', { Command: system('host session continuation') },
		(context, input) => Effect.gen(function* () {
			const credential = yield* (yield* Identity.Service).startSessionForEmail(context.effectId, input.email, context.tenantId);
			return json({ credential });
		})),
	binding('identity.workspaceAccess', { Command: session('tenant workspace access') },
		(context) =>
			Effect.flatMap(Identity.Service, (identity) => Effect.map(identity.workspaceAccess(context.effectId, context.tenantId), json))),
	binding('identity.invite', { Command: { ...session('manage identity'), authorize: protect('manage', 'identity') } },
		(context, input) => Effect.gen(function* () {
			const invitationId = yield* (yield* Identity.Service).invite(context.effectId, context.tenantId, input.email, principal(context).userId);
			return json({ invitationId });
		})),
	binding('identity.invitation.inspect', { Command: system('host invitation inspection') },
		(context, input) =>
			Effect.flatMap(Identity.Service, (identity) => Effect.map(identity.inspectInvitation(context.effectId, context.tenantId, input.invitationId), json))),
	binding('identity.invitation.accept', { Command: session('invitation object acceptance') },
		(context, input) =>
			Effect.flatMap(Identity.Service, (identity) => Effect.map(identity.acceptInvitation(context.effectId, input.invitationId, principal(context)), json))),
	binding('approvals.decide', { Command: session('approval object decision') },
		(context, input) =>
			Effect.flatMap(Approvals.Service, (approvals) => Effect.map(approvals.decide(context.effectId, principal(context), input.state, input.decision, input.reason), json))),
	binding('approvals.withdraw', { Command: session('approval object withdrawal') },
		(context, input) =>
			Effect.flatMap(Approvals.Service, (approvals) => Effect.map(approvals.withdraw(context.effectId, principal(context), input.state), json))),
	binding('approvals.capabilities', { Command: session('approval visibility and capability') },
		(context, input) => Effect.gen(function* () {
			const visible = yield* (yield* Collections.Service).findFirst(context.effectId, principal(context), {
				collection: 'approval_request', where: { id: { eq: input.requestId } }
			});
			if (visible === undefined || typeof visible !== 'object' || visible === null) return json([]);
			const status = Reflect.get(visible, 'status');
			if (typeof status !== 'string') return json([]);
			const capabilities = yield* (yield* Approvals.Service).capabilities(context.effectId, principal(context), input.requestId);
			return json([{ id: input.requestId, status, ...capabilities }]);
		})),
	binding('approvals.status', { Command: session('approval visibility') },
		(context, input) => Effect.gen(function* () {
			const visible = yield* (yield* Collections.Service).findFirst(context.effectId, principal(context), {
				collection: 'approval_request', where: { id: { eq: input.requestId } }
			});
			return json(visible === undefined ? null : (yield* (yield* Approvals.Service).status(context.effectId, input.requestId)) ?? null);
		})),
	binding('host.recover', { Command: system('host recovery') },
		(context) => Effect.gen(function* () {
			yield* (yield* Automations.Service).recover(EffectId.make(`${context.effectId}:automations`));
			yield* (yield* TaskQueue.Service).recover(EffectId.make(`${context.effectId}:tasks`));
			return json({ recovered: true });
		})),
	binding('host.schedules.discover', { Command: system('host schedule claim') },
		(context, input) => Effect.gen(function* () {
			const discovered = yield* (yield* TaskQueue.Service).discover(context.effectId, input.nowEpochMs, input.leaseForMillis);
			yield* (yield* Automations.Service).publishProjectedRuns(EffectId.make(`${context.effectId}:publish`), discovered.occurrences.map(({ taskId }) => taskId));
			return json({ occurrences: discovered.occurrences, rejections: discovered.rejections, nextDueAtEpochMs: discovered.nextDueAtEpochMs ?? null });
		})),
	binding('host.schedules.settle', { Command: system('host schedule settlement') },
		(context, input) => Effect.gen(function* () {
			const next = yield* (yield* TaskQueue.Service).settle(context.effectId, input.occurrence.taskId, input.occurrence.attempt, input.outcome);
			yield* (yield* Automations.Service).publishProjectedRuns(EffectId.make(`${context.effectId}:publish`), [input.occurrence.taskId]);
			return json({ settled: true, nextDueAtEpochMs: next ?? null });
		})),
	binding('sync.connect', { Command: session('viewer-scoped live query admission') },
		(context, input) =>
			Effect.flatMap(Sync.Service, (sync) => Effect.map(sync.connect(context.effectId, actor(context), principal(context), context.impersonatedTeam ?? null, input), json))),
	binding('sync.extendPrefix', { Command: system('host live-prefix extension') },
		(context, input) =>
			Effect.flatMap(Sync.Service, (sync) => Effect.map(sync.extendPrefix(context.effectId, input.state, input.request), json))),
	binding('sync.advance', { Command: system('host commit delta evaluation') },
		(context, input) =>
			Effect.flatMap(Sync.Service, (sync) => Effect.map(sync.advance(context.effectId, input), json))),
	binding('collections.embed', { Command: system('host embedding checkpoint') },
		(context) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.embedRecords(context.effectId), json))),
	binding('tasks.submit', { Command: session('TaskService.submit exact task object') },
		(context, input) =>
			Effect.flatMap(Agents.Service, (agents) => Effect.map(agents.submit(context.effectId, principal(context), input), json))),
	binding('tasks.editMessage', { Command: session('TaskService.editMessage exact task object') },
		(context, input) =>
			Effect.flatMap(Agents.Service, (agents) => Effect.map(agents.editMessage(context.effectId, principal(context), input), json))),
	binding('tasks.control', { Command: session('TaskService.control exact task object') },
		(context, input) =>
			Effect.flatMap(Agents.Service, (agents) => Effect.map(agents.control(context.effectId, principal(context), input), json))),
	binding('workspace.manifest', { Command: session('visible workspace manifest') },
		(context) => Effect.map(workspaceManifest(context, false), json)),
	binding('workspace.authoringManifest', { Command: session('administrator authoring manifest') },
		(context) => Effect.map(workspaceManifest(context, true), json)),
	binding('collections.history', { Command: session('collection row history policy') },
		(context, input) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.history(context.effectId, principal(context), input.collection, input.id), json))),
	binding('collections.mutate', { Command: session('collection action, row, and field policy') },
		(context, input) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.mutateBrowser(context.effectId, actor(context), principal(context), context.impersonatedTeam ?? null, input), json))),
	binding('collections.resume', { Command: session('held mutation object'), Task: task('held mutation object') },
		(context, input) => Effect.gen(function* () { yield* (yield* Collections.Service).resume(context.effectId, input.requestId); return json({ resumed: true, requestId: input.requestId }); })),
	binding('collections.discard', { Command: session('held mutation object'), Task: task('held mutation object') },
		(context, input) => Effect.gen(function* () { yield* (yield* Collections.Service).discard(context.effectId, input.requestId); return json({ discarded: true, requestId: input.requestId }); })),
	binding('collections.import', { Command: session('collection import row and field policy') },
		(context, input) => Effect.gen(function* () {
			const subject = principal(context);
			return json({ imported: yield* (yield* Collections.Service).import(context.effectId, subject, input.records.map((record) => ({ ...record, subject }))) });
		})),
	binding('collections.export', { Command: session('collection query policy') },
		(context, input) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.export(context.effectId, principal(context), collectionQuery(input)), json))),
	binding('collections.count', { Command: session('collection query policy') },
		(context, input) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.count(context.effectId, principal(context), collectionQuery(input)), json))),
	binding('collections.findGrouped', { Command: session('collection query policy') },
		(context, input) =>
			Effect.flatMap(Collections.Service, (collections) => Effect.map(collections.findGrouped(context.effectId, principal(context), groupedQuery(input)), json))),
	binding('schema.plan', { Command: { ...session('read schema'), authorize: protect('read', 'schema') } },
		() => Effect.map(WorkspaceSchema.Service, (schema) => { const plan = schema.plan(); return json({ fingerprint: plan.fingerprint, steps: plan.steps.map(({ id, sql }) => ({ id, sql })) }); })),
	binding('schema.fingerprint', { Command: { ...session('read schema'), authorize: protect('read', 'schema') } },
		() => Effect.map(WorkspaceSchema.Service, (schema) => json({ fingerprint: schema.fingerprint() }))),
	binding('schema.validate', { Command: { ...session('read schema'), authorize: protect('read', 'schema') } },
		() => Effect.gen(function* () { yield* (yield* WorkspaceSchema.Service).validate(); return json({ valid: true }); })),
	binding('schema.verify', { Command: { ...session('read schema'), authorize: protect('read', 'schema') } },
		(context) => Effect.gen(function* () { const divergences = yield* (yield* WorkspaceSchema.Service).verify(context.effectId); return json({ verified: divergences.length === 0, divergences }); })),
	binding('schema.migrate', { Command: { ...session('manage schema'), authorize: protect('manage', 'schema') } },
		(context) => Effect.gen(function* () { const schema = yield* WorkspaceSchema.Service; yield* schema.migrate(context.effectId); return json({ migrated: true, fingerprint: schema.fingerprint() }); })),
	binding('automations.start', { Command: session('declared automation admission') },
		(context, input) => Effect.gen(function* () {
			const taskId = yield* (yield* Automations.Service).start(context.effectId, input.name, input.input);
			return json({ taskId, result: (yield* executeDirectAutomation({ ...context, effectId: EffectId.make(`${context.effectId}:execute`) }, input.name, taskId)) ?? null });
		})),
	binding('automations.stop', { Command: session('declared automation task object') },
		(context, input) => Effect.gen(function* () { yield* (yield* Automations.Service).stop(context.effectId, input.name, input.taskId); return json({ stopped: true }); })),
	binding('envoys.receive', { Command: system('host-authenticated transport delivery') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.receive(context.effectId, input.envoy, input.delivery), json))),
	binding('envoys.registration.inspect', { Command: system('host registration claim inspection') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.inspectRegistration(context.effectId, input.claimId), json))),
	binding('envoys.registration.redeem', { Command: session('registration claim object redemption') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.redeemRegistration(context.effectId, input.claimId, principal(context)), json))),
	binding('envoys.drain', { Command: session('envoy conversation object'), Task: task('envoy conversation object') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.drain(context.effectId, input.envoy, input.conversationId), json))),
	binding('envoys.complete', { Command: session('envoy conversation object'), Task: task('envoy conversation object') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.complete(context.effectId, input.envoy, input.conversationId, input.output, input.progressKey ?? null), json))),
	binding('envoys.status', { Command: session('envoy status visibility') },
		(context, input) =>
			Effect.flatMap(Envoys.Service, (envoys) => Effect.map(envoys.status(context.effectId, input.envoy), json))),
	binding('integrations.pull', { Command: session('integration binding'), Task: task('integration binding') },
		(context, input) =>
			Effect.flatMap(Integrations.Service, (integrations) => Effect.map(integrations.pull(context.effectId, input.name, input.cursor, input.binding), json))),
	binding('integrations.flush', { Command: session('integration outbox'), Task: task('integration outbox') },
		(context, input) =>
			Effect.flatMap(Integrations.Service, (integrations) => Effect.map(integrations.flush(context.effectId, input.name, input.input ?? null), json))),
	binding('notifications.drain', { Command: session('notification object'), Task: task('notification object') },
		(context, input) => Effect.gen(function* () { yield* (yield* Notifications.Service).drain(context.effectId, input); return json({ delivered: true, id: input.id }); }))
];

const allBindings = [...fixedBindings, ...remainingBindings];
const fixedByName = new Map<string, (typeof allBindings)[number]>();
for (const entry of allBindings) {
	if (fixedByName.has(entry.contract.name)) throw new Error(`Duplicate command binding: ${entry.contract.name}`);
	fixedByName.set(entry.contract.name, entry);
}
for (const contract of FixedCommandCatalogue) {
	if (!fixedByName.has(contract.name)) throw new Error(`Fixed command has no binding: ${contract.name}`);
}

export const FixedCommandBindings: ReadonlyMap<string, (typeof allBindings)[number]> = fixedByName;

export const resolveFixedCommand = (name: string) => fixedByName.get(name);

/** Boot invariant shared by exact automation membership and fixed-name collision checks. */
export const assertCommandNamespace = Effect.fn('Bolt.assertCommandNamespace')(function* () {
	const declared = new Set(
		(yield* Workspace.Service).definition.automations.map(({ name }) => name)
	);
	const implemented = new Set(Object.keys((yield* AuthoredRuntimeService).automations));
	for (const name of new Set([...declared, ...implemented])) {
		if (name.length === 0 || declared.has(name) !== implemented.has(name))
			return yield* new DispatchError({
				code: 'invalid_workspace',
				message: `Automation declaration/runtime disagreement: ${name || '<empty>'}`
			});
		if (fixedByName.has(`automations.${name}`))
			return yield* new DispatchError({
				code: 'invalid_workspace',
				message: `Automation collides with fixed command: automations.${name}`
			});
	}
	for (const name of (yield* RemoteRegistry).names) {
		if (name.length === 0)
			return yield* new DispatchError({
				code: 'invalid_workspace',
				message: 'An authored command name may not be empty'
			});
		if (fixedByName.has(`invoke.${name}`))
			return yield* new DispatchError({
				code: 'invalid_workspace',
				message: `Authored command collides with fixed command: invoke.${name}`
			});
	}
});

export const resolveWorkspaceCommand = Effect.fn('Bolt.resolveWorkspaceCommand')(function* (
	name: string,
	origin: Exclude<InvocationOrigin, 'Plugin'>
) {
	if (name.startsWith('invoke.')) {
		const member = name.slice('invoke.'.length);
		const remotes = yield* RemoteRegistry;
		if (member.length === 0 || !remotes.names.has(member)) return undefined;
		const contract = { ...WorkspaceInvokeContract, name };
		return {
			contract,
			origins: {
				Command: session(`invoke:${member}`)
			},
			handle: (context: ExecutionContext, raw: unknown) =>
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(WorkspaceInvokeContract.input)(raw);
					return json(yield* remotes.invoke(member, input.input, principal(context), context.effectId));
				})
		};
	}
	if (name.startsWith('automations.')) {
		const member = name.slice('automations.'.length);
		const authored = yield* AuthoredRuntimeService;
		const declared = (yield* Workspace.Service).definition.automations.some(({ name }) => name === member);
		const implemented = authored.automations[member] !== undefined;
		if (declared !== implemented)
			return yield* new DispatchError({
				code: 'invalid_workspace',
				message: `Automation declaration/runtime disagreement: ${member}`
			});
		if (member.length === 0 || !declared || origin !== 'Task') return undefined;
		return {
			contract: { ...WorkspaceAutomationContract, name },
			origins: { Task: task(`declared automation:${member}`) },
			handle: (context: ExecutionContext, raw: unknown) =>
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(WorkspaceAutomationContract.input)(raw);
					return json(yield* executeAutomationBody(context, member, input));
				})
		};
	}
	return undefined;
});

export const resolveCompositeCommand = (plugin: string, command: string) => {
	if (plugin !== 'data-browser' || command !== 'query') return undefined;
	return {
		contract: DataBrowserCommandContract,
		origins: { Plugin: session('tenant collection read policy') },
		handle: (context: ExecutionContext, raw: unknown) =>
			Effect.gen(function* () {
				const input = yield* Schema.decodeUnknownEffect(DataBrowserCommandContract.input)(raw);
				const limit = input.input?.limit;
				return json(yield* Effect.provideService(
					(yield* Collections.Service).findMany(context.effectId, principal(context), {
						collection: input.collection,
						...(limit === undefined ? {} : { limit })
					}),
					Identity.CurrentSubject,
					principal(context)
				));
			})
	};
};
