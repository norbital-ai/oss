import type { ManifestIntegration, ManifestIntegrationBinding } from '@norbital-ai/bolt-protocol';
import type { Schema } from 'effect';
import type {
	PullCursorSpec,
	PullPagesSpec,
	PullRecordsSpec,
	PullRetrySpec,
	WebhookSignatureSpec
} from './contracts-schema.js';
import {
	integration,
	type HttpConnection,
	type IntegrationDeclaration,
	type IntegrationPullDeclaration,
	type IntegrationSendDeclaration,
	type IntegrationSendEvent,
	type IntegrationWebhookDeclaration
} from './workspace-schema.js';

/**
 * Reads an authored `+integrations.ts` the way `describeModel` reads a `+model.ts`.
 *
 * The compiler imports the module live and hands it here, rather than scraping the source text.
 * That is not a preference: a binding's `input` is a live `Schema.Codec` and its `identity.value` is
 * a closure, and neither survives being read as text — the same failure that once dropped every
 * generated column out of a model.
 *
 * One module splits into two halves. The **declaration** is the JSON-shaped half a host can read out
 * of the workspace definition — schedule, method, path, paging, the identity column. The **authored**
 * half is the schema and the functions, which travel in the artifact's authored runtime beside
 * hooks and pipelines and are only ever reached by the integrations runtime.
 */

/** The live half of one binding: everything about it that is not JSON. */
export type AuthoredIntegrationBinding = Readonly<{
	/** Schema for **one** record. Decoded per record, so a bad record costs a record, not a page. */
	readonly input: Schema.Codec<unknown, unknown>;
	readonly identityColumn: string;
	readonly identityValue: (record: unknown) => string;
	/**
	 * The batch lookup, called once with every decoded record and an `api` the runtime supplies.
	 *
	 * `api` is a parameter rather than a closure the split captured, because this half is produced at
	 * artifact boot and an `api` is bound to an invocation. Whatever this answers is handed to every
	 * `map` call for the same batch.
	 */
	readonly resolve?: (records: ReadonlyArray<unknown>, api: unknown) => unknown;
	readonly map?: (record: unknown, resolved: unknown) => Readonly<Record<string, unknown>>;
}>;

/** One collection write, as an outbound binding's trigger and body see it. */
export type IntegrationSendEventContext = Readonly<{
	readonly operation: IntegrationSendEvent;
	readonly record: Readonly<Record<string, unknown>>;
	/** The row as it was before an update or a delete. Absent on a create, and on a delete of a row nobody read. */
	readonly previous?: Readonly<Record<string, unknown>> | undefined;
}>;

/**
 * The live half of one outbound binding: the two functions that run on the write path.
 *
 * Both are called inside the tenant's own mutation, so both are pure and synchronous by
 * construction — `matches` decides whether this write concerns the binding at all, and `body` turns
 * it into the payload that is queued. Neither is allowed to be an Effect or a Promise, which is not
 * a limitation of the wiring but the entire point: a hook that could await would put every write in
 * this collection behind a third party's response time.
 *
 * `matches` and `body` may still *throw* — they are authored code. A throw is caught by the caller
 * and becomes a dead-lettered outbox row naming the binding and the reason, because the alternative
 * is a mistyped predicate failing a tenant's write, or worse, silently dropping the event.
 */
export type AuthoredIntegrationSend = Readonly<{
	readonly events: ReadonlyArray<IntegrationSendEvent>;
	readonly matches: (event: IntegrationSendEventContext) => boolean;
	readonly body?: (event: IntegrationSendEventContext) => unknown;
}>;

/** The live half of one integration, keyed by binding name. */
export type AuthoredIntegrationModule = Readonly<{
	readonly receive: Readonly<Record<string, AuthoredIntegrationBinding>>;
	readonly send: Readonly<Record<string, AuthoredIntegrationSend>>;
}>;

export type DescribedIntegrations = Readonly<{
	readonly declarations: ReadonlyArray<IntegrationDeclaration>;
	readonly authored: Readonly<Record<string, AuthoredIntegrationModule>>;
}>;

