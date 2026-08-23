import { Cause, Clock, Effect, Layer, type Schema } from 'effect';
import {
	EffectId,
	makeWireError,
	PROTOCOL_VERSION,
	type Activation,
	type BoltBundle,
	type BundleManifest,
	type BundleResult,
	type FacilityBindings,
	type Invocation,
	type Registration
} from '@norbital-ai/bolt-protocol';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import type { Declaration } from '#lib/runtime/tasks/queue.js';
import * as Envoys from '#lib/runtime/envoys/envoys.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '#lib/runtime/collections/authored.js';
import { DispatchError, dispatchInvocation } from '#lib/runtime/dispatch.js';
import {
	HostConfig,
	hostConfigFromFacility,
	hostConfigFromProcessEnv
} from '#lib/runtime/access/system-principal.js';
import { AI } from '#lib/runtime/facilities/services.js';
import { Communication } from '#lib/runtime/facilities/services.js';
import { Connector } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import type { CallContext } from '#lib/runtime/facilities/database.js';
import { Files } from '#lib/runtime/facilities/services.js';
import { HostTools } from '#lib/runtime/facilities/services.js';
import { IdentityHooks } from '#lib/runtime/facilities/services.js';
import { Tasks } from '#lib/runtime/facilities/services.js';
import { Transport } from '#lib/runtime/facilities/services.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { reconcileApproverTeams } from '#lib/runtime/identity/approver-teams.js';
import { automationSubject } from '#lib/runtime/identity/static-identity.js';
import { approvalRefusal } from '#lib/compiler/approval-checks.js';
import * as Integrations from '#lib/runtime/integrations/integrations.js';
import * as Notifications from '#lib/runtime/notifications/notifications.js';
import {
	mergeRuntimeHandlers,
	remoteRegistryLayer,
	type RuntimeRemoteHandler
} from '#lib/runtime/remotes.js';
import * as WorkspaceSchema from '#lib/runtime/schema/workspace-schema.js';
import { Secrets } from '#lib/runtime/secrets/secrets.js';
import { PersonalSecrets } from '#lib/runtime/secrets/personal-secrets.js';
import { SecretCipher } from '@norbital-ai/std/secret';
import * as Sync from '#lib/runtime/sync/sync.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
import * as Workspace from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';

