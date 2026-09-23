import { Effect, Schema } from 'effect';
import type {
	AnySchema,
	Api,
	DefaultWorkspaceSchema,
	HttpConnection,
	MutationInsertFor,
	PolicyName,
	PullRetrySpec,
	TableName,
	WebhookSignatureSpec
} from './contracts-schema.js';
import type { ChannelName, EnvelopeFor, TransportOf } from './channels-schema.js';
import type { WorkspaceChannelAuthoringTypes } from './authoring-types.js';

/**
 * Integrations: records kept consistent with another system (RFC integrations.md).
 *
 * An integration is one external system, `src/integrations/+<name>.ts`, and every sync against it.
 * A sync keeps one collection consistent with one source's record set, one way or two ways. The
 * engine only ever calls the source capabilities of §5; a REST API and a channel's message history
 * are the same thing to it.
 */

/** Where a list or changes response carries the next page token. */
export type NextPage = { readonly header: string } | string;

/** How a source pages: a token read back and sent as a query, numbered pages, offsets, or `Link`. */
export type PageSpec =
	| { readonly query: string; readonly next: NextPage; readonly max?: number }
	| {
			readonly pageQuery: string;
			readonly sizeQuery?: string;
			readonly size?: number;
			readonly firstPage?: number;
			readonly max?: number;
	  }
	| { readonly offsetQuery: string; readonly limitQuery: string; readonly size: number; readonly max?: number }
	| { readonly linkHeader: true; readonly max?: number };

type Request = {
	readonly path: string;
	readonly method?: 'GET' | 'POST';
	readonly query?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
	/** A dotted path to the records array; omitted when the body is the array. */
	readonly records?: string;
	readonly page?: PageSpec;
	readonly retry?: PullRetrySpec;
};

export type ListSpec = Request;
export type ChangesSpec = Request & {
	/** Where the kept cursor is sent, and where the next one is read from. */
	readonly cursor: {
		readonly send: { readonly query: string } | { readonly header: string };
		readonly next: { readonly header: string } | { readonly field: string } | { readonly maxOf: string };
	};
};
type Write = {
	readonly method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** `:id` is replaced by the record's identity, percent-encoded. */
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retry?: PullRetrySpec;
};

/** The HTTP source capabilities a sync can use; `list`, `identity` and `record` are required. */
export type HttpRecordsSpec<R> = {
	readonly list: ListSpec;
	readonly changes?: ChangesSpec;
	readonly subscribe?: {
		readonly webhook: {
			readonly signature: WebhookSignatureSpec;
			/** A dotted path to the records a delivery carries; omitted when the body is one record. */
			readonly records?: string;
		};
	};
	readonly get?: { readonly path: string };
	readonly create?: Write;
	readonly update?: Write;
	readonly delete?: Write;
	/** The source's key field (dotted). */
	readonly identity: string;
	/** The source's version field (dotted): an etag, `updated_at`, a revision. */
	readonly version?: string;
	/** A field (dotted) whose truthy value marks a record deleted at the source. */
	readonly deleted?: string;
	/**
	 * Where a create carries its idempotency key (the local row id). `field` means the source stores
	 * it, so a reconcile can match a create whose answer was lost.
	 */
	readonly idempotencyKey?: { readonly header: string } | { readonly field: string };
	/** The schema of one remote record, decoded per record so one bad record is one rejection. */
	readonly record: Schema.Codec<R, unknown>;
};

type Capability = 'list' | 'changes' | 'subscribe' | 'get' | 'create' | 'update' | 'delete';

/**
 * A source: a contract, not a provider. `C` is the set of capabilities it answers; the phantom map
 * is what makes a two-way sync over a source missing `create`, `update` or `delete` a type error.
 */
export type Source<R, C extends Capability = Capability> = {
	readonly kind: 'http' | 'channel';
	readonly capabilities: ReadonlyArray<Capability>;
	readonly spec: unknown;
	/** Phantom: the record type the engine decodes. */
	readonly _record?: (record: R) => void;
	readonly _capabilities?: { readonly [K in C]: true };
};

