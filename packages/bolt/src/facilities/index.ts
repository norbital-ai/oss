// `@norbital-ai/bolt/facilities` (plan 01): the host contract. A bundle records what it NEEDS; a host supplies six
// groups of facilities. Bolt ships only the interfaces (Promise + AbortSignal, as HOST_API) and `off`; `HOST_API.activate`
// checks the needs. Every adapter belongs to the host that writes it. Every key is required: `satisfies Facilities` turns
// a missing one into a type error, `off` is the only way to leave a member out, and `mail` has no `off`.
import type {
	AiPort,
	BrowserPort,
	ConvertPort,
	EmbeddingsPort,
	GeocoderPort,
	FilesPort,
	HttpPort,
	KeysPort,
	LogPort,
	TcpPort,
	TransportPort,
	WebReadPort
} from '../engine/contracts.ts';
import type { Provider } from '../engine/integrations/driver.ts';
import type { PhoneVerifier } from '../engine/identity/session.ts';
import type { AuditPort } from '../protocol/audit.ts';
import type { AgentPorts, HostTenantDb, LinkHost, ShellPorts } from '../protocol/host-api.ts';
import type { Off } from './off.ts';

export { off, is_off } from './off.ts';

/** A member the host may leave out, explicitly. */
type Optional<T> = T | Off;

// ── 1. storage ──
/** Tenant rows (run status and chat history included): the engine's SQL over the host's driver. */
type Database = HostTenantDb;
/** Uploads and blobs. */
type Files = FilesPort;

// ── 2. log storage ──
/** Runtime events; the host may drop entries under load. */
type RuntimeLog = LogPort;
/** The durable audit stream, outside the tenant database, surviving a tenant restore. */
type AuditLog = AuditPort;

// ── 3. transactional ──
/** Emailed codes and invitations: `send('email', message, signal)`. Mandatory for every host. */
type Mail = TransportPort;
/** Texted invitations: `send('sms', message, signal)`. */
type Sms = TransportPort;
/** Sends and checks a mobile number's sign-in code. */
type Phone = PhoneVerifier;
/** Web and native push for inbox notices, over the environment's database (a gone subscription is deleted there). */
type Push = (database: Database) => TransportPort;
/** A local host's sign-in codes are all `123456` (38a(f)); a deployed host's are random. */
type FixedCodes = boolean;
/** Turnstile-style bot protection: the public site key the widget renders, and the server-side check. */
export interface Challenge {
	readonly site_key: string;
	verify(token: string, ip: string, signal: AbortSignal): Promise<boolean>;
}

// ── 4. intelligence ──
/** Fast structured decisions (`ctx.ai.sys_1.decide`, triage). */
type System1 = AiPort['sys_1'];
/** The LLM (`ctx.ai.sys_2.infer`, agents). */
type System2 = AiPort['sys_2'];
/** Multimodal embeddings (`ctx.ai.embed`). */
type Embed = EmbeddingsPort;

// ── 5. ports: how Bolt reaches the outside ──
/** Inbound: the public URL under which the host routes `/hooks/integration/<instance>` and OAuth callbacks into Bolt. */
interface Webhooks {
	readonly public_url: string;
}
/** A client WebSocket (Discord, WhatsApp, CDP): the platform's standard `WebSocket`. */
interface Websockets {
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
interface Outbound {
	readonly http: HttpPort;
	readonly tcp: TcpPort;
}

// ── 6. sandbox ──
export type SandboxLimits = {
	readonly cpu_ms: number;
	readonly memory_mib: number;
	readonly wall_ms: number;
};
export type SandboxResult = {
	readonly exit_code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** The working tree after the command, by path. */
	readonly files: ReadonlyMap<string, Uint8Array>;
};
/** Agents' bash: one command over a working tree, confined by the host. */
interface Sandbox {
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
		readonly fixed_codes: FixedCodes;
	};
	readonly intelligence: {
		readonly system1: Optional<System1>;
		readonly system2: Optional<System2>;
		readonly embed: Optional<Embed>;
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
	/** The integration drivers the workspace's links open (`to_drivers` from `@norbital-ai/providers/abi`). */
	readonly providers?: readonly Provider[];
	readonly oauth?: LinkHost['oauth'];
	readonly convert?: ConvertPort;
	/** Norbital Convert's `document_ingester`: a file as sanitised HTML and its images, for the agent and `ctx.convert.ingest`. */
	readonly ingest?: AgentPorts['ingest'];
	/** Capabilities the host supplies to agent turns and `ctx.ai.sys_2.infer` (`web_search`); a policy still has to name each. */
	readonly host_tools?: AgentPorts['host_tools'];
	readonly geocoder?: GeocoderPort;
	readonly web?: WebReadPort;
	readonly browser?: BrowserPort;
	readonly shell?: Pick<ShellPorts, 'environment' | 'push'>;
	close?(): Promise<void>;
};
