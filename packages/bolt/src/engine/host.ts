// One immutable activation graph. Every shared bottom service is built once in this generation's layer scope.
import { ConfigProvider, Crypto, Deferred, Effect, FileSystem, Layer, Path, PubSub } from 'effect';
import { declared_secrets, layered, type EngineManifest } from './manifest.ts';
import type { EngineError } from './errors.ts';
import {
	Activation,
	Agents,
	Automations,
	Approvals,
	Callables,
	Conversations,
	Deadlines,
	Decisions,
	Envoys,
	Facilities,
	Guest,
	Identity,
	Links,
	Live,
	Manifest,
	Outbound,
	Reads,
	RunEnds,
	RunHandlers,
	Runs,
	Telemetry,
	Turns,
	Wake,
	Writes
} from './services.ts';
import {
	Ai,
	Browser,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Docs,
	Geo,
	GuestIsolates,
	Http,
	Images,
	Keys,
	Logs,
	Mcp,
	Transport,
	WebRead
} from './ports.ts';
import { TenantDb } from './db/tenant-db.ts';
import { Audit, auditChanges } from './audit.ts';
import { recoverAudit } from './audit-operation.ts';
import { Secrets } from './secrets.ts';
import { ReadsLive } from './query/engine.ts';
import { WritesLive } from './write/act.ts';
import { CallablesLive } from './callables/index.ts';
import { ApprovalsLive } from './approvals/approvals.ts';
import { DecisionsLive } from './decision.ts';
import { IdentityLive } from './identity/session.ts';
import { LiveHubLive } from './live/hub.ts';
import { DeadlinesLive } from './runs/deadlines.ts';
import { RunHandlersLive, RunsLive, WakeLive } from './runs/index.ts';
import { AutomationsLive } from './runs/invoke.ts';
import { ConversationsLive } from './conversations/index.ts';
import { EnvoysLive } from './envoys/index.ts';
import { TurnHandlers, TurnsLive } from './agent/turns.ts';
import { MessageQueue } from './agent/queue.ts';
import { SmartThrottle, SmartThrottleLive } from './agent/throttle.ts';
import { AgentDrains, AgentsLive } from './agent/index.ts';
import { LinksLive } from './integrations/links.ts';
import { Syncs, SyncsLive } from './sync/index.ts';
import { OutboundLive } from './integrations/outbound.ts';
import { FacilitiesLive } from './facilities.ts';
import { GuestLive } from './guest/runner.ts';
import { TelemetryLive } from './guest/telemetry.ts';

export type EngineServices =
	| Manifest
	| Secrets
	| Reads
	| Writes
	| Automations
	| Callables
	| Approvals
	| Decisions
	| Identity
	| Live
	| Runs
	| RunHandlers
	| Deadlines
	| Wake
	| Conversations
	| Envoys
	| Turns
	| Agents
	| Links
	| Syncs
	| Outbound
	| Facilities
	| Guest
	| Telemetry
	| RunEnds
	| TurnHandlers
	| SmartThrottle
	| MessageQueue
	| AgentDrains;
export type EngineHost =
	| Crypto.Crypto
	| TenantDb
	| Activation
	| Files
	| Convert
	| WebRead
	| Browser
	| Geo
	| Docs
	| Transport
	| DeadlinePort
	| Drivers
	| Ai
	| GuestIsolates
	| Keys
	| Http
	| Images
	| Mcp
	| Logs
	| FileSystem.FileSystem
	| Path.Path;

export function EngineLive(
	manifest: EngineManifest
): Layer.Layer<EngineServices, EngineError, EngineHost> {
	const values = Layer.succeed(Manifest, layered(manifest));
	const secrets = Secrets.layer(declared_secrets(manifest)).pipe(Layer.provideMerge(values));
	const config = ConfigProvider.layer(Effect.map(Secrets, (secrets) => secrets.config)).pipe(
		Layer.provide(secrets)
	);
	const bottom = Layer.mergeAll(
		Layer.effectDiscard(
			Effect.gen(function* () {
				const db = yield* TenantDb;
				const audit = yield* Audit;
				if (audit.mode === 'disabled') return;
				// Subscribe before the startup scan so an append during recovery cannot lose its wake.
				const changes = yield* auditChanges(audit);
				const recover = recoverAudit(db).pipe(
					Effect.catch((error) => Effect.logWarning(error).pipe(Effect.as(true)))
				);
				// Startup failures remain retryable, including a tenant whose schema is not installed yet. The scan waits for
				// the generation's first statement, so a cold start makes no trip to the database.
				const scanned = yield* Deferred.make<void>();
				let unresolved = false;
				db.owe(
					Effect.flatMap(recover, (open) =>
						Effect.sync(() => {
							unresolved = open;
						}).pipe(Effect.andThen(Deferred.succeed(scanned, undefined)), Effect.asVoid)
					)
				);
				yield* Effect.forkScoped(
					Effect.andThen(
						Deferred.await(scanned),
						Effect.forever(
							Effect.suspend(() =>
								unresolved
									? PubSub.take(changes).pipe(
											Effect.raceFirst(Effect.void.pipe(Effect.delay('5 seconds')))
										)
									: PubSub.take(changes)
							).pipe(
								Effect.andThen(recover),
								Effect.tap((pending) =>
									Effect.sync(() => {
										unresolved = pending;
									})
								)
							)
						)
					)
				);
			})
		),
		DecisionsLive,
		TelemetryLive,
		TurnsLive,
		DeadlinesLive,
		RunHandlersLive
	).pipe(Layer.provideMerge(values));
	const wake = WakeLive.pipe(Layer.provideMerge(bottom));
	const guest = GuestLive.pipe(Layer.provideMerge(wake));
	const reads = ReadsLive.pipe(Layer.provideMerge(guest));
	const live = LiveHubLive.pipe(Layer.provideMerge(reads));
	const identity = IdentityLive.pipe(Layer.provideMerge(live));
	const links = LinksLive.pipe(Layer.provideMerge(identity));
	const writes = WritesLive.pipe(Layer.provideMerge(links));
	const callables = CallablesLive.pipe(Layer.provideMerge(writes));
	const approvals = ApprovalsLive.pipe(Layer.provideMerge(callables));
	const facilities = Layer.mergeAll(FacilitiesLive, SyncsLive, OutboundLive).pipe(
		Layer.provideMerge(approvals)
	);
	const automations = AutomationsLive.pipe(Layer.provideMerge(facilities));
	const conversations = ConversationsLive.pipe(Layer.provideMerge(automations));
	const throttle = SmartThrottleLive.pipe(Layer.provideMerge(conversations));
	const agents = AgentsLive.pipe(Layer.provideMerge(throttle));
	const envoys = EnvoysLive.pipe(Layer.provideMerge(agents));
	return RunsLive.pipe(
		Layer.provideMerge(envoys),
		Layer.provideMerge(secrets),
		Layer.provide(config)
	);
}