/**
 * What an authored module looks like from here: `input` typed, everything else `unknown`.
 *
 * `input` is stated because it is the one field that cannot be recovered structurally — no schema
 * library publishes a runtime brand to narrow a `Codec` against, and reading it as `unknown` would
 * force a cast. Every other field is read defensively below, because a workspace's own module is
 * the input to this function and a bad one should produce a sentence rather than a `TypeError` from
 * three frames deeper.
 */
export type IntegrationBindingInput = Readonly<{
	readonly pull?: unknown;
	readonly webhook?: unknown;
	readonly input?: Schema.Codec<unknown, unknown>;
	readonly records?: unknown;
	readonly identity?: unknown;
	readonly resolve?: unknown;
	readonly map?: unknown;
}>;
/** What an authored outbound binding looks like from here — every field read defensively below. */
type IntegrationSendBindingInput = Readonly<{
	readonly send?: unknown;
	readonly on?: unknown;
	readonly body?: unknown;
}>;
export type IntegrationsModuleInput = Readonly<
	Record<
		string,
		Readonly<{
			readonly policies: unknown;
			readonly connection?: unknown;
			readonly receive?: Readonly<Record<string, IntegrationBindingInput>>;
			readonly send?: Readonly<Record<string, IntegrationSendBindingInput>>;
		}>
	>
>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

const text = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

const stringRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
	const source = record(value);
	if (source === undefined) return undefined;
	const entries = Object.entries(source).flatMap(([key, entry]) =>
		typeof entry === 'string' ? [[key, entry] as const] : []
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

/**
 * Carried through structurally rather than re-validated field by field.
 *
 * These three are closed unions the authoring types already check at the `satisfies Integrations`
 * on the module, and the runtime narrows each one on its own discriminant before acting on it. A
 * second hand-written validation here would be a second place to keep in step with the union.
 */
/** A `{ path: [...] }` location, when the authored value is one. Shared by `records` and every next-cursor. */
const stringPath = (value: unknown): { readonly path: ReadonlyArray<string> } | undefined =>
	Array.isArray(value) && value.length > 0 && value.every((step) => typeof step === 'string')
		? { path: [...value] }
		: undefined;

/** Where a next-cursor is read from, in the four shapes the runtime knows how to read. */
const nextLocation = (
	next: Readonly<Record<string, unknown>>
): PullCursorSpec['next'] | undefined =>
	text(next['header']) !== undefined
		? { header: String(next['header']) }
		: text(next['field']) !== undefined
			? { field: String(next['field']) }
			: text(next['maxOf']) !== undefined
				? { maxOf: String(next['maxOf']) }
				: stringPath(next['path']);

const cursorSpec = (value: unknown): PullCursorSpec | undefined => {
	const source = record(value);
	if (source === undefined) return undefined;
	const send = record(source['send']);
	const next = record(source['next']);
	if (send === undefined || next === undefined) return undefined;
	const sent =
		text(send['query']) !== undefined
			? { query: String(send['query']) }
			: text(send['header']) !== undefined
				? { header: String(send['header']) }
				: undefined;
	const following = nextLocation(next);
	return sent === undefined || following === undefined
		? undefined
		: { send: sent, next: following };
};

const pagesSpec = (value: unknown): PullPagesSpec | undefined => {
	const source = record(value);
	const style = source === undefined ? undefined : text(source['style']);
	if (source === undefined || style === undefined) return undefined;
	const max = typeof source['max'] === 'number' ? { max: source['max'] } : {};
	if (style === 'page') {
		return {
			style: 'page',
			pageQuery: String(source['pageQuery'] ?? 'page'),
			...(text(source['sizeQuery']) === undefined
				? {}
				: { sizeQuery: String(source['sizeQuery']) }),
			...(typeof source['size'] === 'number' ? { size: source['size'] } : {}),
			...(typeof source['firstPage'] === 'number' ? { firstPage: source['firstPage'] } : {}),
			...max
		};
	}
	if (style === 'offset') {
		return {
			style: 'offset',
			offsetQuery: String(source['offsetQuery'] ?? 'offset'),
			limitQuery: String(source['limitQuery'] ?? 'limit'),
			size: typeof source['size'] === 'number' ? source['size'] : 100,
			...max
		};
	}
	if (style === 'cursor') {
		const next = record(source['next']);
		const following = next === undefined ? undefined : nextLocation(next);
		// `maxOf` is excluded here rather than merely unsupported: it summarises the records just read,
		// so it is a resumption point for the *next run* and can never advance a page within this one.
		// A binding that declared it would page forever against the same token.
		return following === undefined || 'maxOf' in following
			? undefined
			: { style: 'cursor', query: String(source['query'] ?? 'cursor'), next: following, ...max };
	}
	return style === 'link-header' ? { style: 'link-header', ...max } : undefined;
};

const recordsSpec = (value: unknown): PullRecordsSpec | undefined => {
	const source = record(value);
	if (source === undefined) return undefined;
	if (text(source['field']) !== undefined) return { field: String(source['field']) };
	return stringPath(source['path']);
};

const retrySpec = (value: unknown): PullRetrySpec | undefined => {
	const source = record(value);
	if (source === undefined || typeof source['attempts'] !== 'number') return undefined;
	return {
		attempts: source['attempts'],
		...(typeof source['initialDelayMs'] === 'number'
			? { initialDelayMs: source['initialDelayMs'] }
			: {}),
		...(typeof source['maxDelayMs'] === 'number' ? { maxDelayMs: source['maxDelayMs'] } : {})
	};
};

/**
 * The outbound connection, which a webhook-only integration legitimately does not have.
 *
 * `required` is false exactly when every binding is a webhook. A pushed delivery arrives at a route
 * the host mounts; there is no request to make, no base URL to make it against, and no credential to
 * present — the signature is the credential and it travels the other way. The field-operations
 * template declared precisely this shape (`dispatch: { receive: { job_updated: { webhook: … } } }`,
 * no `connection` key at all) and requiring a `baseUrl` would have refused it for lacking something
 * it has no use for.
 */
const connectionOf = (
	candidate: unknown,
	integrationName: string,
	required: boolean
): HttpConnection | undefined => {
	const source = record(candidate);
	const baseUrl = source === undefined ? undefined : text(source['baseUrl']);
	if (baseUrl === undefined) {
		if (!required) return undefined;
		throw new TypeError(
			`Integration ${integrationName} declares no connection: a pull or a send has nowhere to go without a baseUrl.`
		);
	}
	const authentication = record(source?.['authentication']);
	if (authentication === undefined) return { baseUrl };
	const type = text(authentication['type']);
	if (type === 'bearer') {
		const token = record(authentication['token']);
		const environment = token === undefined ? undefined : text(token['env']);
		if (environment === undefined) {
			throw new TypeError(
				`Integration ${integrationName} declares bearer authentication without an { env } reference. A literal token in a workspace is a token in the artifact.`
			);
		}
		return { baseUrl, authentication: { type: 'bearer', token: { env: environment } } };
	}
	if (type === 'header') {
		const header = text(authentication['header']);
		const value_ = record(authentication['value']);
		const environment = value_ === undefined ? undefined : text(value_['env']);
		if (header === undefined || environment === undefined) {
			throw new TypeError(
				`Integration ${integrationName} declares header authentication without a header name and an { env } reference.`
			);
		}
		return { baseUrl, authentication: { type: 'header', header, value: { env: environment } } };
	}
	throw new TypeError(
		`Integration ${integrationName} declares an unsupported authentication type.`
	);
};

/**
 * The signature specification, read defensively out of an authored module.
 *
 * Every refusal here names what is missing rather than defaulting it, because every default
 * available would be a *weakening*: an absent header, an absent secret, or an absent algorithm all
 * have an obvious "sensible" fill-in, and each one produces a route that verifies against something
 * other than what the source signed. The one thing that is defaulted is the payload template, whose
 * default (`{body}`) is what most sources actually sign and which `assertVerifiableSignature` then
 * holds to the same rules as an authored one.
 */
const signatureSpec = (binding: string, value: unknown): WebhookSignatureSpec => {
	const source = record(value);
	const header = source === undefined ? undefined : text(source['header']);
	const secret = record(source?.['secret']);
	const environment = secret === undefined ? undefined : text(secret['env']);
	if (header === undefined) {
		throw new TypeError(
			`Integration ${binding} declares a webhook with no signature header. An unsigned delivery is an unauthenticated write into ${binding.split('.')[0] ?? 'the collection'}.`
		);
	}
	if (environment === undefined) {
		throw new TypeError(
			`Integration ${binding} declares a webhook signature without an { env } reference for its secret. A literal secret in a workspace is a secret in the artifact.`
		);
	}
	const algorithm = text(source?.['algorithm']);
	if (algorithm !== undefined && algorithm !== 'sha256' && algorithm !== 'sha512') {
		throw new TypeError(
			`Integration ${binding} declares an unsupported signature algorithm "${algorithm}".`
		);
	}
	const encoding = text(source?.['encoding']);
	if (encoding !== undefined && encoding !== 'hex' && encoding !== 'base64') {
		throw new TypeError(
			`Integration ${binding} declares an unsupported signature encoding "${encoding}".`
		);
	}
	const stamp = record(source?.['timestamp']);
	const stampHeader = stamp === undefined ? undefined : text(stamp['header']);
	const stampParameter = stamp === undefined ? undefined : text(stamp['parameter']);
	if (stamp !== undefined && stampHeader === undefined && stampParameter === undefined) {
		throw new TypeError(
			`Integration ${binding} declares a signature timestamp with neither a header nor a parameter to read it from.`
		);
	}
	return {
		header,
		secret: { env: environment },
		...(algorithm === undefined ? {} : { algorithm }),
		...(encoding === undefined ? {} : { encoding }),
		...(text(source?.['prefix']) === undefined ? {} : { prefix: String(source?.['prefix']) }),
		...(text(source?.['parameter']) === undefined
			? {}
			: { parameter: String(source?.['parameter']) }),
		...(stampHeader !== undefined
			? { timestamp: { header: stampHeader } }
			: stampParameter !== undefined
				? { timestamp: { parameter: stampParameter } }
				: {}),
		...(text(source?.['signedPayload']) === undefined
			? {}
			: { signedPayload: String(source?.['signedPayload']) }),
		...(typeof source?.['toleranceSeconds'] === 'number'
			? { toleranceSeconds: source['toleranceSeconds'] }
			: {})
	};
};

/**
 * The live half of a binding, which is identical whether the source is polled or pushes.
 *
 * Shared rather than written twice, because the two wrappers below are the whole of the platform's
 * "do not trust the record" rule — an empty identity is refused, and a mapper that returns something
 * other than a row is refused — and two copies of that rule is one copy that gets fixed.
 */
const authoredHalf = (
	integrationName: string,
	bindingName: string,
	binding: IntegrationBindingInput
): AuthoredIntegrationBinding => {
	const identity = record(binding.identity);
	const column = identity === undefined ? undefined : text(identity['column']);
	const value = identity?.['value'];
	const input = binding.input;
	if (column === undefined || typeof value !== 'function') {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares no identity { column, value }; without one a second delivery cannot recognise the rows the first one wrote.`
		);
	}
	if (input === undefined) {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares no input schema for one record.`
		);
	}
	const map = binding.map;
	const resolve = binding.resolve;
	if (resolve !== undefined && typeof resolve !== 'function') {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares a resolve that is not a function.`
		);
	}
	// A resolve with nothing to hand its answer to is a query per batch that changes no row, and the
	// author almost certainly meant to write the `map` that reads it. Refused here rather than run.
	if (resolve !== undefined && typeof map !== 'function') {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares a resolve but no map; nothing would ever read what it looked up.`
		);
	}
	return {
		input,
		identityColumn: column,
		identityValue: (candidate: unknown) => {
			const key: unknown = Reflect.apply(value, undefined, [candidate]);
			if (typeof key !== 'string' || key.trim() === '') {
				throw new TypeError(
					`Integration ${integrationName}.${bindingName} read an empty external identity from a record; an empty key would make every record the same record.`
				);
			}
			return key;
		},
		...(typeof resolve === 'function'
			? {
					resolve: (records: ReadonlyArray<unknown>, api: unknown): unknown =>
						Reflect.apply(resolve, undefined, [{ records, api }])
				}
			: {}),
		...(typeof map === 'function'
			? {
					map: (candidate: unknown, resolved: unknown): Readonly<Record<string, unknown>> => {
						const produced: unknown = Reflect.apply(map, undefined, [candidate, resolved]);
						const mapped = record(produced);
						if (mapped === undefined) {
							throw new TypeError(
								`Integration ${integrationName}.${bindingName} mapped a record to something that is not a row.`
							);
						}
						return mapped;
					}
				}
			: {})
	};
};