const httpCapabilities = (spec: HttpRecordsSpec<unknown>): ReadonlyArray<Capability> =>
	(['list', 'changes', 'subscribe', 'get', 'create', 'update', 'delete'] as const).filter(
		(capability) => spec[capability] !== undefined
	);

/** An absolute API root without a trailing slash; plain HTTP only for this machine's own names. */
export const checkedBaseUrl = (value: string): string => {
	const url = new URL(value);
	if (
		url.protocol !== 'https:' &&
		url.hostname !== 'localhost' &&
		!url.hostname.endsWith('.localhost') &&
		url.hostname !== '127.0.0.1'
	) {
		throw new TypeError('Connection URLs must use HTTPS outside localhost development.');
	}
	return url.toString().replace(/\/$/, '');
};

/**
 * Declares one HTTP connection — an automation's `connection`, or the connection behind an
 * `http.source` — checked once: an absolute HTTPS root, and non-empty credential names.
 */
export const defineConnection = <const C extends HttpConnection>(connection: C): C => {
	if (
		(connection.authentication?.type === 'header' && connection.authentication.header.trim() === '') ||
		(connection.authentication?.type === 'query' && connection.authentication.name.trim() === '')
	)
		throw new TypeError('Header and query authentication require a non-empty name.');
	if (typeof connection.baseUrl !== 'string') {
		if (connection.baseUrl.env.trim() === '')
			throw new TypeError('A connection base URL variable needs a name.');
		return Object.freeze({ ...connection });
	}
	return Object.freeze({ ...connection, baseUrl: checkedBaseUrl(connection.baseUrl) });
};

/** The replay window a webhook gets when it does not name one: five minutes, in seconds. */
export const WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Refuses a signature specification that cannot actually verify anything: no header, no secret, a
 * template that does not cover the body, or a replay timestamp the signature does not cover.
 */
export const assertVerifiableSignature = (owner: string, signature: WebhookSignatureSpec): void => {
	if (signature.header.trim() === '')
		throw new TypeError(`${owner} declares no signature header; there is nowhere to read the proof from.`);
	if (signature.secret.env.trim() === '')
		throw new TypeError(`${owner} declares no signature secret; an empty key accepts a digest anybody can compute.`);
	const template = signature.signedPayload ?? '{body}';
	if (!template.includes('{body}'))
		throw new TypeError(`${owner} signs a payload template that omits {body}.`);
	if (signature.timestamp !== undefined && !template.includes('{timestamp}'))
		throw new TypeError(`${owner} reads a replay timestamp the signature does not cover, so the window would refuse nothing.`);
	if (signature.toleranceSeconds !== undefined && !(signature.toleranceSeconds > 0))
		throw new TypeError(`${owner} declares a replay window that is not positive.`);
	if (
		Object.hasOwn(signature.timestamp ?? {}, 'parameter') &&
		signature.parameter === undefined &&
		signature.prefix === undefined
	)
		throw new TypeError(`${owner} reads its timestamp from a parameter but names no signature parameter.`);
};

type CapabilitiesOf<Spec> = {
	[K in Capability]: K extends keyof Spec ? (undefined extends Spec[K] ? never : K) : never;
}[Capability];

export const http = {
	/** One connection to an HTTP API, declared once for every sync against it. */
	source: <const Connection extends HttpConnection>(connection: Connection) => {
		const checked = defineConnection(connection);
		return {
			records: <R, const Spec extends HttpRecordsSpec<R>>(
				spec: Spec & HttpRecordsSpec<R>
			): Source<R, CapabilitiesOf<Spec>> => {
				if (spec.identity.trim() === '') throw new TypeError('An http source requires an identity field.');
				if (spec.subscribe !== undefined)
					assertVerifiableSignature('An http source webhook', spec.subscribe.webhook.signature);
				return Object.freeze({
					kind: 'http' as const,
					capabilities: httpCapabilities(spec),
					spec: Object.freeze({ connection: checked, ...spec })
				});
			}
		};
	}
};

/**
 * A declared channel's message stream as a source: `list` is its history, `subscribe` is live
 * ingest, edits and deletes are changes. Always one-way.
 */