/** Owns invocation layer behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const InvocationLayers = {
	make: (
		workspace: WorkspaceDefinition,
		facilities: FacilityBindings,
		context: CallContext,
		handlers: Readonly<Record<string, RuntimeRemoteHandler>>,
		authored: AuthoredRuntime = emptyAuthoredRuntime,
		/**
		 * How deep the chain that produced this invocation already is, read off the payload the
		 * runtime itself stamped when it enqueued the work. Zero for anything a person, a schedule or
		 * a webhook started.
		 */
		depth = 0
	) => {
		/**
		 * The runtime's one handle on the host's own environment, built once and used twice.
		 *
		 * A host that binds a `config` facility supplies values through it — the sandboxed path, where
		 * there is no `process` behind the isolate boundary; a host that does not gets Effect's own
		 * configuration provider, which is the plain-process path. Either way the host is the source, and
		 * a missing value is an absence the runtime fails closed on rather than a default it invents.
		 */
		const hostConfigShape =
			facilities.config === undefined
				? hostConfigFromProcessEnv()
				: hostConfigFromFacility(facilities.config);
		const budget = InvocationBudget.layer(depth);
		// Built from the workspace's own `src/access/+anonymous_limits.ts`, so the policy travels with
		// the bundle and applies identically under Colony, under bolt-server, and in a test. Everything
		// with a holder — a person's budget, an envoy's — is declared on the policies that hold it and
		// resolved per subject; this layer carries only the rules that apply before there is one.
		const rateLimits = RateLimits.layer(workspace.rateLimits);
		const tenantScope = TenantScope.layer(context.tenantId);
		const database = Database.layer(facilities.database, context);
		const files = Files.layer(facilities.files, context);
		const ai = AI.layer(facilities.ai, context);
		const communication = Communication.layer(facilities.communication, context);
		const identityHooks = IdentityHooks.layer(facilities.identityHooks, context);
		const connector = Connector.layer(facilities.connector, context);
		const tasks = Tasks.layer(facilities.tasks, context);
		const hostTools = HostTools.layer(facilities.hostTools, context);
		const transport = Transport.layer(facilities.transport, context);
		const workspaceLayer = Workspace.layer(workspace);
		const authoredLayer = Layer.succeed(AuthoredRuntimeService, authored);
		const access = AccessControl.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, database))
		);
		// Whether a sign-in code is random or the fixed development one follows the environment the host
		// scoped this invocation to — the mode — and not whether a mailer happens to be bound. A mailer
		// is expected in every environment, development included, so its absence is a misconfiguration
		// to surface rather than a signal to reinterpret.
		//
		// Anything that is not exactly `development` is treated as real. An environment this bundle has
		// not heard of gets random codes, which is the safe direction for an unknown to fail in.
		const identity = Identity.layerWith(context.environment !== 'development').pipe(
			Layer.provide(Layer.mergeAll(database, communication, identityHooks))
		);
		/**
		 * The task queue, over the database facility and the host's timer.
		 *
		 * Everything that used to enqueue through the `tasks` facility now writes a row through this —
		 * automations, approvals, integrations, agents and change triggers alike — so there is one
		 * enqueue path and it is a transaction the caller can join. The facility underneath it carries
		 * exactly one runtime message, `Wake`, which is why it is bound here beside `database` rather
		 * than reached for separately by each of those services.
		 */
		const taskQueue = TaskQueue.layer(context).pipe(Layer.provide(Layer.merge(database, tasks)));
		// Approval projections are replicated system collections, so their state transitions publish
		// through the same durable outbox + wake path as authored collection writes.
		const syncWake = SyncWake.layer.pipe(Layer.provide(transport));
		const approvals = Approvals.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, access, database, taskQueue, syncWake))
		);
		/**
		 * Automations, above Collections rather than below it.
		 *
		 * It used to be provided `collections`, and no longer needs to be: starting an automation is a
		 * declaration check, a nesting check, and a row on the queue. The direction has to flip because
		 * `api.automations.run` is part of the api an authored *collection* handler receives, so
		 * Collections is now the consumer. Nothing was lost in the flip — the dependency was already
		 * unused.
		 */
		// `tenantScope`, because an automation's subject is minted here from its declaration rather than
		// inherited from whoever tripped it — and a minted subject needs a tenant that no row can supply.
		const automations = Automations.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, database, taskQueue, budget, tenantScope))
		);
		// The wake sits between Collections and the host's transport: Collections announces, the host fans
		// out. It is its own layer rather than part of Sync because Sync depends on Collections, and the
		// announcement has to be available to the thing doing the writing.
		const collections = Collections.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					workspaceLayer,
					access,
					approvals,
					automations,
					database,
					files,
					ai,
					taskQueue,
					authoredLayer,
					syncWake
				)
			)
		);
		const sync = Sync.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, access, collections, database))
		);
		const remotes = remoteRegistryLayer(handlers).pipe(
			// `automations`, because a remote receives the same authored api a hook does, and that api now
			// carries `automations.run`. One api, one dependency list — a remote that could not start an
			// automation would be the second shape of authored code rather than the same one.
			Layer.provide(Layer.mergeAll(collections, automations, ai, files))
		);
		const agents = Agents.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					workspaceLayer,
					access,
					collections,
					ai,
					database,
					taskQueue,
					files,
					connector,
					hostTools,
					remotes,
					budget
				)
			)
		);
		const schema = WorkspaceSchema.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, database))
		);
		// Both vaults seal through the same cipher, so there is one key, one envelope format and one
		// fail-closed refusal rather than two of each. The key comes from the host's configuration,
		// deliberately not from the tenant database it is protecting — and it comes through the same
		// `HostConfig` seam every other host-provided value does.
		//
		// It used to read `ConfigProvider` directly, which is unreachable from where this actually
		// runs. A tenant runtime executes in a `vm` context with no `process` global, so inside an
		// isolate that read returned nothing, silently, and every write to either vault refused with
		// "BOLT_SECRETS_KEY is not set" on a host that had set it. `hostConfigFromProcessEnv` keeps the
		// plain-process route identical for bolt-server and for tests.
		const secretCipher = SecretCipher.layerFrom(hostConfigShape);
		const secrets = Secrets.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, database, secretCipher))
		);
		// No workspace layer: a personal secret has no `+env.ts` declaration to be checked against, because
		// the workspace cannot know in advance which sites a given person will sign in to.
		const personalSecrets = PersonalSecrets.layer.pipe(
			Layer.provide(Layer.merge(database, secretCipher))
		);
		// `access` and `rateLimits`, because an envoy's own ceiling is now the `limits` of the policies
		// it declares — resolved for its minted subject rather than counted in SQL against a per-envoy
		// column that only ever said the same thing twice. `tenantScope`, because a static identity is
		// minted with a tenant and has no row to read one off.
		const envoys = Envoys.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					workspaceLayer,
					identity,
					agents,
					communication,
					database,
					access,
					rateLimits,
					tenantScope
				)
			)
		);
		// Secrets, because a connection's credential is an `{ env }` reference the vault resolves; AI and
		// Files, because a pull may route a record through the collection's authored `import` pipeline and
		// an authored handler's api carries `infer` and `readFileAsset` whether it uses them or not.
		const integrations = Integrations.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					workspaceLayer,
					collections,
					automations,
					connector,
					database,
					taskQueue,
					secrets,
					ai,
					files,
					authoredLayer
				)
			)
		);
		const notifications = Notifications.layer.pipe(
			Layer.provide(Layer.mergeAll(workspaceLayer, identity, database, communication, tasks))
		);
		const hostConfig = Layer.succeed(HostConfig, hostConfigShape);
		return Layer.mergeAll(
			workspaceLayer,
			access,
			identity,
			collections,
			approvals,
			sync,
			agents,
			schema,
			secrets,
			personalSecrets,
			automations,
			envoys,
			integrations,
			notifications,
			database,
			files,
			ai,
			communication,
			identityHooks,
			connector,
			tasks,
			taskQueue,
			hostTools,
			transport,
			remotes,
			authoredLayer,
			hostConfig,
			budget,
			rateLimits,
			tenantScope
		);
	}
};
const invocationLayer = InvocationLayers.make;

