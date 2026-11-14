// The host's facilities (plan 01): a bundle records what it NEEDS; a host supplies five groups of facilities and the
// ports served around them. Every port is Promise + AbortSignal; a throw is a facility failure (`FacilityFailure`,
// `Unavailable`), never a release's own class. Every key of `Facilities` is required: `satisfies Facilities` turns a
// missing one into a type error, `off` is the only way to leave a member out, and `mail` has no `off`.
import type { Schema } from 'effect';
import type { AiPort, EmbeddingsPort } from './ai.ts';
import type { AuditPort } from './audit.ts';
import type { HostTenantDb } from './db.ts';
import type { BrowserPort } from './browser.ts';
import type { OAuthClient, OAuthVendor, Provider } from './integrations.ts';
import type { LogPort } from './logs.ts';
import type { Ingested } from './media.ts';
import type { Off } from './off.ts';
import type { AgentPorts, ShellPorts } from './host.ts';
import type { Json } from '@norbital-ai/store';

// ── budgets ──
const MiB = 1024 * 1024;
/** The walls a host enforces for a release: a unit's guest CPU and heap, the request bodies it reads and each I/O call's wall. */
export const HOST_LIMITS = {
	/** One unit's guest CPU: Colony's meter budget, so the kit and dev refuse what a deployed host refuses. */
	guestCpuMs: 3_000,
	guestMemoryMiB: 256,
	/** One call's arguments. */
	argsBytes: 4 * MiB,
	/** One stored file. */
	storedFileBytes: 20 * MiB,
	/** One crossing's answer. 8 MiB fits a large jurisdiction's payroll admission while staying far below a cell's heap. */
	crossingBytes: 8 * MiB,
	/**
	 * Per I/O response, never per invocation. Streaming model responses reset their idle deadline on progress;
	 * a multi-step inference keeps its separate whole-call ceiling.
	 */
	callMs: {
		database: 20_000,
		ai: 20_000,
		tool: 20_000,
		http: 20_000,
		web: 20_000,
		image: 20_000,
		other: 20_000,
		/** One Convert job (`ctx.convert.ingest`): a long recording's transcription takes minutes. */
		ingest: 600_000,
		attachment: 20_000,
		/** One record printed by the host's browser (`ctx.convert.record`): the page loads, its reads settle, it prints. */
		render: 60_000
	}
} as const;

// ── files ──
/** A stored blob; the `sys_file` row is the release's. */
export type Blob = { key: string; bytes: number; sha256: string; mime: string };
/** A media file the host fetched for a tool: classified by its bytes, stored, never run. */
export type Downloaded = Blob & { name: string };
/** The host's blob store behind `ctx.files` and the `sys_file` rows: put, bounded get, signed URL, remove and media download. */
export interface FilesPort {
	put(bytes: Uint8Array, meta: { name: string; mime: string }, signal: AbortSignal): Promise<Blob>;
	/** At most `max` bytes; more is `invalid`, never a truncation. */
	get(key: string, max: number, signal: AbortSignal): Promise<Uint8Array>;
	url(key: string, expiresInS: number, signal: AbortSignal): Promise<string>;
	remove(key: string, signal: AbortSignal): Promise<void>;
	/**
	 * Fetches a public http(s) URL under the host's egress policy (every redirect hop re-checked, at most 5) and stores
	 * its body if its first bytes are media (image, audio, video, PDF); anything else is refused, never stored. The host
	 * streams it (at most 100 MiB, 20 s without bytes ends it) and names it from the response or the URL.
	 */
	download(url: string, signal: AbortSignal): Promise<Downloaded>;
}

// ── convert ──
/** Every conversion target, in the order hosts report them. */
export const CONVERT_TARGETS = ['pdf', 'docx', 'pptx', 'odt', 'epub', 'html'] as const;
/** A document format the converter can produce. */
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];
/** Each conversion target's media type. */
export const CONVERT_MIME: Record<ConvertTarget, string> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	epub: 'application/epub+zip',
	html: 'text/html'
};
/** The paper sizes a rendered document may take. */
export const PAPER_SIZES = ['A4', 'A3', 'Letter'] as const;
/** One of `PAPER_SIZES`. */
export type PaperSize = (typeof PAPER_SIZES)[number];
/** A PDF's paper and orientation. */
export type PreviewPdfOptions = { page?: PaperSize; landscape?: boolean };
/**
 * The source of a conversion: Markdown (pandoc's dialect, with pipe tables and front matter) or an HTML document. HTML is
 * read for its structure (headings, tables, images, emphasis); its CSS does not carry into the output, and a PDF is typeset
 * by Typst.
 */