export const channel = <const N extends ChannelName>(name: N) => ({
	messages: (
		options: { readonly inbound?: boolean } = {}
	): Source<EnvelopeFor<TransportOf[N]> & { readonly direction: 'inbound' | 'outbound' }, 'list' | 'subscribe'> =>
		Object.freeze({
			kind: 'channel' as const,
			capabilities: ['list', 'subscribe'] as const,
			spec: Object.freeze({ channel: name, inbound: options.inbound ?? false })
		})
});

type ColumnOf<S extends AnySchema, N extends TableName<S>> = keyof MutationInsertFor<S, N> & string;
type ColumnValue<S extends AnySchema, N extends TableName<S>, K extends ColumnOf<S, N>> = MutationInsertFor<
	S,
	N
>[K];

/** A remote field: a top-level key of the record, or a dotted path checked at `bolt sync`. */
type RemoteField<R> = (keyof R & string) | `${string}.${string}`;

/**
 * One mapping read both ways. A string names the remote field; an object translates. A mapping
 * with only `in` is never pushed: the remote owns that field.
 */
export type FieldMapping<S extends AnySchema, N extends TableName<S>, K extends ColumnOf<S, N>, R, Resolved> =
	| RemoteField<R>
	| {
			readonly in: (remote: R, context: { readonly resolve: Resolved }) => ColumnValue<S, N, K>;
			readonly out?: (local: ColumnValue<S, N, K>) => unknown;
			/** The remote field `out` writes; required with `out`. */
			readonly field?: RemoteField<R>;
	  };

export type ConflictRule = 'remote_wins' | 'local_wins' | 'latest';

type CommonSync<S extends AnySchema, N extends TableName<S>, R, Resolved> = {
	/** The local column holding the source's identity. Two rows with one identity cannot exist. */
	readonly identity: ColumnOf<S, N>;
	readonly fields: { readonly [K in ColumnOf<S, N>]?: FieldMapping<S, N, K, R, Resolved> };
	/**
	 * One lookup for a whole page, handed to every `in` as `resolve`: a foreign code becomes a key in
	 * one query per page rather than one per record. A code that resolves to nothing throws in `in`,
	 * which rejects that record and keeps its siblings.
	 */
	readonly resolve?: (context: {
		readonly records: ReadonlyArray<R>;
		readonly api: Api<S>;
	}) => Effect.Effect<Resolved, unknown> | Resolved;
	/** How often the `changes` capability is polled. Defaults to every five minutes. */
	readonly changes?: { readonly schedule: string };
	/** The full comparison that makes the sync converge. Defaults to nightly; floor one minute. */
	readonly reconcile?: { readonly schedule: string };
};

export type OneWaySync<S extends AnySchema, N extends TableName<S>, R, Resolved> = CommonSync<
	S,
	N,
	R,
	Resolved
> & {
	readonly direction: 'one_way';
	readonly source: Source<R, 'list'>;
};

export type TwoWaySync<S extends AnySchema, N extends TableName<S>, R, Resolved> = CommonSync<
	S,
	N,
	R,
	Resolved
> & {
	readonly direction: 'two_way';
	/** Two-way needs create, update and delete: a source without them is a compile error. */
	readonly source: Source<R, 'list' | 'create' | 'update' | 'delete'>;
	/** Fields only one side may change; the other side's writes to them are refused. */
	readonly owns?: {
		readonly remote?: ReadonlyArray<ColumnOf<S, N>>;
		readonly local?: ReadonlyArray<ColumnOf<S, N>>;
	};
	/** Required: every two-way sync states who wins a shared field changed on both sides. */
	readonly conflicts:
		| ConflictRule
		| { readonly default: ConflictRule; readonly fields: { readonly [K in ColumnOf<S, N>]?: ConflictRule } };
	/** A delete on one side against an edit on the other. Defaults to `delete_wins`. */
	readonly deletes?: 'delete_wins' | 'edit_wins';
	/** Local rows the first sync never matched. Defaults to `report`. */
	readonly onUnmatchedLocal?: 'push' | 'keep' | 'report';
};

export type SyncDefinition<S extends AnySchema, N extends TableName<S>, R = unknown, Resolved = unknown> =
	| OneWaySync<S, N, R, Resolved>
	| TwoWaySync<S, N, R, Resolved>;