/**
 * One registration, plus the key that keeps two registrations of the same command apart.
 *
 * The key becomes the `EffectId` of the `Register` facility call, and a host treats that id as the
 * idempotency key for the operation. `integrations.pull` is registered once for routing and once per
 * scheduled binding, so keying purely on the command name would collapse every scheduled pull into
 * the routing registration and the host would hold exactly one of them.
 */
type KeyedRegistration = Readonly<{ readonly key: string; readonly registration: Registration }>;

/**
 * What the artifact asks the host to route to it, and what it asks itself to do on a clock.
 *
 * Two lists, and the split is the seam. **Registrations** are routing and nothing else — the command
 * names a host may be handed work for. **Schedules** are recurrence, and they are no longer told to
 * anybody: they are rows the guest writes into the tenant's own `bolt_schedule`, because the guest
 * is the party that can read what a release declares and a host holding a cron string would have to
 * learn cron grammar to act on one.
 *
 * That is the whole of why every `0 6 * * *` in `templates/` had never fired. The cron was authored,
 * carried faithfully through the compiler into `workspace.automations` and `workspace.integrations`,
 * and read by nothing: a grep for `trigger._tag` across the runtime returned one hit, `'Change'`. A
 * schedule was a field with no reader, on either side of the seam.
 */
/**
 * Exported for the schedule-parity artifact, which diffs this against the registry it replaced.
 *
 * The failure mode of this change is that a schedule stops existing, and a schedule that stops
 * existing raises nothing, fails nothing and logs nothing — a green suite certifies it as fine. The
 * only proof is a set diff of the schedules themselves, so the thing being diffed has to be
 * reachable from a test.
 */
