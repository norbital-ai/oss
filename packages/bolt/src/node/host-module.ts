// Host modules are executable input: validate their records now and each callback's answer when it returns.
import { Schema } from 'effect';
import type { Facilities, Serving } from '../facilities/index.ts';
import { off } from '../facilities/off.ts';
import type { TcpSocket } from '../engine/contracts.ts';
import type { HostTenantDb } from '../protocol/host-api.ts';
import type { Link, Provider } from '../engine/integrations/driver.ts';
import type { HostTool } from '../engine/agent/tools.ts';
import { DecisionResultSchema } from '../engine/decision.ts';
import { IngestedSchema } from '../engine/media.ts';
import { AiPortResponseSchema } from '../engine/ai-schema.ts';
import { BrowserSnapshotSchema } from '../decl/runtime/browser.ts';
import { AuditPage, AuditPendingPage, AuditRecord } from '../protocol/audit.ts';
import { Driver, LocalText, ProviderChoice, SetupDescription, STUDIO_ROLES, TestSend, ToolBehavior } from '../protocol/schema.ts';
import { SendReceipt } from '../engine/conversations/status.ts';

type Callback = (...args: readonly unknown[]) => unknown;
const Callback = Schema.declare((value: unknown): value is Callback => typeof value === 'function');
const Off = Schema.TaggedStruct('Off', {});
const is_off = Schema.is(Off);
const decode = Schema.decodeUnknownSync;
const optional = <A>(value: unknown, read: (value: unknown) => A) => is_off(value) ? off : read(value);
const call = <A>(owner: unknown, fn: Callback, answer: Schema.Decoder<A>) =>
	async (...args: readonly unknown[]): Promise<A> => decode(answer)(await fn.call(owner, ...args));
const sync = <A>(owner: unknown, fn: Callback, answer: Schema.Decoder<A>) =>
	(...args: readonly unknown[]): A => decode(answer)(fn.call(owner, ...args));
const complete = (owner: unknown, fn: Callback) =>
	async (...args: readonly unknown[]): Promise<void> => { await fn.call(owner, ...args); };
const notify = (owner: unknown, fn: Callback) =>
	(...args: readonly unknown[]): void => { fn.call(owner, ...args); };
const Receipt = Schema.Struct({ provider_id: Schema.String });
const Blob = Schema.Struct({ key: Schema.String, bytes: Schema.Number, sha256: Schema.String, mime: Schema.String });
const Downloaded = Schema.Struct({ ...Blob.fields, name: Schema.String });
const Rows = Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)), affected: Schema.Number });
const LogRow = Schema.Struct({
	id: Schema.String, at: Schema.String, severity: Schema.Literals(['info', 'warn', 'error']),
	event: Schema.String, invocation: Schema.String, run: Schema.NullOr(Schema.String),
	conversation: Schema.NullOr(Schema.String), turn: Schema.NullOr(Schema.String), attributes: Schema.Json
});
const AiCatalog = Schema.Struct({
	models: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, provider: Schema.optionalKey(Schema.String), context: Schema.optionalKey(Schema.Number) })),
	default: Schema.String
});
const DriverPage = Schema.Struct({
	items: Schema.Array(Schema.Json), cursor: Schema.Json, more: Schema.Boolean,
	snapshot: Schema.optionalKey(Schema.Literals(['begin', 'end'])), retained: Schema.optionalKey(Schema.Literal(false)),
	health: Schema.optionalKey(Schema.Struct({ state: Schema.Literals(['ready', 'attention']), code: Schema.optionalKey(Schema.String), message: Schema.optionalKey(Schema.String) }))
});
const ReconcilePage = Schema.Struct({ messages: Schema.Array(Schema.Json), complete: Schema.Boolean, since: Schema.optionalKey(Schema.String), bins: Schema.optionalKey(Schema.Array(Schema.Uint8Array)) });

const database = (input: unknown): Facilities['storage']['database'] => {
	const port = decode(Schema.Struct({ read: Callback, write: Callback, transaction: Callback }))(input);
	return { read: call(input, port.read, Schema.Array(Rows)), write: call(input, port.write, Rows), transaction: call(input, port.transaction, Schema.Array(Rows)) };
};
const files = (input: unknown): Facilities['storage']['files'] => {
	const port = decode(Schema.Struct({ put: Callback, get: Callback, url: Callback, remove: Callback, download: Callback }))(input);
	return { put: call(input, port.put, Blob), get: call(input, port.get, Schema.Uint8Array), url: call(input, port.url, Schema.String), remove: complete(input, port.remove), download: call(input, port.download, Downloaded) };
};
const transport = (input: unknown): Facilities['transactional']['mail'] => {
	const port = decode(Schema.Struct({ send: Callback }))(input);
	return { send: call(input, port.send, Receipt) };
};
const readable = Schema.declare((value: unknown): value is ReadableStream<unknown> => value instanceof ReadableStream);
const writable = Schema.declare((value: unknown): value is WritableStream<unknown> => value instanceof WritableStream);
const socket = (input: unknown): TcpSocket => {
	const port = decode(Schema.Struct({ readable, writable, close: Callback, start_tls: Callback }))(input);
	return {
		readable: port.readable.pipeThrough(new TransformStream<unknown, Uint8Array>({ transform: (chunk, controller) => controller.enqueue(decode(Schema.Uint8Array)(chunk)) })),
		writable: port.writable,
		close: complete(input, port.close),
		start_tls: async (...args) => socket(await port.start_tls.call(input, ...args))
	};
};