/**
 * One integration: its sync subject's policies and one sync per collection. `T` maps each synced
 * collection to its source's record type, inferred from the `source` each sync names — so a field
 * mapping reads the remote record's own type, and a named remote field must exist on it.
 */
export type IntegrationDefinition<
	S extends AnySchema = DefaultWorkspaceSchema,
	T = Readonly<Record<string, unknown>>
> = {
	/** The complete authority the sync subject `integration:<name>` holds. */
	readonly policies: ReadonlyArray<PolicyName>;
	readonly syncs: { readonly [N in keyof T]: SyncDefinition<S, N & TableName<S>, T[N], unknown> };
};

/**
 * Declares one integration. The type checks each sync against its collection and source; the
 * runtime checks what types cannot (dotted remote fields, the identity index) at `bolt sync`.
 */
export const defineIntegration = <
	S extends AnySchema = DefaultWorkspaceSchema,
	T extends { readonly [K in TableName<S>]?: unknown } = {}
>(
	definition: IntegrationDefinition<S, T>
): IntegrationDefinition<S, T> => {
	validateIntegration('integration', definition);
	return definition;
};

/** The workspace's declared integration names, once `bolt sync` has generated them. */
type IntegrationNameOf = WorkspaceChannelAuthoringTypes extends { readonly integrationName: infer N extends string }
	? N
	: string;

/** `api.integrations.<name>` in an automation: a full reconcile of every sync it declares, queued. */
export type IntegrationsApi = {
	readonly [N in IntegrationNameOf]: { readonly reconcile: () => Effect.Effect<void> };
};

/** The serialisable half of one sync. */
export interface SyncDeclaration {
	readonly name: string;
	readonly collection: string;
	readonly direction: 'one_way' | 'two_way';
	readonly source: 'http' | 'channel';
	readonly capabilities: ReadonlyArray<Capability>;
	readonly identity: string;
	readonly fields: ReadonlyArray<{
		readonly column: string;
		/** The remote field, when the mapping names one. */
		readonly remote?: string;
		readonly pushed: boolean;
	}>;
	readonly owns: { readonly remote: ReadonlyArray<string>; readonly local: ReadonlyArray<string> };
	readonly conflicts: { readonly default: ConflictRule; readonly fields: Readonly<Record<string, ConflictRule>> };
	readonly deletes: 'delete_wins' | 'edit_wins';
	readonly onUnmatchedLocal: 'push' | 'keep' | 'report';
	readonly changesSchedule?: string;
	readonly reconcileSchedule: string;
	readonly webhook: boolean;
	/** For a channel source: the channel, and whether only inbound messages are records. */
	readonly channel?: { readonly name: string; readonly inbound: boolean };
}

export interface IntegrationDeclaration {
	readonly name: string;
	readonly policies: ReadonlyArray<string>;
	readonly syncs: ReadonlyArray<SyncDeclaration>;
}

/** The live half of one sync: the source spec, the record schema and the mapping functions. */
export interface AuthoredSync {
	readonly spec: unknown;
	readonly record?: Schema.Codec<unknown, unknown>;
	readonly fields: Readonly<
		Record<
			string,
			| string
			| {
					readonly in: (remote: never, context: { readonly resolve: unknown }) => unknown;
					readonly out?: (local: never) => unknown;
					readonly field?: string;
			  }
		>
	>;
	readonly resolve?: (context: { readonly records: ReadonlyArray<unknown>; readonly api: never }) => unknown;
}

export const DEFAULT_RECONCILE_SCHEDULE = '0 3 * * *';
export const DEFAULT_CHANGES_SCHEDULE = '*/5 * * * *';
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const RULES: ReadonlyArray<ConflictRule> = ['remote_wins', 'local_wins', 'latest'];

/** A cron no more often than once a minute: five fields whose minute field is not a seconds form. */
const assertSchedule = (owner: string, schedule: string): void => {
	if (schedule.trim().split(/\s+/).length !== 5)
		throw new TypeError(`${owner} schedule ${JSON.stringify(schedule)} is not a five-field cron (the floor is one minute).`);
};