export const ActivationCommands = {
	forWorkspace: (workspace: WorkspaceDefinition): ReadonlyArray<KeyedRegistration> =>
		[
			'collections.resume',
			'collections.discard',
			'agents.turn',
			'agents.resume',
			'notifications.drain',
			'integrations.pull',
			'integrations.flush',
			'envoys.receive',
			// The tick, which is the one command a host's timer ever sends. A host that cannot route it
			// still holds correct data — rows commit, schedules advance, retries are scheduled — it just
			// loses punctuality, because nothing fires until somebody invokes this.
			'tasks.tick',
			...workspace.automations.map(({ name }) => `automations.${name}`)
		]
			.filter((command, index, commands) => commands.indexOf(command) === index)
			.toSorted()
			.map((command): KeyedRegistration => ({ key: command, registration: { command } })),
	/**
	 * Everything this release says should happen on a cron, as rows for `bolt_schedule`.
	 *
	 * One key per *binding* rather than per integration, because a vendors feed that is hourly and an
	 * invoices feed that is nightly are two schedules and not one wearing two hats.
	 *
	 * There is deliberately nothing here for outbound deliveries. Those used to carry a fixed
	 * `* * * * *` drain per sending integration — which is what pinned every sending tenant's database
	 * awake permanently, 1440 wakes a day, whether or not anything was ever queued. A delivery is now
	 * enqueued by the write that caused it, in that write's own transaction, and a delivery that backs
	 * off schedules its own return. Nothing needs to come and look.
	 */
	schedulesFor: (workspace: WorkspaceDefinition, tenantId: string): ReadonlyArray<Declaration> =>
		[
			...workspace.automations.flatMap((automation) =>
				automation.trigger._tag === 'Schedule'
					? [
							{
								key: `automations.${automation.name}`,
								command: `automations.${automation.name}`,
								crontab: automation.trigger.cron,
								// No `bolt_run_as`: a scheduled automation has no person behind it, and stamping a
								// fabricated subject here is how work with no author comes to look authored.
								// The automation's own subject, stamped here exactly as `Automations.start` stamps
								// one at the other enqueue point. The comment this replaces said a scheduled
								// automation has no person behind it and refused to fabricate one — which was
								// right about the person and wrong about the conclusion: `AutomationTaskInput`
								// requires `bolt_run_as`, so every cron automation in every template failed to
								// decode, and `schedule-parity.test.ts` asserts the schedule rows without ever
								// dispatching one. There is no person; there is a static identity, and it is the
								// automation's own declared authority.
								input: {
									args: {},
									scope: {},
									bolt_run_as: automationSubject(automation, tenantId)
								} satisfies Schema.Json
							}
						]
					: []
			),
			...workspace.integrations.flatMap((integration) =>
				integration.receive.flatMap((binding) =>
					binding.schedule === null || binding.schedule === undefined
						? []
						: [
								{
									key: `integrations.pull:${integration.name}.${binding.name}`,
									command: 'integrations.pull',
									crontab: binding.schedule,
									input: {
										name: integration.name,
										binding: binding.name,
										cursor: null
									}
								}
							]
				)
			)
		].toSorted((left, right) => left.key.localeCompare(right.key))
};

/** The call context an activation's facility calls are made under. One shape, built once. */
const activationContext = (activation: Activation): CallContext => ({
	invocationId: activation.id,
	deadlineEpochMs: activation.deadlineEpochMs,
	environment: String(activation.scope.environment),
	tenantId: String(activation.scope.tenantId)
});

/**
 * The two facilities an activation needs, and the queue built over them.
 *
 * Activation is the one path that talks to the database outside an invocation: it registers the
 * release's routing with the host, and it writes this release's schedules into the tenant's own
 * `bolt_schedule`. Both are bound from the same call context, so the deadline that bounds the
 * activation is the deadline every one of its facility calls carries.
 */
const activationLayer = (activation: Activation, facilities: FacilityBindings) => {
	const context = activationContext(activation);
	const tasks = Tasks.layer(facilities.tasks, context);
	const database = Database.layer(facilities.database, context);
	// The database is merged into the result rather than only provided to the queue: activation now
	// writes to the tenant itself — the `team` rows an approval step names — and not only through
	// `bolt_schedule`. Provided-but-not-merged left `Database.Service` unavailable to the activation
	// body, which is a compile error rather than a silent one, but the shape is worth stating: what
	// activation may touch is exactly these two facilities.
	return Layer.mergeAll(
		tasks,
		database,
		TaskQueue.layer(context).pipe(Layer.provide(Layer.merge(database, tasks)))
	);
};