const facilities = (input: unknown): Facilities => {
	const groups = decode(Schema.Struct({
		storage: Schema.Struct({ database: Schema.Unknown, files: Schema.Unknown }),
		logs: Schema.Struct({ runtime: Schema.Unknown, audit: Schema.Unknown }),
		transactional: Schema.Struct({ mail: Schema.Unknown, sms: Schema.Unknown, phone: Schema.Unknown, push: Schema.Unknown, challenge: Schema.Unknown, fixed_codes: Schema.Boolean }),
		intelligence: Schema.Struct({ system1: Schema.Unknown, system2: Schema.Unknown, embed: Schema.Unknown }),
		ports: Schema.Struct({ webhooks: Schema.Unknown, websockets: Schema.Unknown, outbound: Schema.Unknown }),
		sandbox: Schema.Unknown, keys: Schema.Unknown
	}))(input);
	const runtime = groups.logs.runtime;
	const log = decode(Schema.Struct({ write: Callback, query: Callback }))(runtime);
	const audit = groups.logs.audit;
	const store = decode(Schema.Struct({ mode: Schema.Literals(['durable', 'buffered', 'disabled']), append: Callback, query: Callback, detail: Callback, pending: Callback }))(audit);
	const keys = decode(Schema.Struct({ seal: Callback, open: Callback }))(groups.keys);
	return {
		storage: { database: database(groups.storage.database), files: files(groups.storage.files) },
		logs: {
			runtime: { write: notify(runtime, log.write), query: call(runtime, log.query, Schema.Array(LogRow)) },
			audit: { mode: store.mode, append: complete(audit, store.append), query: call(audit, store.query, AuditPage), detail: call(audit, store.detail, Schema.NullOr(AuditRecord)), pending: call(audit, store.pending, AuditPendingPage) }
		},
		transactional: {
			mail: transport(groups.transactional.mail), sms: optional(groups.transactional.sms, transport), fixed_codes: groups.transactional.fixed_codes,
			phone: optional(groups.transactional.phone, (value) => {
				const port = decode(Schema.Struct({ via: Schema.Array(Schema.Literals(['sms', 'whatsapp'])), start: Callback, check: Callback }))(value);
				return { via: port.via, start: complete(value, port.start), check: call(value, port.check, Schema.Boolean) };
			}),
			push: optional(groups.transactional.push, (value) => {
				const factory = decode(Callback)(value);
				return (db: HostTenantDb) => transport(factory(db));
			}),
			challenge: optional(groups.transactional.challenge, (value) => {
				const port = decode(Schema.Struct({ site_key: Schema.String, verify: Callback }))(value);
				return { site_key: port.site_key, verify: call(value, port.verify, Schema.Boolean) };
			})
		},
		intelligence: {
			system1: optional(groups.intelligence.system1, (value) => {
				const port = decode(Schema.Struct({ ask: Callback, max_choices: Schema.optionalKey(Schema.Number) }))(value);
				return { ask: call(value, port.ask, DecisionResultSchema), ...(port.max_choices === undefined ? {} : { max_choices: port.max_choices }) };
			}),
			system2: optional(groups.intelligence.system2, (value) => {
				const port = decode(Schema.Struct({ models: Schema.Array(Schema.String), infer: Callback, catalog: Schema.optionalKey(Callback) }))(value);
				return { models: port.models, infer: call(value, port.infer, AiPortResponseSchema), ...(port.catalog === undefined ? {} : { catalog: call(value, port.catalog, AiCatalog) }) };
			}),
			embed: optional(groups.intelligence.embed, (value) => {
				const port = decode(Schema.Struct({ embed: Callback }))(value);
				return { embed: call(value, port.embed, Schema.Array(Schema.Array(Schema.Number))) };
			})
		},
		ports: {
			webhooks: optional(groups.ports.webhooks, decode(Schema.Struct({ public_url: Schema.String }))),
			websockets: optional(groups.ports.websockets, (value) => {
				const port = decode(Schema.Struct({ connect: Callback }))(value);
				return { connect: call(value, port.connect, Schema.declare((value: unknown): value is WebSocket => value instanceof WebSocket)) };
			}),
			outbound: optional(groups.ports.outbound, (value) => {
				const network = decode(Schema.Struct({ http: Schema.Struct({ fetch: Callback }), tcp: Schema.Struct({ connect: Callback }) }))(value);
				const owners = decode(Schema.Struct({ http: Schema.Unknown, tcp: Schema.Unknown }))(value);
				return {
					http: { fetch: call(owners.http, network.http.fetch, Schema.Struct({ status: Schema.Number, headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])), body: Schema.Uint8Array })) },
					tcp: { connect: async (...args) => socket(await network.tcp.connect.call(owners.tcp, ...args)) }
				};
			})
		},
		sandbox: optional(groups.sandbox, (value) => {
			const port = decode(Schema.Struct({ exec: Callback }))(value);
			return { exec: call(value, port.exec, Schema.Struct({ exit_code: Schema.Number, stdout: Schema.String, stderr: Schema.String, files: Schema.ReadonlyMap(Schema.String, Schema.Uint8Array) })) };
		}),
		keys: { seal: call(groups.keys, keys.seal, Schema.Uint8Array), open: call(groups.keys, keys.open, Schema.NullOr(Schema.Uint8Array)) }
	};
};