export type ConvertSource =
	{ readonly markdown: string } | { readonly html: string } | { readonly layout_html: string };
/**
 * How an ingest reads: `pictures: false` reads a PDF's text alone, `page` one PDF page as a picture, `password` opens a
 * locked PDF or Office file for this read; for audio, `diarize` tells speakers apart (default true), `language` a
 * BCP 47 hint, `speakers` how many there are when known, `prompt` context such as names and vocabulary.
 */
export type IngestOptions = {
	pictures?: boolean;
	page?: number;
	password?: string;
	diarize?: boolean;
	language?: string;
	speakers?: number;
	prompt?: string;
};
/**
 * The document converter behind `ctx.convert.document` (optional; absent → `unavailable`). `targets` is what this host
 * serves, checked at start against `workspace.convert.to`. `reference` is the bytes of a styling document (docx, pptx, odt).
 * `ingest` (plan 12) reads one file to `Ingested` for the agent's `read_file` and `ctx.convert.ingest`, or answers
 * `unsupported` (the format has no parser: CAD); absent, neither ingests. A video container is heard from its audio
 * track; a converter without a transcription model rejects audio as `unavailable`.
 */
export interface ConvertPort {
	readonly targets: readonly ConvertTarget[];
	convert(
		source: ConvertSource,
		to: ConvertTarget,
		options: PreviewPdfOptions & { reference?: Uint8Array },
		signal: AbortSignal
	): Promise<Uint8Array>;
	/** Renders in memory without retaining source or result in a job or file store. */
	preview_pdf?(
		source: ConvertSource,
		options: PreviewPdfOptions,
		signal: AbortSignal
	): Promise<Uint8Array>;
	ingest?(
		file: {
			sha256: string;
			name: string;
			mime: string;
			/** Bytes the caller holds, or else `key`: a stored file the host reads, so nothing large crosses into a cell. */
			bytes?: Uint8Array | ReadableStream<Uint8Array>;
			key?: string;
			/** Whose it is: a burst of one tenant's files waits behind that tenant's own. */
			lane?: string;
		},
		options: IngestOptions,
		signal: AbortSignal
	): Promise<Ingested | { readonly unsupported: string }>;
}
/**
 * The host's headless browser printing one workspace page to PDF (`ctx.convert.record`). `path` is under the
 * workspace's public URL (`/?record=<model>/<id>&print`); every request the page makes carries the header
 * `authorization: <authorization>` (a render grant, valid only while this call runs). The host loads the page with
 * print media, waits until `<html data-bolt-print="ready">` (or `"failed"`, a refusal: answer it as an error), and
 * answers `page.pdf()` with its CSS page size and backgrounds.
 */
export interface RenderPort {
	pdf(page: { path: string; authorization: string }, signal: AbortSignal): Promise<Uint8Array>;
}

// ── geo and web ──
/** A point on Earth: latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A geocoding result: the point, a short label and the full address. */
export type GeoHit = { readonly point: Point; readonly label: string; readonly address: string };
/** Finds places by text and names the place at a point. */
export interface GeocoderPort {
	search(query: string, signal: AbortSignal): Promise<readonly GeoHit[]>;
	reverse(point: Point, signal: AbortSignal): Promise<GeoHit | null>;
}
/**
 * A read page: its final URL, title and readable text (a PDF's text), and, when the provider reports them, its content type,
 * SHA-256 of the body and a document's page count; with `{ raw: true }` also the markup and its absolute links (a crawl).
 */