const validateIntegration = (name: string, definition: unknown): void => {
	if (!isRecord(definition))
		throw new TypeError(`Integration ${name} must default-export defineIntegration({ policies, syncs }).`);
	if (!Array.isArray(definition['policies']) || definition['policies'].length === 0)
		throw new TypeError(`Integration ${name} names no policies, so its sync subject could write nothing.`);
	const syncs = definition['syncs'];
	if (!isRecord(syncs) || Object.keys(syncs).length === 0)
		throw new TypeError(`Integration ${name} declares no syncs.`);
	for (const [collection, sync] of Object.entries(syncs)) {
		const owner = `Integration ${name}.${collection}`;
		if (!isRecord(sync)) throw new TypeError(`${owner} is not a sync.`);
		const source = sync['source'];
		if (!isRecord(source) || (source['kind'] !== 'http' && source['kind'] !== 'channel'))
			throw new TypeError(`${owner}: source is http.source(...).records(...) or channel(...).messages().`);
		const capabilities = source['capabilities'] as ReadonlyArray<Capability>;
		if (!capabilities.includes('list'))
			throw new TypeError(`${owner}: a source that cannot be listed cannot be reconciled.`);
		if (sync['direction'] !== 'one_way' && sync['direction'] !== 'two_way')
			throw new TypeError(`${owner}: direction is 'one_way' or 'two_way'.`);
		if (sync['direction'] === 'two_way') {
			if (source['kind'] === 'channel') throw new TypeError(`${owner}: a channel source is always one-way.`);
			for (const needed of ['create', 'update', 'delete'] as const)
				if (!capabilities.includes(needed))
					throw new TypeError(`${owner}: a two-way sync needs a source with ${needed}.`);
			const conflicts = sync['conflicts'];
			const rule = typeof conflicts === 'string' ? conflicts : isRecord(conflicts) ? conflicts['default'] : undefined;
			if (typeof rule !== 'string' || !RULES.includes(rule as ConflictRule))
				throw new TypeError(`${owner}: a two-way sync must state its conflict rule (${RULES.join(', ')}).`);
		} else {
			for (const key of ['conflicts', 'deletes', 'onUnmatchedLocal', 'owns'])
				if (sync[key] !== undefined) throw new TypeError(`${owner}: ${key} applies only to a two-way sync.`);
		}
		if (typeof sync['identity'] !== 'string' || sync['identity'] === '')
			throw new TypeError(`${owner}: identity names the local column holding the source's key.`);
		const fields = sync['fields'];
		if (!isRecord(fields) || Object.keys(fields).length === 0)
			throw new TypeError(`${owner}: fields maps local columns to remote fields.`);
		// What the type system cannot see, checked here: a named remote field must exist on the
		// record schema (its first segment, for a dotted path into a nested struct).
		const record = isRecord(source['spec']) ? source['spec']['record'] : undefined;
		const struct = record !== null && (typeof record === 'object' || typeof record === 'function') ? Reflect.get(record, 'fields') : undefined;
		const recordFields = struct !== null && typeof struct === 'object' ? Object.keys(struct) : undefined;
		for (const [column, mapping] of Object.entries(fields)) {
			if (typeof mapping === 'string' ? mapping.trim() === '' : !isRecord(mapping) || typeof mapping['in'] !== 'function')
				throw new TypeError(`${owner}.fields.${column} is a remote field name or { in, out?, field? }.`);
			const remote = typeof mapping === 'string' ? mapping : isRecord(mapping) ? mapping['field'] : undefined;
			if (typeof remote === 'string' && recordFields !== undefined && !recordFields.includes(remote.split('.')[0] ?? ''))
				throw new TypeError(`${owner}.fields.${column} names ${remote}, which the source's record does not have.`);
			if (isRecord(mapping) && mapping['out'] !== undefined && typeof mapping['field'] !== 'string')
				throw new TypeError(`${owner}.fields.${column}: an \`out\` mapping names the remote field it writes.`);
		}
		const owns = sync['owns'];
		if (isRecord(owns)) {
			const remote = (owns['remote'] as ReadonlyArray<string> | undefined) ?? [];
			const local = (owns['local'] as ReadonlyArray<string> | undefined) ?? [];
			for (const column of remote)
				if (fields[column] === undefined) throw new TypeError(`${owner}: owns.remote names ${column}, which is not synced.`);
			for (const column of local)
				if (remote.includes(column)) throw new TypeError(`${owner}: ${column} cannot be owned by both sides.`);
		}
		for (const key of ['changes', 'reconcile'] as const) {
			const schedule = sync[key];
			if (schedule !== undefined) {
				if (!isRecord(schedule) || typeof schedule['schedule'] !== 'string')
					throw new TypeError(`${owner}.${key} is { schedule }.`);
				assertSchedule(`${owner}.${key}`, schedule['schedule']);
			}
		}
		if (sync['changes'] !== undefined && !capabilities.includes('changes'))
			throw new TypeError(`${owner}: a changes schedule needs a source with changes.`);
	}
};

