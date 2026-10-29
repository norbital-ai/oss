// `@norbital-ai/bolt/facilities` (plan 01): the host contract. A bundle records what it NEEDS; a host supplies six
// groups of facilities. Bolt ships only the interfaces (Promise + AbortSignal, as HOST_API), `off`, the needs check and
// `activate`; every adapter belongs to the host that writes it. Every key is required: `satisfies Facilities` turns a
// missing one into a type error, `off` is the only way to leave a member out, and `mail` has no `off`.
import type {
	AiPort,
	ConvertPort,
	EmbeddingsPort,
	GeocoderPort,
	FilesPort,
	HttpPort,
	KeysPort,
	LogPort,
	SpeechPort,
	TcpPort,
	TransportPort,
	WebReadPort
} from '../engine/contracts.ts';
import type { Provider } from '../engine/integrations/driver.ts';
import type { PhoneVerifier } from '../engine/identity/session.ts';
import type { AuditPort } from '../protocol/audit.ts';
import {
	HOST_API,
	type ActiveWorkspace,
	type HostPorts,
	type HostTenantDb,
	type LinkHost,
	type ShellPorts,
	type Signal
} from '../protocol/host-api.ts';
import type { Off } from './off.ts';

export { off, isOff, type Off } from './off.ts';
export { needsOf, unmet, NEEDS, type Need } from './needs.ts';

/** A member the host may leave out, explicitly. */
export type Optional<T> = T | Off;

// ── 1. storage ──
/** Tenant rows (run status and chat history included): the engine's SQL over the host's driver. */
export type Database = HostTenantDb;
/** Uploads and blobs. */
export type Files = FilesPort;

// ── 2. log storage ──
/** Runtime events; the host may drop entries under load. */
export type RuntimeLog = LogPort;
/** The durable audit stream, outside the tenant database, surviving a tenant restore. */
export type AuditLog = AuditPort;

// ── 3. transactional ──
/** Emailed codes and invitations: `send('email', message, signal)`. Mandatory for every host. */
export type Mail = TransportPort;
/** Texted invitations: `send('sms', message, signal)`. */
export type Sms = TransportPort;
/** Sends and checks a mobile number's sign-in code. */
export type Phone = PhoneVerifier;
/** Web and native push for inbox notices, over the environment's database (a gone subscription is deleted there). */
export type Push = (database: Database) => TransportPort;
/** A local host's sign-in codes are all `123456` (38a(f)); a deployed host's are random. */
export type FixedCodes = boolean;
/** Turnstile-style bot protection: the public site key the widget renders, and the server-side check. */
export interface Challenge {
	readonly siteKey: string;
	verify(token: string, ip: string, signal: AbortSignal): Promise<boolean>;
}

// ── 4. intelligence ──
/** Fast structured decisions (`ctx.ai.sys_1.decide`, triage). */
export type System1 = AiPort['sys_1'];
/** The LLM (`ctx.ai.sys_2.infer`, agents). */
export type System2 = AiPort['sys_2'];
/** Multimodal embeddings (`ctx.ai.embed`). */
export type Embed = EmbeddingsPort;
/** Diarized transcription and text to speech (`ctx.ai.transcribe`, `ctx.ai.speak`). */
export type Speech = Required<SpeechPort>;

// ── 5. ports: how Bolt reaches the outside ──
/** Inbound: the public URL under which the host routes `/hooks/<instance>` and OAuth callbacks into Bolt. */
export interface Webhooks {
	readonly publicUrl: string;
}
/** A client WebSocket (Discord, WhatsApp, CDP): the platform's standard `WebSocket`. */
export interface Websockets {
	connect(
		url: string,
		options: {
			readonly protocols?: readonly string[];
			readonly headers?: Readonly<Record<string, string>>;
		},
		signal: AbortSignal
	): Promise<WebSocket>;
}
/** Outbound under the host's egress policy: HTTP for APIs and OAuth, TCP/TLS for IMAP and SMTP. */
export interface Outbound {
	readonly http: HttpPort;
	readonly tcp: TcpPort;
}

// ── 6. sandbox ──
export type SandboxLimits = {
	readonly cpuMs: number;
	readonly memoryMiB: number;
	readonly wallMs: number;
};
export type SandboxResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** The working tree after the command, by path. */
	readonly files: ReadonlyMap<string, Uint8Array>;
};
/** Agents' bash: one command over a working tree, confined by the host. */
export interface Sandbox {
	exec(
		command: string,
		files: ReadonlyMap<string, Uint8Array>,
		limits: SandboxLimits,
		signal: AbortSignal
	): Promise<SandboxResult>;
}

/**
 * Everything a host supplies. `keys` seals the tenant's secrets under a key only the host holds. The guest runner is no
 * facility: each host owns its own (`HostPorts.guests`).
 */
export type Facilities = {
	readonly storage: { readonly database: Database; readonly files: Files };
	readonly logs: { readonly runtime: RuntimeLog; readonly audit: AuditLog };
	readonly transactional: {
		readonly mail: Mail;
		readonly sms: Optional<Sms>;
		readonly phone: Optional<Phone>;
		readonly push: Optional<Push>;
		readonly challenge: Optional<Challenge>;
		readonly fixedCodes: FixedCodes;
	};
	readonly intelligence: {
		readonly system1: Optional<System1>;
		readonly system2: Optional<System2>;
		readonly embed: Optional<Embed>;
		readonly speech: Optional<Speech>;
	};
	readonly ports: {
		readonly webhooks: Optional<Webhooks>;
		readonly websockets: Optional<Websockets>;
		readonly outbound: Optional<Outbound>;
	};
	readonly sandbox: Optional<Sandbox>;
	readonly keys: KeysPort;
};

/**
 * What a host file (`norbital.host.ts`) may export as `serving` beside its default `Facilities`: the parts an
 * untethered host serves around them. Each one absent is off; `close` ends what the file opened when its host stops.
 */
export type Serving = {
	/** The integration drivers the workspace's links open (`toDrivers` from `@norbital-ai/providers/abi`). */
	readonly providers?: readonly Provider[];
	readonly oauth?: LinkHost['oauth'];
	readonly convert?: ConvertPort;
	readonly geocoder?: GeocoderPort;
	readonly web?: WebReadPort;
	readonly shell?: Pick<ShellPorts, 'environment' | 'push'>;
	close?(): Promise<void>;
};

/** What the host serves around the facilities: the release, its scope and URL, isolates, the shell and agent parts. */
export type Bundle = Omit<HostPorts, 'facilities'>;

/**
 * Activates `bundle` with `facilities`: the bundle's recorded needs are checked first, and a need left `off` refuses
 * the activation naming every unmet member. There is no fallback.
 */
export const activate = (
	bundle: Bundle,
	facilities: Facilities,
	options: Signal
): Promise<ActiveWorkspace> => HOST_API.activate({ ...bundle, facilities }, options);