export type WebPage = {
	readonly url: string;
	readonly title: string | null;
	readonly text: string;
	readonly content_type?: string;
	readonly sha256?: string;
	readonly pages?: number;
	readonly html?: string;
	readonly links?: readonly string[];
};
/** Reads a public web page as text. */
export interface WebReadPort {
	/** Refuses private, loopback and link-local addresses. `raw`: also the markup and its links, for a page that is markup. */
	read(url: string, signal: AbortSignal, options?: { raw?: boolean }): Promise<WebPage>;
}

// ── transactional ──
/** The host's transactional mail and SMS (identity codes, invitations) and web push: a send to an address. */
export interface TransportPort {
	/** `kind` names what it sends (`email`, `sms`, `inbox` for push); the address is the message's. Any throw is a failed send. */
	send(kind: string, message: Json, signal: AbortSignal): Promise<{ provider_id: string }>;
}
/**
 * Sends and checks its own six-digit codes to a mobile number, by each of `via`. `check` is `false` for a wrong,
 * expired or used code; a throw is a failure to ask.
 */
export type PhoneVerifier = {
	via: readonly ('sms' | 'whatsapp')[];
	start(to: string, via: 'sms' | 'whatsapp', signal: AbortSignal): Promise<void>;
	check(to: string, code: string, signal: AbortSignal): Promise<boolean>;
};
/** How long a sign-in code stays valid. */
export const SIGN_IN_CODE_MS = 10 * 60_000;
/** A uniformly random six-digit sign-in code. */
export function six_digits(): string {
	for (;;) {
		for (const n of crypto.getRandomValues(new Uint32Array(1)))
			if (n < 4294000000) return String(n % 1000000).padStart(6, '0');
	}
}
/**
 * A local host's phone verifier: its own code, printed by `log` as `(sign-in code 123456)` (bolt dev, a local host,
 * tests). `fixed` is 38a(f)'s `123456`.
 */
export function logged_phone(log: (line: string) => void, fixed = false): PhoneVerifier {
	const codes = new Map<string, { code: string; until: number }>();
	return {
		via: ['sms', 'whatsapp'],
		async start(to, via) {
			const code = fixed ? '123456' : six_digits();
			codes.set(to, { code, until: Date.now() + SIGN_IN_CODE_MS });
			log(`${via} → ${to}: Your sign-in code is ${code}. (sign-in code ${code})`);
		},
		async check(to, code) {
			const held = codes.get(to);
			if (held === undefined || held.until <= Date.now() || held.code !== code) return false;
			codes.delete(to);
			return true;
		}
	};
}
/** Turnstile-style bot protection: the public site key the widget renders, and the server-side check. */
export interface Challenge {
	readonly site_key: string;
	verify(token: string, ip: string, signal: AbortSignal): Promise<boolean>;
}

// ── kernel ports: the engine's Node dependencies, served by the host ──
/** One next-due instant per scope, held in host memory; no polling. */
export interface DeadlinesPort {
	announce(scope: string, notLaterThan: string): Promise<void>;
	settle(scope: string, nextDue: string | null): Promise<void>;
	teardown(scope: string): Promise<void>;
}
/**
 * The tenant's secrets key, held by the host: AES-256-GCM envelopes (`iv ‖ tag ‖ ciphertext`) bound to `aad`
 * (`bolt\0<owner>\0<name>`), so a copied envelope never opens under another owner or name. `open` answers `null` for
 * an envelope that does not open under this key and `aad`.
 */
export interface KeysPort {
	seal(plain: Uint8Array, aad: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
	open(sealed: Uint8Array, aad: Uint8Array, signal: AbortSignal): Promise<Uint8Array | null>;
}
/** An outbound request: absolute URL, headers in order, body bytes (none for GET). */
export type HttpRequest = {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [name: string, value: string])[];
	readonly body?: Uint8Array;
};
/** `redirects`: hops followed (each re-checked); `max_bytes`: the decoded body's ceiling (more fails `too_large`). */
export type HttpFetchOptions = { readonly redirects: number; readonly max_bytes: number };
/** The final response: status, lowercase headers, the whole decoded body (empty for 204, 205, 304 and a redirect). */
export type HttpResponse = {
	readonly status: number;
	readonly headers: readonly (readonly [name: string, value: string])[];
	readonly body: Uint8Array;
};
/**
 * Outbound HTTP under the public-network policy: HTTPS on 443 without credentials, DNS resolved once and
 * the checked address pinned, private and reserved networks refused, every redirect hop re-checked (a cross-origin hop
 * keeps only `accept`; a 301-303 of a write becomes a GET), transport headers (`host`, `connection`, `content-length`,
 * `transfer-encoding`, `upgrade`, `te`, `trailer`, `accept-encoding`, `proxy-*`) refused, gzip decoded. A refusal
 * rejects as a facility failure `invalid`; the wall is the caller's (`Port.call`).
 */