const remoteOf = (mapping: AuthoredSync['fields'][string]): string | undefined =>
	typeof mapping === 'string' ? mapping : mapping.field;

/** Splits one authored integration into its declaration and its live half. */
export const describeIntegration = (
	name: string,
	definition: unknown
): {
	readonly declaration: IntegrationDeclaration;
	readonly authored: Readonly<Record<string, AuthoredSync>>;
} => {
	validateIntegration(name, definition);
	const value = definition as IntegrationDefinition<AnySchema>;
	const entries = Object.entries(value.syncs) as ReadonlyArray<
		[string, SyncDefinition<AnySchema, string, unknown, unknown>]
	>;
	return {
		declaration: Object.freeze({
			name,
			policies: Object.freeze([...value.policies]),
			syncs: entries.map(([collection, sync]): SyncDeclaration => {
				const fields = sync.fields as AuthoredSync['fields'];
				const conflicts =
					sync.direction !== 'two_way'
						? { default: 'remote_wins' as const, fields: {} }
						: typeof sync.conflicts === 'string'
							? { default: sync.conflicts, fields: {} }
							: { default: sync.conflicts.default, fields: { ...sync.conflicts.fields } as Record<string, ConflictRule> };
				const spec = sync.source.spec as { channel?: string; inbound?: boolean; subscribe?: unknown };
				return {
					name: collection,
					collection,
					direction: sync.direction,
					source: sync.source.kind,
					capabilities: [...sync.source.capabilities],
					identity: sync.identity,
					fields: Object.entries(fields).map(([column, mapping]) => {
						const remote = remoteOf(mapping);
						return {
							column,
							...(remote === undefined ? {} : { remote }),
							pushed:
								sync.direction === 'two_way' &&
								(typeof mapping === 'string' || mapping.out !== undefined)
						};
					}),
					owns: {
						remote: [...((sync.direction === 'two_way' ? sync.owns?.remote : undefined) ?? [])],
						local: [...((sync.direction === 'two_way' ? sync.owns?.local : undefined) ?? [])]
					},
					conflicts,
					deletes: (sync.direction === 'two_way' ? sync.deletes : undefined) ?? 'delete_wins',
					onUnmatchedLocal: (sync.direction === 'two_way' ? sync.onUnmatchedLocal : undefined) ?? 'report',
					...(sync.source.capabilities.includes('changes')
						? { changesSchedule: sync.changes?.schedule ?? DEFAULT_CHANGES_SCHEDULE }
						: {}),
					reconcileSchedule: sync.reconcile?.schedule ?? DEFAULT_RECONCILE_SCHEDULE,
					webhook: sync.source.kind === 'http' && spec.subscribe !== undefined,
					...(sync.source.kind === 'channel'
						? { channel: { name: spec.channel ?? '', inbound: spec.inbound ?? false } }
						: {})
				};
			})
		}),
		authored: Object.fromEntries(
			entries.map(([collection, sync]): [string, AuthoredSync] => {
				const spec = sync.source.spec as { record?: Schema.Codec<unknown, unknown> };
				return [
					collection,
					{
						spec: sync.source.spec,
						...(spec.record === undefined ? {} : { record: spec.record }),
						fields: sync.fields as AuthoredSync['fields'],
						...(sync.resolve === undefined ? {} : { resolve: sync.resolve as unknown as NonNullable<AuthoredSync['resolve']> })
					}
				];
			})
		)
	};
};
