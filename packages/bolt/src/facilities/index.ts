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
/** The CPU, memory and wall-clock bounds one sandboxed command runs under. */
export type SandboxLimits = {
	readonly cpu_ms: number;
	readonly memory_mib: number;
	readonly wall_ms: number;
};
/** What a sandboxed command left: its exit code, output streams and resulting working tree. */
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
 * Everything a host supplies to run a bundle.
 *
 * Without a host file, Colony supplies them all (tethered, the default). A workspace's `norbital.host.ts`, or the file
 * `bolt dev --host=<file>` names, serves it untethered (`bolt dev`, bolt-server): its default export is this record
 * (`satisfies Facilities`), and an optional `serving` export adds the parts served around it ({@link Serving}). The
 * host file never enters the release's source. Every key is required: {@link off} is the only way to leave an optional
 * member out, and `mail` has none. Activation refuses a bundle whose recorded needs name a member left `off`, naming
 * each one. The guest runner is no facility: each host owns its own (`HostPorts.guests`; bolt-server and `bolt dev`
 * run bolt-cli's `node_guests`, Colony an isolated-vm runner).
 */
export type Facilities = {
	readonly storage: {
		/** Tenant rows (run status and chat history included): the engine's SQL over the host's driver. */
		readonly database: Database;
		/** Uploads and blobs. */
		readonly files: Files;
	};
	readonly logs: {
		/** Runtime events; the host may drop entries under load. */
		readonly runtime: RuntimeLog;
		/** The durable audit stream, outside the tenant database, surviving a tenant restore. */
		readonly audit: AuditLog;
	};
	readonly transactional: {
		/** Emailed codes and invitations. Mandatory for every host. */
		readonly mail: Mail;
		/** Texted invitations. */
		readonly sms: Optional<Sms>;
		/** Sends and checks a mobile number's sign-in code. */
		readonly phone: Optional<Phone>;
		/** Web and native push for inbox notices. */
		readonly push: Optional<Push>;
		/** Bot protection for public sign-up; with none, the host refuses strangers (except a local host). */
		readonly challenge: Optional<Challenge>;
		/** `true` on a local host: every sign-in code is `123456`; a deployed host's are random. */
		readonly fixed_codes: FixedCodes;
	};
	readonly intelligence: {
		/** Fast structured decisions (`ctx.ai.sys_1.decide`, triage). */
		readonly system1: Optional<System1>;
		/** The LLM (`ctx.ai.sys_2.infer`, agents). */
		readonly system2: Optional<System2>;
		/** Multimodal embeddings (`ctx.ai.embed`). */
		readonly embed: Optional<Embed>;
	};
	readonly ports: {
		/** The public URL under which the host routes `/hooks/integration/<instance>` and OAuth callbacks. */
		readonly webhooks: Optional<Webhooks>;
		/** Client WebSockets (Discord, WhatsApp, CDP). */
		readonly websockets: Optional<Websockets>;
		/** HTTP and TCP/TLS egress under the host's policy. */
		readonly outbound: Optional<Outbound>;
	};
	/** Agents' bash: one command over a working tree, confined by the host. */
	readonly sandbox: Optional<Sandbox>;
	/**
	 * The tenant's secrets key, held by the host: AES-256-GCM envelopes (`iv ‖ tag ‖ ciphertext`) bound to
	 * `bolt\0<owner>\0<name>`, so a copied envelope never opens under another owner or name.
	 */
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