export interface HttpPort {
	fetch(
		request: HttpRequest,
		options: HttpFetchOptions,
		signal: AbortSignal
	): Promise<HttpResponse>;
}
/** Where a TCP connection goes; `tls` opens it as TLS, verified against `servername` (default `host`). */
export type TcpEndpoint = {
	readonly host: string;
	readonly port: number;
	readonly tls: boolean;
	readonly servername?: string;
};
/** One outbound TCP connection as two byte streams. */
export type TcpSocket = {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	close(): Promise<void>;
	/**
	 * STARTTLS: TLS over this cleartext connection, verified as the endpoint says. Release both streams' locks first;
	 * this socket's streams then end and the returned one carries the connection.
	 */
	start_tls(signal: AbortSignal): Promise<TcpSocket>;
};
/**
 * Outbound TCP/TLS (IMAP, SMTP) under the host's egress policy: the host resolves and checks the destination (a public
 * host refuses private and reserved networks) and connects. `signal` bounds the connect; `close` ends the connection.
 */
export interface TcpPort {
	connect(endpoint: TcpEndpoint, signal: AbortSignal): Promise<TcpSocket>;
}
/** A file run's tree (a skill's folder): its digest, the entry's path in it, and every file by its path in the tree. */
export type BundleRequest = {
	/** sha256 hex of the sorted `<path>\0<sha256 hex of its bytes>` lines, `\n`-joined. */
	readonly digest: string;
	readonly entry: string;
	readonly files: readonly (readonly [path: string, bytes: Uint8Array])[];
};
/**
 * One ES module that imports nothing, with its source map (sources are tree paths), or the errors that stopped it, each
 * `file:line:column: message` and the line. The module's default export is `{ run(input) }`, which calls
 * `globalThis[Symbol.for('norbital.node')].run(input, load)` with `load` evaluating the entry; each Node built-in a run
 * provides (`fs`, `fs/promises`, `path`, `buffer`, `process`, `util`) is `…builtin(name)`, and a `require` that does not
 * resolve throws when called, naming the requirer.
 */
export type Bundled =
	{ readonly code: string; readonly map: string } | { readonly errors: readonly string[] };
/**
 * The confined bundler ("Running a file"): the host resolves the entry's imports inside the tree by
 * Node's rules and bundles them in a confined process that serves one tenant, caching by (digest, entry, bundler version).
 */
export interface BundlerPort {
	bundle(request: BundleRequest, signal: AbortSignal): Promise<Bundled>;
}
/** An MCP server as the release resolved it from the workspace's secrets: URL, headers, and its authorization. */
export type McpServer = {
	readonly url: string;
	readonly headers: { readonly [name: string]: string };
	readonly auth?:
		| { readonly bearer: string }
		| {
				readonly client: {
					readonly id: string;
					readonly secret: string;
					readonly scopes?: readonly string[];
				};
		  };
};
/** One tool an MCP server lists: its name, description and input JSON Schema. */
export type McpToolInfo = {
	readonly name: string;
	readonly description: string;
	readonly input_schema: Json;
};
/**
 * MCP over streamable HTTP on the current protocol revision: `connect` answers an opaque session id, `call`
 * answers `{ content, structured?, isError? }`; `close` ends the session (idempotent).
 */
export interface McpPort {
	connect(server: McpServer, signal: AbortSignal): Promise<string>;
	tools(session: string, signal: AbortSignal): Promise<readonly McpToolInfo[]>;
	call(session: string, tool: string, input: Json, signal: AbortSignal): Promise<Json>;
	close(session: string): Promise<void>;
}

