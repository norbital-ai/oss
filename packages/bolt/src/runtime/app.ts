import { Effect, Layer } from 'effect';
import {
	EffectId,
	LeaseId,
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
import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { AccessControl } from './access/access-control.js';
import { Agents } from './agents/agents.js';
import { Approvals } from './approvals/approvals.js';
import { Automations } from './automations/automations.js';
import { Channels } from './channels/channels.js';
import { Collections } from './collections/collections.js';
import { AuthoredRuntimeService, emptyAuthoredRuntime, type AuthoredRuntime } from './collections/authored.js';
import { DispatchError, dispatchInvocation } from './dispatch.js';
import { AI } from './facilities/services.js';
import { Communication } from './facilities/services.js';
import { Connector } from './facilities/services.js';
import { Database, type CallContext } from './facilities/database.js';
import { Files } from './facilities/services.js';
import { HostTools } from './facilities/services.js';
import { IdentityHooks } from './facilities/services.js';
import { Tasks } from './facilities/services.js';
import { Transport } from './facilities/services.js';
import { Identity } from './identity/identity.js';
import { Integrations } from './integrations/integrations.js';
import { Notifications } from './notifications/notifications.js';
import { mergeRuntimeHandlers, remoteRegistryLayer, type RuntimeRemoteHandler, type RuntimeToolHandler } from './remotes.js';
import { WorkspaceSchema } from './schema/workspace-schema.js';
import { Secrets } from './secrets/secrets.js';
import { PersonalSecrets } from './secrets/personal-secrets.js';
import { SecretCipher } from '@norbital-ai/std/secret';
import { Sync } from './sync/sync.js';
import { SyncWake } from './sync/wake.js';
import { Workspace } from './workspace.js';

/** Owns invocation layer behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const InvocationLayers = { make: (workspace: WorkspaceDefinition, facilities: FacilityBindings, context: CallContext, handlers: Readonly<Record<string, RuntimeRemoteHandler>>, authored: AuthoredRuntime = emptyAuthoredRuntime) => {
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
	const access = AccessControl.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database)));
	// Whether a sign-in code is random or the fixed development one follows the environment the host
	// scoped this invocation to — the mode — and not whether a mailer happens to be bound. A mailer
	// is expected in every environment, development included, so its absence is a misconfiguration
	// to surface rather than a signal to reinterpret.
	//
	// Anything that is not exactly `development` is treated as real. An environment this bundle has
	// not heard of gets random codes, which is the safe direction for an unknown to fail in.
	const identity = Identity.layerWith(context.environment !== 'development').pipe(Layer.provide(Layer.mergeAll(database, communication, identityHooks)));
	const approvals = Approvals.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, access, database, tasks)));
	// The wake sits between Collections and the host's transport: Collections announces, the host fans
	// out. It is its own layer rather than part of Sync because Sync depends on Collections, and the
	// announcement has to be available to the thing doing the writing.
	const syncWake = SyncWake.layer.pipe(Layer.provide(transport));
	const collections = Collections.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, access, approvals, database, files, ai, tasks, authoredLayer, syncWake)));
	const sync = Sync.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, access, collections, database)));
	const remotes = remoteRegistryLayer(handlers).pipe(Layer.provide(Layer.mergeAll(collections, ai, files)));
	const agents = Agents.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, access, collections, ai, database, tasks, files, connector, hostTools, remotes)));
	const schema = WorkspaceSchema.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database)));
	// Both vaults seal through the same cipher, so there is one key, one envelope format and one
	// fail-closed refusal rather than two of each. It takes no facility: the key comes from the host's
	// configuration, deliberately not from the tenant database it is protecting.
	const secretCipher = SecretCipher.layer;
	const secrets = Secrets.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database, secretCipher)));
	// No workspace layer: a personal secret has no `+env.ts` declaration to be checked against, because
	// the workspace cannot know in advance which sites a given person will sign in to.
	const personalSecrets = PersonalSecrets.layer.pipe(Layer.provide(Layer.merge(database, secretCipher)));
	const automations = Automations.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, collections, database, tasks, ai, connector, files, hostTools, authoredLayer)));
	const channels = Channels.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, identity, agents, communication, database)));
	// Secrets, because a connection's credential is an `{ env }` reference the vault resolves; AI and
	// Files, because a pull may route a record through the collection's authored `import` pipeline and
	// an authored handler's api carries `infer` and `readFileAsset` whether it uses them or not.
	const integrations = Integrations.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, collections, connector, database, tasks, secrets, ai, files, authoredLayer)));
	const notifications = Notifications.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, identity, database, communication, tasks)));
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
		channels,
		integrations,
		notifications,
		database,
		files,
		ai,
		communication,
		identityHooks,
		connector,
		tasks,
		hostTools,
		transport,
		remotes,
		authoredLayer
	);
} };
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
 * What the artifact asks the host to hold, and — for integrations — to originate.
 *
 * The first list is routing: commands the host may be handed work for. The second is the thing that
 * was missing entirely. Every `+integrations.ts` binding declares a cron, that cron was carried
 * faithfully through the compiler into `workspace.integrations`, and no line of code read it — so a
 * pull ran exactly once, when install or reconcile enqueued one, and the word "schedule" in a
 * template meant nothing. Here it becomes a registration that names the command to run, the cron to
 * run it on, and the input to run it with.
 *
 * Bolt cannot do more than declare it. The artifact is sandboxed tenant code with no timer that
 * outlives an invocation, so the host owns the clock; what Bolt owes the host is a statement it can
 * act on, and a `pull` that is safe to be called by it repeatedly.
 */
const ActivationCommands = { forWorkspace: (workspace: WorkspaceDefinition): ReadonlyArray<KeyedRegistration> => {
	const routed: ReadonlyArray<KeyedRegistration> = [
		'collections.resume',
		'agents.resume',
		'notifications.drain',
		'integrations.pull',
		'integrations.flush',
		'channels.receive',
		...workspace.automations.map(({ name }) => `automations.${name}`)
	]
		.filter((command, index, commands) => commands.indexOf(command) === index)
		.toSorted()
		.map((command) => ({ key: command, registration: { command, schedule: null, input: null } }));
	const scheduled: ReadonlyArray<KeyedRegistration> = workspace.integrations
		.flatMap((integration) =>
			integration.receive.map((binding) => ({
				key: `integrations.pull:${integration.name}.${binding.name}`,
				registration: {
					command: 'integrations.pull',
					schedule: binding.schedule,
					// The binding is named, so a per-binding cron means a per-binding run: an integration
					// whose vendors feed is hourly and whose invoices feed is nightly would otherwise pull
					// both every hour, and the two schedules would be one schedule wearing two hats.
					input: { name: integration.name, binding: binding.name, cursor: null }
				}
			}))
		)
		.toSorted((left, right) => left.key.localeCompare(right.key));
	/**
	 * One drain registration per integration that sends, on a fixed minute cron.
	 *
	 * It is fixed rather than authored because the author has nothing useful to say about it. A send
	 * binding declares *what* to deliver on *which* write; when the queue is emptied is a property of
	 * the platform, and the honest value is "as often as the host's clock can be asked", which is a
	 * minute — the finest granularity a cron expresses and the sweep period Colony's scheduler runs.
	 *
	 * This is also the whole answer to how a retry ever happens. Backoff is a timestamp on the outbox
	 * row rather than a sleep inside an invocation, so something has to come back and look; that
	 * something is this. Without it a delivery that met a 503 would sit `pending` forever and the
	 * retry policy would be a comment.
	 *
	 * A per-integration registration rather than one for all of them, so a partner that is down backs
	 * off its own queue and not everybody's, and so the host can see which integration is costing it.
	 */
	const drained: ReadonlyArray<KeyedRegistration> = workspace.integrations
		.filter((integration) => integration.send.length > 0)
		.map((integration) => ({
			key: `integrations.flush:${integration.name}`,
			registration: {
				command: 'integrations.flush',
				schedule: OUTBOX_DRAIN_SCHEDULE,
				input: { name: integration.name }
			}
		}))
		.toSorted((left, right) => left.key.localeCompare(right.key));
	return [...routed, ...scheduled, ...drained];
} };

/** Every minute — the finest recurrence a cron can state, and the shortest a delivery can wait. */
const OUTBOX_DRAIN_SCHEDULE = '* * * * *';
const activationCommands = ActivationCommands.forWorkspace;

/** Owns activate behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const BundleActivation = { activate: (
	workspace: WorkspaceDefinition,
	manifest: BundleManifest,
	activation: Activation,
	facilities: FacilityBindings,
	signal: AbortSignal
) => {
	const missing = manifest.requiredFacilities.filter((name) => facilities[name] === undefined);
	const effect: Effect.Effect<
		{ _tag: 'Failure'; error: ReturnType<typeof makeWireError> } | { _tag: 'Activated'; registrations: ReadonlyArray<Registration> }
	> = missing.length > 0
		? Effect.succeed({ _tag: 'Failure' as const, error: makeWireError('missing_facility', `Required facilities are not bound: ${missing.join(', ')}`) })
		: Effect.sync(() => activationCommands(workspace)).pipe(
			Effect.flatMap((keyed) => {
				const registrations = keyed.map(({ registration }) => registration);
				if (keyed.length === 0) {
					return Effect.succeed({ _tag: 'Activated' as const, registrations });
				}
				const context: CallContext = { invocationId: activation.id, deadlineEpochMs: activation.deadlineEpochMs, environment: String(activation.scope.environment) };
				const tasks = Tasks.layer(facilities.tasks, context);
				return Effect.gen(function* () {
					const service = yield* Tasks.Service;
					for (const { key, registration } of keyed) {
						yield* service.execute(EffectId.make(`${activation.id}:register:${key}`), {
							_tag: 'Register',
							leaseId: LeaseId.make(activation.id),
							releaseId: activation.scope.releaseId,
							command: registration.command,
							// Written only when there is one, so a routing registration reaches the host as the
							// three fields it has always been rather than as two nulls it has to interpret.
							...(registration.schedule === null
								? {}
								: { schedule: registration.schedule, input: registration.input })
						});
					}
					return { _tag: 'Activated' as const, registrations };
				}).pipe(
					Effect.provide(tasks),
					Effect.catch((error) => Effect.succeed({ _tag: 'Failure' as const, error: makeWireError('activation_failed', error.message, { retryable: error.retryable }) }))
				);
			})
		);
	return Effect.runPromise(effect, { signal });
} };
const activate = BundleActivation.activate;

/** Owns run behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const BundleDispatch = { run: (workspace: WorkspaceDefinition, facilities: FacilityBindings, invocation: Invocation, signal: AbortSignal, remoteHandlers: Readonly<Record<string, RuntimeRemoteHandler>>, authored: AuthoredRuntime = emptyAuthoredRuntime) => {
	const context: CallContext = { invocationId: invocation.id, deadlineEpochMs: invocation.deadlineEpochMs, environment: String(invocation.scope.environment) };
	const effect = dispatchInvocation(invocation).pipe(
		Effect.provide(invocationLayer(workspace, facilities, context, remoteHandlers, authored)),
		Effect.match({
			onFailure: (error): BundleResult => {
				if (error instanceof DispatchError && error.code === 'unauthorized') return { _tag: 'Failure', error: makeWireError('unauthorized', error.message, { httpStatus: 401 }) };
				if (error instanceof Identity.AuthenticationError) return { _tag: 'Failure', error: makeWireError('unauthorized', 'Credential is invalid or expired', { httpStatus: 401 }) };
				// Input the caller got wrong is the caller's error. Every schema-decode failure fell
				// through to the catch-all below and was reported as a 500, which tells a client to
				// retry a request that will never succeed.
				if (error instanceof DispatchError && error.code === 'invalid_input') return { _tag: 'Failure', error: makeWireError('invalid_input', error.message, { httpStatus: 400 }) };
				// Asking for a name `+env.ts` does not declare is the caller getting the name wrong, which
				// is the same class of mistake as any other malformed input.
				if (error instanceof Secrets.SecretNotDeclared) return { _tag: 'Failure', error: makeWireError('invalid_input', error.message, { httpStatus: 400 }) };
				// Asking for a person's own secrets from work that has no person behind it is a refusal, not
				// a malformed request — and reporting it as 403 keeps it distinguishable from an empty vault,
				// which is what a 200 with no entries would have looked like.
				if (error instanceof PersonalSecrets.NoPersonalSubject) return { _tag: 'Failure', error: makeWireError('forbidden', error.message, { httpStatus: 403 }) };
				// A host that configured no encryption key, and a stored value that will not decrypt, are
				// both faults on this side of the wire — the request was well-formed and the caller was
				// entitled to make it. Reported as 500 rather than 400 so nobody is sent to correct input
				// that was never wrong, and named explicitly rather than left to the catch-all so the
				// message reaches the operator intact.
				if (error instanceof SecretCipher.SecretKeyUnavailable || error instanceof SecretCipher.SecretUnreadable)
					return { _tag: 'Failure', error: makeWireError('dispatch_failed', error.message, { httpStatus: 500 }) };
				if (error instanceof AccessControl.AccessDenied || error instanceof DispatchError && error.code === 'tenant_mismatch') {
					const message = error instanceof Error && error.message.trim() !== '' ? error.message : 'Access refused';
					return { _tag: 'Failure', error: makeWireError('forbidden', message, { httpStatus: 403 }) };
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
				const message = error instanceof Error && error.message.trim() !== '' ? error.message : String(error).trim() || 'Dispatch failed';
				return { _tag: 'Failure', error: makeWireError('dispatch_failed', message, { httpStatus: 500 }) };
			},
			onSuccess: (response): BundleResult => ({ _tag: 'Success', response })
		})
	);
	return Effect.runPromise(effect, { signal });
} };
const run = BundleDispatch.run;

/**
 * Runs an authored handler's result to the promise the compiled dispatcher awaits.
 *
 * The authoring surface accepts plain values, promises, and Effect programs; the generated
 * dispatcher routes every handler result through this so an authored `Effect.fn` runs to its
 * output (failures surface as the thrown errors the dispatch boundary already reports) while
 * promise- and value-returning handlers pass through untouched.
 */
export const runAuthoredHandler = (result: unknown): Promise<unknown> =>
	Effect.isEffect(result)
		? Effect.runPromise(result as Effect.Effect<unknown, unknown, never>)
		: Promise.resolve(result);

/** Owns make bundle behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const Bundles = {
	make: (
		workspace: WorkspaceDefinition,
		manifest: BundleManifest,
		remoteHandlers: Readonly<Record<string, RuntimeRemoteHandler>> = {},
		toolHandlers: Readonly<Record<string, RuntimeToolHandler>> = {},
		authored: AuthoredRuntime = emptyAuthoredRuntime
	): BoltBundle => ({
		protocolVersion: PROTOCOL_VERSION,
		manifest,
		dispatch: (invocation, facilities, signal) =>
			run(workspace, facilities, invocation, signal, mergeRuntimeHandlers(remoteHandlers, toolHandlers), authored),
		activate: (activation, facilities, signal) => activate(workspace, manifest, activation, facilities, signal)
	})
};
export const makeBundle = Bundles.make;