/** Owns activate behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const BundleActivation = {
	activate: (
		workspace: WorkspaceDefinition,
		manifest: BundleManifest,
		activation: Activation,
		facilities: FacilityBindings,
		signal: AbortSignal
	) => {
		const missing = manifest.requiredFacilities.filter((name) => facilities[name] === undefined);
		/**
		 * A release whose approval bindings do not resolve, refused before it serves anything.
		 *
		 * Same guard as a missing facility and for the same reason: the release states what it needs,
		 * and a statement that cannot be satisfied is not something to activate and find out about
		 * later. The failure it prevents is silent — an approval routed to a team nobody holds waits
		 * for a decision that can never come, and "waiting" is indistinguishable from "not decided
		 * yet" on every surface that shows it.
		 *
		 * This deliberately *does* fail activation where `reconcileApproverTeams` below deliberately
		 * does not, and the difference is what is being compared. The reconciler compares a release
		 * against `team` **rows**, which an operator edits from a dashboard at any moment — so a
		 * disagreement there is an ordinary state and taking a workspace down over it would be wrong.
		 * These three rules compare two artifacts that both ship *inside* the release: `+teams.ts` and
		 * the policy files. Nothing can move them apart after a build, so a disagreement is not drift,
		 * it is a release that was never coherent, and no amount of waiting will fix it.
		 */
		const approvalsRefused = approvalRefusal(workspace);
		const effect: Effect.Effect<
			| { _tag: 'Failure'; error: ReturnType<typeof makeWireError> }
			| {
					_tag: 'Activated';
					registrations: ReadonlyArray<Registration>;
					nextDueAtEpochMs: number | null;
			  }
		> =
			missing.length > 0
				? Effect.succeed({
						_tag: 'Failure' as const,
						error: makeWireError(
							'missing_facility',
							`Required facilities are not bound: ${missing.join(', ')}`
						)
					})
				: approvalsRefused !== undefined
					? Effect.succeed({
							_tag: 'Failure' as const,
							error: makeWireError('unroutable_approval', approvalsRefused)
						})
					: Effect.gen(function* () {
							/**
							 * Every team an approval step names, made to exist before the release serves traffic.
							 *
							 * Here, and not earlier, because this is the first point in the sequence at which the
							 * table is there to write to: `reconcileRelease` registers the route, forks the
							 * database and runs `schema.migrate` — which is what creates `team`, an identity
							 * collection `identitySchemaSteps` already puts ahead of migration — and only then
							 * activates. Anything before that would be inserting into a table that does not exist
							 * yet; anything after is a workspace already answering requests, and the approval it
							 * cannot route is the first one somebody raises.
							 *
							 * Beside the schedule declaration rather than woven into it, because it is the same
							 * kind of step: the release states what the tenant must contain, and activation is
							 * where that statement is made true. It neither reads nor is read by the two steps
							 * around it, so its position among them is not load-bearing.
							 *
							 * It cannot fail the activation. `reconcileApproverTeams` reports and steps over its
							 * own faults and returns a `never` error channel, which is the same temperament
							 * `policiesHeldByTeam` has for the same binding: a workspace is not taken down over a
							 * string that two independently-moving sides disagree about.
							 */
							yield* reconcileApproverTeams(
								EffectId.make(`${activation.id}:approver-teams`),
								workspace
							);
							const keyed = ActivationCommands.forWorkspace(workspace);
							const registrations = keyed.map(({ registration }) => registration);
							const service = yield* Tasks.Service;
							for (const { key, registration } of keyed) {
								yield* service.execute(EffectId.make(`${activation.id}:register:${key}`), {
									_tag: 'Register',
									releaseId: activation.scope.releaseId,
									command: registration.command
								});
							}
							/**
							 * Where every cron in every template starts existing.
							 *
							 * Upsert what this release declares, delete what it does not, and answer with the next
							 * instant anything is due. A key's `next_run_at` survives a redeploy unless its
							 * expression changed — a deploy is not an event a schedule should observe, and
							 * re-arming on every one is how a nightly digest quietly stops firing on a busy day.
							 *
							 * A schedule seeded here is armed from *now*, never from a past occurrence, so a
							 * release activating for the first time has no history to catch up on and fires next at
							 * its next ordinary occurrence.
							 */
							const nowEpochMs = yield* Clock.currentTimeMillis;
							const declared = yield* (yield* TaskQueue.Service).declare(
								EffectId.make(`${activation.id}:schedules`),
								ActivationCommands.schedulesFor(workspace, activation.scope.tenantId),
								nowEpochMs
							);
							for (const rejection of declared.rejections) {
								// Loud, and at the one moment a person is watching: a deploy. An expression that
								// cannot be read can never fire, and the alternative to saying so here is a schedule
								// that is simply absent with nothing anywhere to explain it.
								yield* Effect.logError(
									`activation: dropped schedule ${rejection.key}: ${JSON.stringify(rejection.crontab)}: ${rejection.reason}`
								);
							}
							return {
								_tag: 'Activated' as const,
								registrations,
								nextDueAtEpochMs: declared.nextDueAtEpochMs ?? null
							};
						}).pipe(
							Effect.provide(activationLayer(activation, facilities)),
							Effect.catch((error) =>
								Effect.succeed({
									_tag: 'Failure' as const,
									error: makeWireError('activation_failed', error.message, {
										retryable: error.retryable
									})
								})
							)
						);
		// Activation is bounded by its own deadline for the same reason dispatch is: registering a
		// release's durable callbacks talks to the host's task facility, and a host that never answers
		// would otherwise leave a deploy hanging with no report of why.
		return Effect.runPromise(
			Effect.flatMap(Clock.currentTimeMillis, (nowEpochMs) =>
				effect.pipe(
					Effect.timeout(remainingMillis(activation.deadlineEpochMs, nowEpochMs)),
					Effect.catch(() =>
						Effect.succeed({
							_tag: 'Failure' as const,
							error: makeWireError(
								'deadline_exceeded',
								'Activation did not finish inside its deadline',
								{ retryable: true }
							)
						})
					)
				)
			),
			{ signal }
		);
	}
};
const activate = BundleActivation.activate;