const link = (input: unknown): Link => {
	const port = decode(Schema.Struct({ close: Callback, pair: Schema.optionalKey(Callback), unpair: Schema.optionalKey(Callback), test: Schema.optionalKey(Callback), send: Schema.optionalKey(Callback), typing: Schema.optionalKey(Callback), request: Schema.optionalKey(Callback), read: Schema.optionalKey(Callback), reconcile: Schema.optionalKey(Callback), discover: Schema.optionalKey(Callback), renew: Schema.optionalKey(Callback), webhook: Schema.optionalKey(Callback) }))(input);
	return {
		close: complete(input, port.close),
		...(port.pair === undefined ? {} : { pair: complete(input, port.pair) }),
		...(port.unpair === undefined ? {} : { unpair: complete(input, port.unpair) }),
		...(port.test === undefined ? {} : { test: complete(input, port.test) }),
		...(port.send === undefined ? {} : { send: call(input, port.send, SendReceipt) }),
		...(port.typing === undefined ? {} : { typing: complete(input, port.typing) }),
		...(port.request === undefined ? {} : { request: call(input, port.request, Schema.Json) }),
		...(port.read === undefined ? {} : { read: call(input, port.read, DriverPage) }),
		...(port.reconcile === undefined ? {} : { reconcile: call(input, port.reconcile, ReconcilePage) }),
		...(port.discover === undefined ? {} : { discover: call(input, port.discover, Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))) }),
		...(port.renew === undefined ? {} : { renew: call(input, port.renew, Schema.NullOr(Schema.String)) }),
		...(port.webhook === undefined ? {} : { webhook: call(input, port.webhook, Schema.declare((value: unknown): value is Response => value instanceof Response)) })
	};
};
const provider = (input: unknown): Provider => {
	const port = decode(Schema.Struct({
		...ProviderChoice.fields, driver: Driver, open: Callback, validate_import_start: Schema.optionalKey(Callback),
		personal: Schema.optionalKey(Schema.Boolean), oauth: Schema.optionalKey(Schema.Literal('google')),
		test: Schema.optionalKey(TestSend), idempotent_sends: Schema.optionalKey(Schema.Boolean), describe: Schema.optionalKey(Callback)
	}))(input);
	const { open, describe, validate_import_start, ...choice } = port;
	return {
		...choice,
		open: async (...args) => link(await open.call(input, ...args)),
		...(describe === undefined ? {} : { describe: sync(input, describe, Schema.Struct({ label: LocalText, setup: SetupDescription })) }),
		...(validate_import_start === undefined ? {} : { validate_import_start: call(input, validate_import_start, Schema.Record(Schema.String, Schema.String)) })
	};
};
const hostTool = (input: unknown): HostTool => {
	const port = decode(Schema.Struct({
		name: Schema.String, description: Schema.String, input: Schema.Json, behavior: ToolBehavior,
		read_only: Schema.optionalKey(Schema.Boolean), source: Schema.optionalKey(Schema.Literal(true)),
		studio: Schema.optionalKey(Schema.Literals(STUDIO_ROLES)), wall_ms: Schema.optionalKey(Schema.Number),
		files: Schema.optionalKey(Schema.Literal(true)), call: Callback
	}))(input);
	return { ...port, call: call(input, port.call, Schema.Json) };
};
const hostTools = (input: unknown): NonNullable<Serving['host_tools']> => {
	if (typeof input === 'function') {
		const fn = decode(Callback)(input);
		return async (...args) => decode(Schema.Array(Schema.Unknown))(await fn(...args)).map(hostTool);
	}
	return decode(Schema.Array(Schema.Unknown))(input).map(hostTool);
};
const serving = (input: unknown): Serving => {
	const port = decode(Schema.Struct({
		providers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
		oauth: Schema.optionalKey(Schema.Struct({ google: Schema.optionalKey(Schema.Struct({ id: Schema.String, secret: Schema.String })) })),
		convert: Schema.optionalKey(Schema.Unknown), ingest: Schema.optionalKey(Callback), host_tools: Schema.optionalKey(Schema.Unknown),
		geocoder: Schema.optionalKey(Schema.Unknown), web: Schema.optionalKey(Schema.Unknown), browser: Schema.optionalKey(Schema.Unknown),
		shell: Schema.optionalKey(Schema.Struct({ environment: Schema.optionalKey(Schema.String), push: Schema.optionalKey(Schema.Struct({ public_key: Schema.String })) })),
		close: Schema.optionalKey(Callback)
	}))(input);
	return {
		...(port.providers === undefined ? {} : { providers: port.providers.map(provider) }),
		...(port.oauth === undefined ? {} : { oauth: port.oauth }),
		...(port.shell === undefined ? {} : { shell: port.shell }),
		...(port.ingest === undefined ? {} : { ingest: call(input, port.ingest, Schema.Union([IngestedSchema, Schema.Struct({ unsupported: Schema.String })])) }),
		...(port.host_tools === undefined ? {} : { host_tools: hostTools(port.host_tools) }),
		...(port.close === undefined ? {} : { close: complete(input, port.close) }),
		...(port.convert === undefined ? {} : { convert: converter(port.convert) }),
		...(port.geocoder === undefined ? {} : { geocoder: geocoder(port.geocoder) }),
		...(port.web === undefined ? {} : { web: web(port.web) }),
		...(port.browser === undefined ? {} : { browser: browser(port.browser) })
	};
};
const converter = (input: unknown): NonNullable<Serving['convert']> => {
	const port = decode(Schema.Struct({ targets: Schema.Array(Schema.Literals(['pdf', 'docx', 'pptx', 'odt', 'epub', 'html'])), convert: Callback, preview_pdf: Schema.optionalKey(Callback) }))(input);
	return { targets: port.targets, convert: call(input, port.convert, Schema.Uint8Array), ...(port.preview_pdf === undefined ? {} : { preview_pdf: call(input, port.preview_pdf, Schema.Uint8Array) }) };
};
const GeoHit = Schema.Struct({ point: Schema.Struct({ lat: Schema.Number, lng: Schema.Number }), label: Schema.String, address: Schema.String });
const geocoder = (input: unknown): NonNullable<Serving['geocoder']> => {
	const port = decode(Schema.Struct({ search: Callback, reverse: Callback }))(input);
	return { search: call(input, port.search, Schema.Array(GeoHit)), reverse: call(input, port.reverse, Schema.NullOr(GeoHit)) };
};
const web = (input: unknown): NonNullable<Serving['web']> => {
	const port = decode(Schema.Struct({ read: Callback }))(input);
	return { read: call(input, port.read, Schema.Struct({ url: Schema.String, title: Schema.NullOr(Schema.String), text: Schema.String, content_type: Schema.optionalKey(Schema.String), sha256: Schema.optionalKey(Schema.String), pages: Schema.optionalKey(Schema.Number), html: Schema.optionalKey(Schema.String), links: Schema.optionalKey(Schema.Array(Schema.String)) })) };
};
const browser = (input: unknown): NonNullable<Serving['browser']> => {
	const port = decode(Schema.Struct({ open: Callback, close: Callback, navigate: Callback, snapshot: Callback, act: Callback, evaluate: Callback, screenshot: Callback, download: Callback, open_workspace: Schema.optionalKey(Callback) }))(input);
	return {
		open: complete(input, port.open), close: complete(input, port.close),
		navigate: call(input, port.navigate, BrowserSnapshotSchema), snapshot: call(input, port.snapshot, BrowserSnapshotSchema), act: call(input, port.act, BrowserSnapshotSchema),
		evaluate: call(input, port.evaluate, Schema.Json), screenshot: call(input, port.screenshot, Schema.Uint8Array), download: call(input, port.download, Downloaded),
		...(port.open_workspace === undefined ? {} : { open_workspace: call(input, port.open_workspace, BrowserSnapshotSchema) })
	};
};

export const hostModule = (input: unknown): { readonly facilities: Facilities; readonly serving: Serving } => {
	const module = decode(Schema.Struct({ default: Schema.Unknown, serving: Schema.optionalKey(Schema.Unknown) }))(input);
	return { facilities: facilities(module.default), serving: module.serving === undefined ? {} : serving(module.serving) };
};