// ── the facility record ──
/** A member the host may leave out, explicitly. */
type Optional<T> = T | Off;
/**
 * Everything a host supplies to run a bundle.
 *
 * Without a host file, Colony supplies them all (tethered, the default). A workspace's `norbital.host.ts`, or the file
 * `bolt dev --host=<file>` names, serves it untethered (`bolt dev`, bolt-server): its default export is this record
 * (`satisfies Facilities`), and an optional `serving` export adds the parts served around it ({@link Serving}). The
 * host file never enters the release's source. Every key is required: `off` is the only way to leave an optional
 * member out, and `mail` has none. Activation refuses a bundle whose recorded needs name a member left `off`, naming
 * each one. The guest runner is no facility: each host owns its own (`HostPorts.guests`).
 */
export type Facilities = {
	readonly storage: {
		/** Tenant rows (run status and chat history included): the engine's SQL over the host's driver. */
		readonly database: HostTenantDb;
		/** Uploads and blobs. */
		readonly files: FilesPort;
	};
	readonly logs: {
		/** Runtime events; the host may drop entries under load. */
		readonly runtime: LogPort;
		/** The durable audit stream, outside the tenant database, surviving a tenant restore. */
		readonly audit: AuditPort;
	};
	readonly transactional: {
		/** Emailed codes and invitations: `send('email', message, signal)`. Mandatory for every host. */
		readonly mail: TransportPort;
		/** Texted invitations: `send('sms', message, signal)`. */
		readonly sms: Optional<TransportPort>;
		/** Sends and checks a mobile number's sign-in code. */
		readonly phone: Optional<PhoneVerifier>;
		/** Web and native push for inbox notices, over the environment's database (a gone subscription is deleted there). */
		readonly push: Optional<(database: HostTenantDb) => TransportPort>;
		/** Bot protection for public sign-up; with none, the host refuses strangers (except a local host). */
		readonly challenge: Optional<Challenge>;
		/** `true` on a local host: every sign-in code is `123456` (38a(f)); a deployed host's are random. */
		readonly fixed_codes: boolean;
	};
	readonly intelligence: {
		/** Fast structured decisions (`ctx.ai.sys_1.decide`, triage). */
		readonly system1: Optional<AiPort['sys_1']>;
		/** The LLM (`ctx.ai.sys_2.infer`, agents). */
		readonly system2: Optional<AiPort['sys_2']>;
		/** Multimodal embeddings (`ctx.ai.embed`). */
		readonly embed: Optional<EmbeddingsPort>;
	};
	readonly ports: {
		/** The public URL under which the host routes `/hooks/integration/<instance>` and OAuth callbacks into the release. */
		readonly webhooks: Optional<{ readonly public_url: string }>;
		/** HTTP for APIs and OAuth, TCP/TLS for IMAP and SMTP, under the host's egress policy. */
		readonly outbound: Optional<{ readonly http: HttpPort; readonly tcp: TcpPort }>;
	};
	/** The tenant's secrets key, held by the host (`KeysPort`). */
	readonly keys: KeysPort;
};
/**
 * What a host file (`norbital.host.ts`) may export as `serving` beside its default `Facilities`: the parts an
 * untethered host serves around them. Each one absent is off; `close` ends what the file opened when its host stops.
 */
export type Serving = {
	/** The integration drivers the workspace's links open (`to_drivers` from `@norbital-ai/providers/abi`). */
	readonly providers?: readonly Provider[];
	readonly oauth?: Partial<Record<OAuthVendor, OAuthClient>>;
	/** Norbital Convert: documents for `ctx.convert.document`, and `ingest` for the agent and `ctx.convert.ingest`. */
	readonly convert?: ConvertPort;
	/** A headless browser printing a record's print route to PDF (`ctx.convert.record`). */
	readonly render?: RenderPort;
	/** Capabilities the host supplies to agent turns and `ctx.ai.sys_2.infer` (`web_search`); a policy still has to name each. */
	readonly host_tools?: AgentPorts['host_tools'];
	readonly geocoder?: GeocoderPort;
	readonly web?: WebReadPort;
	readonly browser?: BrowserPort;
	readonly shell?: Pick<ShellPorts, 'environment' | 'push'>;
	close?(): Promise<void>;
};