const webhookDeclaration = (
	integrationName: string,
	bindingName: string,
	binding: IntegrationBindingInput
): {
	readonly declaration: IntegrationWebhookDeclaration;
	readonly authored: AuthoredIntegrationBinding;
} => {
	const webhook = record(binding.webhook);
	const path = webhook === undefined ? undefined : text(webhook['path']);
	if (webhook === undefined || path === undefined) {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares no webhook { path }.`
		);
	}
	const authored = authoredHalf(integrationName, bindingName, binding);
	const eventIdHeader = text(webhook['eventIdHeader']);
	const records = recordsSpec(binding.records);
	return {
		declaration: {
			name: bindingName,
			path,
			signature: signatureSpec(`${integrationName}.${bindingName}`, webhook['signature']),
			...(eventIdHeader === undefined ? {} : { eventIdHeader }),
			...(records === undefined ? {} : { records }),
			identityColumn: authored.identityColumn
		},
		authored
	};
};

const pullDeclaration = (
	integrationName: string,
	bindingName: string,
	binding: IntegrationBindingInput
): {
	readonly declaration: IntegrationPullDeclaration;
	readonly authored: AuthoredIntegrationBinding;
} => {
	const pull = record(binding.pull);
	const path = pull === undefined ? undefined : text(pull['path']);
	const schedule = pull === undefined ? undefined : text(pull['schedule']);
	if (pull === undefined || path === undefined || schedule === undefined) {
		throw new TypeError(
			`Integration ${integrationName}.${bindingName} declares no pull { schedule, path }.`
		);
	}
	const authored = authoredHalf(integrationName, bindingName, binding);
	const method = text(pull['method']) === 'POST' ? 'POST' : 'GET';
	const query = stringRecord(pull['query']);
	const headers = stringRecord(pull['headers']);
	const cursor = cursorSpec(pull['cursor']);
	const pages = pagesSpec(pull['pages']);
	const retry = retrySpec(pull['retry']);
	const records = recordsSpec(binding.records);
	return {
		declaration: {
			name: bindingName,
			schedule,
			method,
			path,
			...(query === undefined ? {} : { query }),
			...(headers === undefined ? {} : { headers }),
			...(cursor === undefined ? {} : { cursor }),
			...(pages === undefined ? {} : { pages }),
			...(retry === undefined ? {} : { retry }),
			...(records === undefined ? {} : { records }),
			identityColumn: authored.identityColumn
		},
		authored
	};
};

const SEND_EVENTS: ReadonlyArray<IntegrationSendEvent> = ['create', 'update', 'delete'];

/**
 * Normalises the three shapes `on` may take into one predicate and the list of events it covers.
 *
 * `'update'` and `{ update: () => true }` mean the same thing and are stated differently because
 * the short form is what most bindings want, so the short form exists. Everything downstream sees
 * only the normal form: a list of subscribed events, and one function that answers yes or no.
 *
 * An event the binding did not subscribe to answers `false` rather than throwing, because the write
 * path consults `events` first and this is the belt to that brace.
 */
const sendTrigger = (
	binding: string,
	value: unknown
): {
	readonly events: ReadonlyArray<IntegrationSendEvent>;
	readonly matches: (event: IntegrationSendEventContext) => boolean;
} => {
	if (typeof value === 'string') {
		const named = SEND_EVENTS.find((event) => event === value);
		if (named === undefined) {
			throw new TypeError(
				`Integration ${binding} triggers on "${value}", which is not one of create, update or delete.`
			);
		}
		return { events: [named], matches: (event) => event.operation === named };
	}
	const source = record(value);
	if (source === undefined) {
		throw new TypeError(
			`Integration ${binding} declares no { on }; without one nothing decides which writes are worth sending.`
		);
	}
	const predicates = new Map<
		IntegrationSendEvent,
		(context: IntegrationSendEventContext) => unknown
	>();
	for (const event of SEND_EVENTS) {
		const candidate = source[event];
		if (candidate === undefined) continue;
		if (typeof candidate !== 'function') {
			throw new TypeError(
				`Integration ${binding} declares a ${event} trigger that is not a function.`
			);
		}
		predicates.set(event, (context) => Reflect.apply(candidate, undefined, [context]));
	}
	if (predicates.size === 0) {
		throw new TypeError(
			`Integration ${binding} subscribes to no collection event, so nothing could ever queue a delivery for it.`
		);
	}
	return {
		events: SEND_EVENTS.filter((event) => predicates.has(event)),
		matches: (event) => {
			const predicate = predicates.get(event.operation);
			// Read as a truthy test rather than `=== true`: an authored predicate that returns a
			// falsy-but-not-false value should behave as it reads, and the alternative is a binding that
			// silently never fires because somebody returned `record.shipped_at` instead of a boolean.
			return predicate !== undefined && Boolean(predicate(event));
		}
	};
};

const sendDeclaration = (
	integrationName: string,
	bindingName: string,
	binding: IntegrationSendBindingInput
): {
	readonly declaration: IntegrationSendDeclaration;
	readonly authored: AuthoredIntegrationSend;
} => {
	const named = `${integrationName}.${bindingName}`;
	const request = record(binding.send);
	const path = request === undefined ? undefined : text(request['path']);
	if (request === undefined || path === undefined) {
		throw new TypeError(`Integration ${named} declares no send { method, path }.`);
	}
	const method = text(request['method']);
	if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
		// Not defaulted to POST. A delivery that silently creates where the author meant to replace is
		// a wrong write on somebody else's system, and the declaration is one word away from saying so.
		throw new TypeError(
			`Integration ${named} declares send method "${String(method)}"; an outbound binding must state POST, PUT, PATCH or DELETE.`
		);
	}
	const trigger = sendTrigger(named, binding.on);
	const headers = stringRecord(request['headers']);
	const retry = retrySpec(request['retry']);
	const idempotencyHeader = text(request['idempotencyHeader']);
	const body = binding.body;
	if (body !== undefined && typeof body !== 'function') {
		throw new TypeError(`Integration ${named} declares a body that is not a function.`);
	}
	return {
		declaration: {
			name: bindingName,
			method,
			path,
			...(headers === undefined ? {} : { headers }),
			...(retry === undefined ? {} : { retry }),
			...(idempotencyHeader === undefined ? {} : { idempotencyHeader }),
			events: trigger.events
		},
		authored: {
			events: trigger.events,
			matches: trigger.matches,
			...(body === undefined
				? {}
				: {
						body: (event: IntegrationSendEventContext): unknown =>
							Reflect.apply(body, undefined, [event])
					})
		}
	};
};

/**
 * Splits every authored integrations module into its declaration and its live half.
 *
 * Keyed by collection on the way in — the directory is what names the collection — and by
 * `<collection>.<integration>` on the way out, because two collections mirroring the same external
 * system are two integrations with two cursors.
 */
export const describeIntegrations = (
	modulesByCollection: Readonly<Record<string, IntegrationsModuleInput | undefined>>
): DescribedIntegrations => {
	const declarations: Array<IntegrationDeclaration> = [];
	const authored: Record<string, AuthoredIntegrationModule> = {};
	for (const [collection, module] of Object.entries(modulesByCollection).toSorted(
		([left], [right]) => left.localeCompare(right)
	)) {
		if (module === undefined || module === null) continue;
		for (const [integrationName, declaration] of Object.entries(module)) {
			if (declaration === undefined || declaration === null) continue;
			const name = `${collection}.${integrationName}`;
			if (
				!Array.isArray(declaration.policies) ||
				declaration.policies.some((policy) => typeof policy !== 'string' || policy.trim() === '')
			) {
				throw new TypeError(
					`Integration ${name} requires an explicit policies array. Use [] when it needs no data access.`
				);
			}
			// Routed on which of the two the author declared, not on a `kind` tag they would have to
			// remember: the shapes are already disjoint and the authoring union makes declaring both a
			// compile error, so the presence of `webhook` is the discriminant.
			const entries = Object.entries(declaration.receive ?? {});
			const pulls = entries.flatMap(([bindingName, binding]) =>
				record(binding.webhook) === undefined
					? [[bindingName, pullDeclaration(name, bindingName, binding)] as const]
					: []
			);
			const webhooks = entries.flatMap(([bindingName, binding]) =>
				record(binding.webhook) === undefined
					? []
					: [[bindingName, webhookDeclaration(name, bindingName, binding)] as const]
			);
			const sends = Object.entries(declaration.send ?? {}).map(
				([bindingName, binding]) =>
					[bindingName, sendDeclaration(name, bindingName, binding)] as const
			);
			// A send needs a `baseUrl` for exactly the reason a pull does: it is a request this platform
			// makes, and there is nowhere to make it. Only a webhook-only integration may omit one.
			const connection = connectionOf(
				declaration.connection,
				name,
				pulls.length > 0 || sends.length > 0
			);
			declarations.push(
				integration({
					name,
					collection,
					policies: [...declaration.policies],
					...(connection === undefined ? {} : { connection }),
					receive: pulls.map(([, parsed]) => parsed.declaration),
					webhooks: webhooks.map(([, parsed]) => parsed.declaration),
					send: sends.map(([, parsed]) => parsed.declaration)
				})
			);
			authored[name] = {
				receive: Object.fromEntries(
					[...pulls, ...webhooks].map(([bindingName, parsed]) => [bindingName, parsed.authored])
				),
				send: Object.fromEntries(
					sends.map(([bindingName, parsed]) => [bindingName, parsed.authored])
				)
			};
		}
	}
	return { declarations, authored };
};

/**
 * What a host is told about one inbound binding.
 *
 * A projection rather than a pass-through, and it lives here beside the split it belongs to.
 * `schedule`, `path`, `method`, `pages` and `cursor` say *what the artifact wants run and when*,
 * which is a host's question; `query`, `headers`, `retry` and `records` say how the pull loop reads
 * a response, which is nobody's question but the loop's. The connection is omitted for the same
 * reason plus one more: its `{ env }` references name entries in the tenant's vault, and a manifest
 * travels to places where a tenant's credential names have no business being discussed.
 */
const publishedBinding = (binding: IntegrationPullDeclaration): ManifestIntegrationBinding => ({
	name: binding.name,
	schedule: binding.schedule,
	method: binding.method,
	path: binding.path,
	...(binding.cursor === undefined ? {} : { cursor: binding.cursor }),
	...(binding.pages === undefined ? {} : { pages: binding.pages }),
	identityColumn: binding.identityColumn
});

/**
 * The manifest's view of every integration a workspace declares.
 *
 * One function, used by `buildManifest` and by the artifact the compiler emits. They used to be two
 * things and one of them did not exist: `sync.ts` writes its manifest as a literal rather than
 * calling `buildManifest`, so a field added to the builder reached every test and no artifact. A
 * shared projection is what makes "the manifest carries integrations" a single fact instead of two
 * that can quietly disagree.
 */
export const manifestIntegrations = (
	declarations: ReadonlyArray<IntegrationDeclaration>
): ReadonlyArray<ManifestIntegration> =>
	declarations.map((declaration) => ({
		name: declaration.name,
		collection: declaration.collection,
		receive: declaration.receive.map(publishedBinding)
	}));