/**
 * How long an invocation has left, as a duration rather than an instant.
 *
 * Floored at one millisecond rather than zero. A deadline that has already passed is a real state —
 * a queued task the host held longer than it budgeted for — and the answer to it is the same
 * `deadline_exceeded` every other overrun gets, reached by timing out immediately. Passing a
 * non-positive duration instead would be read as "no limit" by some combinators, which is precisely
 * backwards.
 */
const remainingMillis = (deadlineEpochMs: number, nowEpochMs: number): number =>
	Math.max(1, deadlineEpochMs - nowEpochMs);

/** Owns run behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const BundleDispatch = {
	run: (
		workspace: WorkspaceDefinition,
		facilities: FacilityBindings,
		invocation: Invocation,
		signal: AbortSignal,
		remoteHandlers: Readonly<Record<string, RuntimeRemoteHandler>>,
		authored: AuthoredRuntime = emptyAuthoredRuntime
	) => {
		const context: CallContext = {
			invocationId: invocation.id,
			deadlineEpochMs: invocation.deadlineEpochMs,
			environment: String(invocation.scope.environment),
			tenantId: String(invocation.scope.tenantId)
		};
		const provided = dispatchInvocation(invocation).pipe(
			Effect.provide(
				invocationLayer(
					workspace,
					facilities,
					context,
					remoteHandlers,
					authored,
					// Only a `Task` carries a depth, because only enqueued work has a parent. A command a
					// person sent, a request, a webhook and a realtime frame all start their own chain.
					invocation._tag === 'Task' ? InvocationBudget.depthOf(invocation.input) : 0
				)
			)
		);
		// The invocation deadline, enforced where every host gets it rather than only where one
		// host remembered to. `deadlineEpochMs` has ridden on every invocation since the protocol
		// was written and was read by nothing but the facility metadata: bolt-server wrapped its
		// own `Effect.timeout` around dispatch, and Colony wrapped nothing at all, so on the
		// hosting platform an invocation that never settled held its slot until the process died.
		//
		// This bounds *the tree*, which is a different job from the isolate's CPU-span budget and
		// from a facility's own statement or request timeout. It can only interrupt work that
		// yields — a tenant loop that never awaits is unreachable from inside the runtime, and
		// bounding that is the host's, because only the host can terminate the thread.
		//
		// Every nested piece of work under this invocation shares this one deadline by
		// construction: a hook chain, an import pipeline and an agent's tool calls are all the
		// same fiber tree, so none of them can be given a fresh budget by running deeper.
		// The remaining time is read through the Clock at execution rather than at construction, so
		// the deadline is measured against the instant the invocation actually starts.
		const effect = Effect.flatMap(Clock.currentTimeMillis, (nowEpochMs) =>
			Effect.timeout(provided, remainingMillis(invocation.deadlineEpochMs, nowEpochMs))
		).pipe(
			Effect.match({
				onFailure: (raised): BundleResult => {
					/**
					 * A batched write says which phase it failed in by wrapping the failure that says
					 * why, so the mapping below has to look through the wrapper before it looks at
					 * anything else.
					 *
					 * Unwrapped here, once, rather than added as a branch: every test in this chain is an
					 * `instanceof` against a specific error, and a wrapper the chain did not know about
					 * would fail all of them and fall through to `dispatch_failed` — so an authored
					 * refusal on a batched create would have gone back to being a 500, which is precisely
					 * the regression `AuthoredRefusal` exists to prevent. The phase is carried alongside
					 * and attached to whatever the chain decides, so it adds a fact without moving one.
					 */
					const phase =
						raised instanceof Collections.MutationPhaseFailure
							? {
									phase: raised.phase,
									...(raised.committed.length === 0 ? {} : { committed: raised.committed })
								}
							: undefined;
					const error = Collections.unwrapMutationPhase(raised);
					if (error instanceof DispatchError && error.code === 'unauthorized')
						return {
							_tag: 'Failure',
							error: makeWireError('unauthorized', error.message, { httpStatus: 401 })
						};
					if (error instanceof Identity.AuthenticationError)
						return {
							_tag: 'Failure',
							error: makeWireError('unauthorized', 'Credential is invalid or expired', {
								httpStatus: 401
							})
						};
					// Input the caller got wrong is the caller's error. Every schema-decode failure fell
					// through to the catch-all below and was reported as a 500, which tells a client to
					// retry a request that will never succeed.
					if (error instanceof DispatchError && error.code === 'invalid_input')
						return {
							_tag: 'Failure',
							error: makeWireError('invalid_input', error.message, { httpStatus: 400 })
						};
					// Asking for a name `+env.ts` does not declare is the caller getting the name wrong, which
					// is the same class of mistake as any other malformed input.
					if (error instanceof Secrets.SecretNotDeclared)
						return {
							_tag: 'Failure',
							error: makeWireError('invalid_input', error.message, { httpStatus: 400 })
						};
					// Asking for a person's own secrets from work that has no person behind it is a refusal, not
					// a malformed request — and reporting it as 403 keeps it distinguishable from an empty vault,
					// which is what a 200 with no entries would have looked like.
					if (error instanceof PersonalSecrets.NoPersonalSubject)
						return {
							_tag: 'Failure',
							error: makeWireError('forbidden', error.message, { httpStatus: 403 })
						};
					// A host that configured no encryption key, and a stored value that will not decrypt, are
					// both faults on this side of the wire — the request was well-formed and the caller was
					// entitled to make it. Reported as 500 rather than 400 so nobody is sent to correct input
					// that was never wrong, and named explicitly rather than left to the catch-all so the
					// message reaches the operator intact.
					if (
						error instanceof SecretCipher.SecretKeyUnavailable ||
						error instanceof SecretCipher.SecretUnreadable
					)
						return {
							_tag: 'Failure',
							error: makeWireError('dispatch_failed', error.message, { httpStatus: 500 })
						};
					if (
						error instanceof AccessControl.AccessDenied ||
						(error instanceof DispatchError && error.code === 'tenant_mismatch')
					) {
						const message =
							error instanceof Error && error.message.trim() !== ''
								? error.message
								: 'Access refused';
						return {
							_tag: 'Failure',
							error: makeWireError('forbidden', message, { httpStatus: 403 })
						};
					}
					// A business rule said no. 422 rather than 500 because nothing is broken: the request was
					// well formed and the caller was entitled to make it, and the answer is the sentence the
					// author wrote. It arrives here as a typed failure only because `runAuthoredHandler`
					// lifts it out of the defect channel — before that it bypassed this whole match and
					// reported as an infrastructure fault, which is what made "you may not" and "we broke"
					// indistinguishable to every consumer.
					//
					// `details` carries the site rather than folding it into the message, because the message
					// is the part a person reads and it should stay exactly as authored.
					// The tree ran out of time. 504 rather than 500: nothing is known to be broken, the work
					// simply did not finish inside the budget the host granted it, and a caller reading
					// this should decide whether to retry rather than go looking for a fault.
					// Work that tried to nest past the host's limit. Reported as the caller's problem rather
					// than a fault, because it is: something in the workspace is enqueueing work that
					// enqueues itself, and the sentence names the chain rather than the symptom.
					// Over the workspace's own declared limit. 429 with `Retry-After`, because the caller is
					// not wrong and nothing is broken — they are early, and the honest answer says how
					// early. Reported distinctly from a bot check or a blocked domain, which the surface
					// this replaces collapsed into one `too-many-attempts` reason for every guard it ran.
					if (error instanceof RateLimits.RateLimited)
						return {
							_tag: 'Failure',
							error: makeWireError('rate_limited', error.message, {
								httpStatus: 429,
								retryable: true,
								details: { retryAfterSeconds: error.retryAfterSeconds, command: error.command }
							})
						};
					if (error instanceof InvocationBudget.NestingLimitExceeded)
						return {
							_tag: 'Failure',
							error: makeWireError('nesting_limit_exceeded', error.message, { httpStatus: 422 })
						};
					if (Cause.isTimeoutError(error))
						return {
							_tag: 'Failure',
							error: makeWireError(
								'deadline_exceeded',
								'The invocation did not finish inside its deadline',
								{ httpStatus: 504, retryable: true }
							)
						};
					if (error instanceof AuthoredRefusal) {
						const details: Record<string, Schema.Json> = {};
						if (error.collection !== undefined) details.collection = error.collection;
						if (error.action !== undefined) details.action = error.action;
						if (phase !== undefined) Object.assign(details, phase);
						return {
							_tag: 'Failure',
							error: makeWireError('refused', error.message, {
								httpStatus: 422,
								details
							})
						};
					}
					if (error instanceof Collections.PendingApproval) {
						return {
							_tag: 'Success',
							response: {
								status: 202,
								headers: {},
								value: {
									pending: true,
									requestId: error.requestId,
									collection: error.collection,
									id: error.id,
									action: error.action
								}
							}
						};
					}
					const message =
						error instanceof Error && error.message.trim() !== ''
							? error.message
							: String(error).trim() || 'Dispatch failed';
					return {
						_tag: 'Failure',
						error: makeWireError(
							'dispatch_failed',
							message,
							phase === undefined ? { httpStatus: 500 } : { httpStatus: 500, details: phase }
						)
					};
				},
				onSuccess: (response): BundleResult => ({ _tag: 'Success', response })
			})
		);
		return Effect.runPromise(effect, { signal });
	}
};
const run = BundleDispatch.run;

/** Owns make bundle behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const Bundles = {
	make: (
		workspace: WorkspaceDefinition,
		manifest: BundleManifest,
		remoteHandlers: Readonly<Record<string, RuntimeRemoteHandler>> = {},
		toolHandlers: Readonly<Record<string, RuntimeRemoteHandler>> = {},
		authored: AuthoredRuntime = emptyAuthoredRuntime
	): BoltBundle => ({
		protocolVersion: PROTOCOL_VERSION,
		manifest,
		dispatch: (invocation, facilities, signal) =>
			run(
				workspace,
				facilities,
				invocation,
				signal,
				mergeRuntimeHandlers(remoteHandlers, toolHandlers),
				authored
			),
		activate: (activation, facilities, signal) =>
			activate(workspace, manifest, activation, facilities, signal)
	})
};
export const makeBundle = Bundles.make;
