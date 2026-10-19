// One immutable activation graph. Every shared bottom service is built once in this generation's layer scope.
import { ConfigProvider, Crypto, Effect, Layer } from 'effect';
import { declaredSecrets, layered, type EngineManifest } from './manifest.ts';
import type { EngineError } from './errors.ts';
import {
	Activation,
	Agents,
	Approvals,
	Callables,
	Conversations,
	Deadlines,
	Decisions,
	Envoys,
	Facilities,
	Feeds,
	Guest,
	Identity,
	Isolates,
	Links,
	Live,
	Manifest,
	Outbound,
	Pipelines,
	Reads,
	RunHandlers,
	Runs,
	Telemetry,
	Turns,
	Wake,
	Writes
} from './services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead
} from './ports.ts';
import { TenantDb } from './db/tenant-db.ts';
import { Secrets } from './secrets.ts';
import { ReadsLive } from './query/engine.ts';
import { WritesLive } from './write/act.ts';
import { CallablesLive } from './callables/index.ts';
import { ApprovalsLive } from './approvals/approvals.ts';
import { PipelinesLive } from './pipelines/pipeline.ts';
import { DecisionsLive } from './decisions/index.ts';
import { IdentityLive } from './identity/session.ts';
import { LiveHubLive } from './live/hub.ts';
import { DeadlinesLive } from './runs/deadlines.ts';
import { Nudges, RunHandlersLive, RunsLive, WakeLive } from './runs/index.ts';
import { ConversationsLive } from './conversations/index.ts';
import { EnvoysLive } from './envoys/index.ts';
import { TurnHandlers, TurnsLive } from './agent/turns.ts';
import { TriageLive, TriageService } from './agent/triage.ts';
import { AgentDrains, AgentsLive } from './agent/index.ts';
import { LinksLive } from './integrations/links.ts';
import { FeedsLive } from './integrations/feeds.ts';
import { OutboundLive } from './integrations/outbound.ts';
import { FacilitiesLive } from './facilities.ts';
import { GuestLive, IsolatesLive, PreparedIsolates } from './guest/runner.ts';
import { TelemetryLive } from './guest/telemetry.ts';

export type EngineServices =
	| Manifest
	| Secrets
	| Reads
	| Writes
	| Callables
	| Approvals
	| Pipelines
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
	| Feeds
	| Outbound
	| Facilities
	| Guest
	| Isolates
	| Telemetry
	| PreparedIsolates
	| Nudges
	| TurnHandlers
	| TriageService
	| AgentDrains;
export type EngineHost =
	| Crypto.Crypto
	| TenantDb
	| Activation
	| Files
	| Convert
	| Speech
	| WebRead
	| Geo
	| Metering
	| Transport
	| DeadlinePort
	| Drivers
	| Ai;

export function EngineLive(
	manifest: EngineManifest
): Layer.Layer<EngineServices, EngineError, EngineHost> {
	const values = Layer.succeed(Manifest, layered(manifest));
	const secrets = Layer.unwrap(
		Effect.map(Activation, (activation) =>
			Secrets.layer(declaredSecrets(manifest), activation.secretsKey)
		)
	).pipe(Layer.provideMerge(values));
	const config = ConfigProvider.layer(Effect.map(Secrets, (secrets) => secrets.config)).pipe(
		Layer.provide(secrets)
	);
	const bottom = Layer.mergeAll(
		IdentityLive,
		DecisionsLive,
		TelemetryLive,
		IsolatesLive,
		TurnsLive,
		DeadlinesLive,
		RunHandlersLive
	).pipe(Layer.provideMerge(values));
	const wake = WakeLive.pipe(Layer.provideMerge(bottom));
	const guest = GuestLive.pipe(Layer.provideMerge(wake));
	const reads = ReadsLive.pipe(Layer.provideMerge(guest));
	const live = LiveHubLive.pipe(Layer.provideMerge(reads));
	const links = LinksLive.pipe(Layer.provideMerge(live));
	const writes = WritesLive.pipe(Layer.provideMerge(links));
	const callables = CallablesLive.pipe(Layer.provideMerge(writes));
	const approvals = ApprovalsLive.pipe(Layer.provideMerge(callables));
	const pipelines = PipelinesLive.pipe(Layer.provideMerge(approvals));
	const facilities = Layer.mergeAll(FacilitiesLive, FeedsLive, OutboundLive).pipe(
		Layer.provideMerge(pipelines)
	);
	const conversations = ConversationsLive.pipe(Layer.provideMerge(facilities));
	const triage = TriageLive.pipe(Layer.provideMerge(conversations));
	const agents = AgentsLive.pipe(Layer.provideMerge(triage));
	const envoys = EnvoysLive.pipe(Layer.provideMerge(agents));
	return RunsLive.pipe(
		Layer.provideMerge(envoys),
		Layer.provideMerge(secrets),
		Layer.provide(config)
	);
}
