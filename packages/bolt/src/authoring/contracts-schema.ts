import { Effect, Schema } from 'effect';
import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core';
import type { SystemColumnName } from '../compiler/schema-plan.js';
import type { TExportManifest } from './handlers-schema.js';
import type { ModelDeclaration } from './models-schema.js';
// Type-only, and therefore erased: `workspace-schema.ts` already imports `ChannelDefinition` from
// here, so a value import in this direction would be a real cycle.
import type { HttpConnection, PrivateEnvReference } from './workspace-schema.js';

export interface WorkspaceAuthoringTypes {}

type ApplyDimensions<Value, Dimensions, Depth extends ReadonlyArray<unknown> = readonly []> = [Dimensions] extends [never]
	? Value
	: Dimensions extends number
		? number extends Dimensions ? Value : Depth['length'] extends Dimensions ? Value : ApplyDimensions<ReadonlyArray<Value>, Dimensions, readonly [...Depth, unknown]>
		: Value;
type BuilderValue<Config extends { readonly data: unknown }> = ApplyDimensions<
	Config extends { readonly $type: infer Custom } ? [Custom] extends [never] ? Config['data'] : Custom : Config['data'],
	Config extends { readonly dimensions: infer Dimensions } ? Dimensions : 0
>;
type BuilderData<B> = B extends { readonly _: infer Config extends { readonly data: unknown } }
	? Config extends { readonly notNull: true }
		? BuilderValue<Config>
		: BuilderValue<Config> | null
	: never;
/**
 * What each platform-owned column reads back as.
 *
 * Indexed by `SystemColumnName` below rather than being the row type itself, so the set of columns
 * comes from the DDL map in `schema-plan.ts` and only their value types are stated here. A column
 * added to that map without an entry here fails to compile; the previous hand-written list simply
 * omitted `norbital_sys_period` and nothing said so.
 *
 * `norbital_sys_period` is a `tstzrange`, which the driver hands back in Postgres' literal range
 * form (`["2026-01-01 00:00:00+00",)`) — a string, not a pair of dates.
 */
interface SystemColumnValue {
	readonly norbital_id: string;
	readonly norbital_created_at: string;
	readonly norbital_updated_at: string;
	readonly norbital_sys_period: string;
	readonly norbital_row_version: number;
	readonly norbital_approval_id: string | null;
}
export type SystemRow = { readonly [K in SystemColumnName]: SystemColumnValue[K] };
type SelectForColumns<C extends Readonly<Record<string, AnyPgColumnBuilder>>> = SystemRow & { readonly [K in keyof C]: BuilderData<C[K]> };
type RequiredInsertKeys<C extends Readonly<Record<string, AnyPgColumnBuilder>>> = {
	[K in keyof C]: C[K] extends { readonly _: { readonly notNull: true } }
		? C[K] extends { readonly _: { readonly hasDefault: true } } ? never : K
		: never
}[keyof C];
type InsertForColumns<C extends Readonly<Record<string, AnyPgColumnBuilder>>> = {
	readonly [K in RequiredInsertKeys<C>]: BuilderData<C[K]>
} & {
	readonly [K in Exclude<keyof C, RequiredInsertKeys<C>>]?: BuilderData<C[K]>
};
type ColumnsOf<M extends ModelDeclaration> = M['columns'];

export interface TableShape<Select, Insert = Partial<Select>> {
	readonly $inferSelect: Select;
	readonly $inferInsert: Insert;
}

export type TablesForModels<M extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly [K in keyof M]: TableShape<SelectForColumns<ColumnsOf<M[K]>>, InsertForColumns<ColumnsOf<M[K]>>>;
};

export interface AnySchema {
	readonly tables: Readonly<Record<string, TableShape<object, object>>>;
	readonly relations: Readonly<Record<string, unknown>>;
	readonly inputs: Readonly<Record<string, { readonly create: unknown; readonly update: unknown }>>;
}

export type DefaultWorkspaceSchema = WorkspaceAuthoringTypes extends { readonly schema: infer S extends AnySchema } ? S : AnySchema;
export type TableName<S extends AnySchema> = keyof S['tables'] & string;
export type SchemaRow<S extends AnySchema, N extends TableName<S>> = S['tables'][N]['$inferSelect'];
type QueryScalar = string | number | boolean | bigint | Date | null;
type QueryOperand<Value> = Exclude<Value, undefined> extends QueryScalar ? Exclude<Value, undefined> | Date : unknown;
export type SchemaFieldFilter<Value> = {
	readonly eq?: QueryOperand<Value>;
	readonly ne?: QueryOperand<Value>;
	readonly gt?: QueryOperand<Value>;
	readonly gte?: QueryOperand<Value>;
	readonly lt?: QueryOperand<Value>;
	readonly lte?: QueryOperand<Value>;
	readonly in?: ReadonlyArray<QueryOperand<Value>>;
	readonly notIn?: ReadonlyArray<QueryOperand<Value>>;
	readonly like?: string;
	readonly ilike?: string;
	readonly contains?: unknown;
	readonly contains_date?: string;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
};
export interface SchemaRawOperators {
	readonly sql: (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => unknown;
}
export type SchemaWhere<Row extends object> = {
	readonly [K in keyof Row]?: SchemaFieldFilter<Row[K]> | QueryOperand<Row[K]>;
} & {
	readonly AND?: ReadonlyArray<SchemaWhere<Row>>;
	readonly OR?: ReadonlyArray<SchemaWhere<Row>>;
	readonly NOT?: SchemaWhere<Row>;
	readonly RAW?: (table: Readonly<Record<keyof Row, unknown>>, operators: SchemaRawOperators) => unknown;
	readonly $sql?: string;
};
export interface SchemaQueryConfig<S extends AnySchema, N extends TableName<S>> {
	readonly where?: SchemaWhere<SchemaRow<S, N>>;
	readonly columns?: Partial<Readonly<Record<keyof SchemaRow<S, N>, boolean>>>;
	readonly orderBy?: Partial<Readonly<Record<keyof SchemaRow<S, N>, 'asc' | 'desc'>>>;
	readonly with?: Readonly<Record<string, boolean | Readonly<Record<string, unknown>>>>;
	readonly limit?: number;
	readonly offset?: number;
}

type SelectedKeys<Row, Columns> = true extends Columns[keyof Columns]
	? { [K in keyof Columns & keyof Row]: Columns[K] extends false ? never : K }[keyof Columns & keyof Row]
	: Exclude<keyof Row, { [K in keyof Columns & keyof Row]: Columns[K] extends false ? K : never }[keyof Columns & keyof Row]>;
type SelectColumns<Row, Config> = Config extends { readonly columns: infer Columns }
	? Pick<Row, SelectedKeys<Row, Columns>>
	: Row;
type WithRows<Config> = Config extends { readonly with: infer W }
	? { readonly [K in keyof W]: Readonly<Record<string, unknown>> | ReadonlyArray<Readonly<Record<string, unknown>>> | null }
	: Readonly<Record<never, never>>;
export type SchemaQueryRow<S extends AnySchema, N extends TableName<S>, Config extends SchemaQueryConfig<S, N> | undefined = undefined> = SelectColumns<SchemaRow<S, N>, Config> & WithRows<Config>;

export type MutationInsertFor<S extends AnySchema, N extends TableName<S>> = S['tables'][N]['$inferInsert'];
export type MutationUpdateFor<S extends AnySchema, N extends TableName<S>> = Partial<S['tables'][N]['$inferSelect']>;
export type InputValuesForTables<T extends Readonly<Record<string, TableShape<unknown, unknown>>>> = {
	readonly [K in keyof T]: { readonly create: T[K]['$inferInsert']; readonly update: Partial<T[K]['$inferSelect']> };
};

export interface NearestQueryConfig<Row> {
	readonly column: keyof Row & string;
	readonly probe: ReadonlyArray<number>;
	readonly metric: 'cosine' | 'l2' | 'ip';
	readonly maxDistance?: number;
	readonly limit: number;
	readonly excludeIds?: ReadonlyArray<string>;
}

export interface CollectionQuery<S extends AnySchema, N extends TableName<S>> {
	findMany(): Effect.Effect<Array<SchemaRow<S, N> & Readonly<Record<string, unknown>>>>;
	findMany<const Config extends SchemaQueryConfig<S, N>>(config: Config): Effect.Effect<Array<SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>>>;
	findFirst(): Effect.Effect<(SchemaRow<S, N> & Readonly<Record<string, unknown>>) | undefined>;
	findFirst<const Config extends SchemaQueryConfig<S, N>>(config: Config): Effect.Effect<(SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>) | undefined>;
	readonly count: (config?: Pick<SchemaQueryConfig<S, N>, 'where'>) => Effect.Effect<number>;
	readonly findNearest: (config: NearestQueryConfig<SchemaRow<S, N>>) => Effect.Effect<Array<SchemaRow<S, N> & { readonly distance: number }>>;
}
export interface ApprovalRequestRow extends SystemRow {
	readonly collection_name: string;
	readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
	readonly closed_at: Date | null;
	readonly locked_record_refs: unknown;
}
export interface ApprovalRequestQuery {
	readonly findMany: <const Config extends {
		readonly where?: SchemaWhere<ApprovalRequestRow>;
		readonly columns?: Partial<Readonly<Record<keyof ApprovalRequestRow, boolean>>>;
		readonly orderBy?: Partial<Readonly<Record<keyof ApprovalRequestRow, 'asc' | 'desc'>>>;
		readonly limit?: number;
	}>(config?: Config) => Effect.Effect<Array<ApprovalRequestRow>>;
	readonly findFirst: <const Config extends {
		readonly where?: SchemaWhere<ApprovalRequestRow>;
		readonly limit?: number;
	}>(config?: Config) => Effect.Effect<ApprovalRequestRow | undefined>;
}
export interface StructuredInferenceInput<S extends AnySchema, Output> {
	readonly schema: Schema.Schema<Output>;
	readonly prompt: string;
	readonly model?: string;
	readonly profile?: string;
	readonly collections?: ReadonlyArray<TableName<S>>;
	readonly images?: ReadonlyArray<{ readonly assetId: string; readonly detail?: 'auto' | 'low' | 'high' }>;
}

export type BeforeApi<S extends AnySchema = DefaultWorkspaceSchema> = {
	readonly db: { readonly query: { readonly [N in TableName<S>]: CollectionQuery<S, N> } & { readonly approval_request: ApprovalRequestQuery } } & {
		readonly [N in TableName<S>]: CollectionQuery<S, N> & {
			readonly create: (input: MutationInsertFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
			readonly update: (id: string, input: MutationUpdateFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
		};
	};
	readonly infer: <Output>(input: StructuredInferenceInput<S, Output>) => Effect.Effect<Output>;
	readonly readFileAsset: (assetId: string) => Effect.Effect<{
		readonly id: string;
		readonly name: string;
		readonly mimeType: string | null;
		readonly size: number;
		readonly bytes: Uint8Array;
	}>;
};
export type HookApi<S extends AnySchema = DefaultWorkspaceSchema> = BeforeApi<S>;
export type ElevatedMutationPayload<S extends AnySchema, N extends TableName<S>> = MutationInsertFor<S, N> | ({ readonly norbital_id: string } & MutationUpdateFor<S, N>);
/**
 * The elevated writes, on the collection — one shape for reaching a collection, not two.
 *
 * These were declared on `db` itself, taking the collection as a first argument, while everything
 * else in this contract reaches a collection as a property: `db.query.<name>.findMany`,
 * `db.<name>.create`, `db.<name>.update`. Two ways to say one thing is one too many, and the
 * db-level pair was additionally never implemented — the proxy behind `db` answered any string with
 * a per-collection object, so `api.db.mutate` was an object named `mutate` and
 * `yield* api.db.mutate('payslips', rows)` raised `is not iterable` while typechecking cleanly.
 */
export type AfterHookApi<S extends AnySchema = DefaultWorkspaceSchema> = Omit<BeforeApi<S>, 'db'> & {
	readonly db: { readonly query: BeforeApi<S>['db']['query'] } & {
		readonly [N in TableName<S>]: CollectionQuery<S, N> & {
			readonly create: (input: MutationInsertFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
			readonly update: (id: string, input: MutationUpdateFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
			readonly mutate: (payloads: ReadonlyArray<ElevatedMutationPayload<S, N>>) => Effect.Effect<Array<SchemaRow<S, N> & Readonly<Record<string, unknown>>>>;
			readonly delete: (identifiers: ReadonlyArray<string>) => Effect.Effect<void>;
		};
	};
};

type DescribedHook<Handler> = { readonly description: string; readonly handler: Handler };
type DescribedBatchHook<Handler, BatchHandler> = DescribedHook<Handler> & { readonly batchHandler?: BatchHandler };
type CreateInput<S extends AnySchema, N extends TableName<S>> = MutationInsertFor<S, N>;
type CreateMutationPayload<S extends AnySchema, N extends TableName<S>> = MutationInsertFor<S, N> & Readonly<Record<string, unknown>>;
type CreateBefore<S extends AnySchema, N extends TableName<S>> = (context: { readonly input: CreateInput<S, N>; readonly api: HookApi<S> }) => Effect.Effect<CreateInput<S, N> | CreateMutationPayload<S, N>, unknown, never> | Promise<CreateInput<S, N> | CreateMutationPayload<S, N>> | CreateInput<S, N> | CreateMutationPayload<S, N>;
type CreateBeforeBatch<S extends AnySchema, N extends TableName<S>> = (context: { readonly inputs: ReadonlyArray<CreateInput<S, N>>; readonly api: HookApi<S> }) => Effect.Effect<ReadonlyArray<CreateInput<S, N> | CreateMutationPayload<S, N>>, unknown, never> | Promise<ReadonlyArray<CreateInput<S, N> | CreateMutationPayload<S, N>>> | ReadonlyArray<CreateInput<S, N> | CreateMutationPayload<S, N>>;
type CreateAfter<S extends AnySchema, N extends TableName<S>> = (context: { readonly record: SchemaRow<S, N>; readonly api: AfterHookApi<S> }) => Effect.Effect<void, unknown, never> | Promise<void> | void;
type CreateAfterBatch<S extends AnySchema, N extends TableName<S>> = (context: { readonly records: ReadonlyArray<SchemaRow<S, N>>; readonly api: AfterHookApi<S> }) => Effect.Effect<void, unknown, never> | Promise<void> | void;

export type CollectionHooks<S extends AnySchema, N extends TableName<S>> = {
	readonly create?: {
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly before?: DescribedBatchHook<CreateBefore<S, N>, CreateBeforeBatch<S, N>>;
		readonly after?: DescribedBatchHook<CreateAfter<S, N>, CreateAfterBatch<S, N>>;
	};
	readonly update?: {
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly before?: DescribedHook<(context: { readonly input: MutationUpdateFor<S, N>; readonly existing: SchemaRow<S, N>; readonly api: HookApi<S> }) => Effect.Effect<MutationUpdateFor<S, N>, unknown, never> | Promise<MutationUpdateFor<S, N>> | MutationUpdateFor<S, N>>;
		readonly after?: DescribedHook<(context: { readonly record: SchemaRow<S, N>; readonly api: AfterHookApi<S> }) => Effect.Effect<void, unknown, never> | Promise<void> | void>;
	};
	readonly delete?: {
		readonly before?: DescribedHook<(context: { readonly existing: SchemaRow<S, N>; readonly api: HookApi<S> }) => Effect.Effect<void, unknown, never> | Promise<void> | void>;
		readonly after?: DescribedHook<(context: { readonly record: SchemaRow<S, N>; readonly api: AfterHookApi<S> }) => Effect.Effect<void, unknown, never> | Promise<void> | void>;
	};
};
export type CollectionPipelines<S extends AnySchema, N extends TableName<S>> = {
	readonly export?: { readonly description: string; readonly handler: (context: { readonly records: ReadonlyArray<SchemaRow<S, N>> }, api: BeforeApi<S>) => Effect.Effect<TExportManifest, unknown, never> | Promise<TExportManifest> | TExportManifest };
	readonly import?: { readonly description: string; readonly input: Schema.Codec<unknown, unknown>; readonly handler: (context: { readonly input: unknown }, api: BeforeApi<S>) => Effect.Effect<ReadonlyArray<MutationInsertFor<S, N>>, unknown, never> | Promise<ReadonlyArray<MutationInsertFor<S, N>>> | ReadonlyArray<MutationInsertFor<S, N>> };
};
type CollectionEventTrigger<S extends AnySchema, N extends TableName<S>> =
	| 'create'
	| 'update'
	| 'delete'
	| {
		readonly create?: (context: { readonly record: SchemaRow<S, N> }) => boolean;
		readonly update?: (context: { readonly previous: SchemaRow<S, N>; readonly record: SchemaRow<S, N> }) => boolean;
		readonly delete?: (context: { readonly record: SchemaRow<S, N> }) => boolean;
	};
/**
 * The request half of an outbound binding: where a delivery goes and how hard the platform tries.
 *
 * `path` may carry `{column}` tokens, filled from the **stored record** and percent-encoded — a
 * `PUT /orders/{external_id}` is otherwise inexpressible, and every real update-or-delete API needs
 * the external key in the URL. They are read off the row the platform wrote, never off the body an
 * author's `body` function produced, for the same reason an inbound identity is read through the
 * declared `identity` and never from the payload: a value the delivery itself supplies is a value
 * the delivery gets to choose.
 *
 * `retry` is the pull's own spec, reused rather than restated: the two policies are the same policy
 * (a 429 or a 5xx is worth asking again, a 4xx never is), and one attempt count means one place to
 * read when a partner complains.
 *
 * `idempotencyHeader` names the header the platform's own delivery key rides in. Outbound delivery
 * here is **at-least-once**, so the key is what lets a receiver collapse a repeat; it is derived
 * from the outbox row and is byte-identical across every retry of that row.
 */
export type SendRequestSpec = {
	readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retry?: PullRetrySpec;
	/** Defaults to `idempotency-key`. */
	readonly idempotencyHeader?: string;
};

/**
 * One outbound binding: a row changed here, so something is told about it there.
 *
 * `on` decides which writes are worth telling anyone about, and the predicate form is evaluated on
 * the write path — it is pure and synchronous by construction, like a binding's `map`, because
 * anything else would put a tenant's write behind somebody else's I/O.
 *
 * `body` builds the payload at the moment of the event, and the payload is stored with the queued
 * delivery rather than recomputed at send time. That is what makes a delivery mean "this happened"
 * instead of "here is the current state": a row updated twice sends two bodies, and a row deleted
 * after an update still sends the update it caused. It defaults to
 * `{ event, collection, id, record }` when a binding declares none.
 */
type CollectionSendBinding<S extends AnySchema, N extends TableName<S>> = {
	readonly on: CollectionEventTrigger<S, N>;
	readonly send: SendRequestSpec;
	readonly body?: (event: {
		readonly operation: 'create' | 'update' | 'delete';
		readonly record: SchemaRow<S, N>;
		readonly previous?: SchemaRow<S, N>;
	}) => unknown;
};
/**
 * Where the platform sends the cursor it kept, and where it reads the next one from.
 *
 * `send` is omitted for a feed that has no incremental mode: the binding then re-reads the whole
 * source every run, which is a full refresh, and the idempotent upsert is what makes that cheap
 * rather than destructive.
 */
export type PullCursorSpec = {
	readonly send: { readonly query: string } | { readonly header: string };
	readonly next:
		| { readonly header: string }
		| { readonly field: string }
		/**
		 * The same read as `field`, for a cursor the source buried in an envelope.
		 *
		 * Present because `field` alone could only reach the top level, and an enveloped body is the
		 * common case rather than the exotic one — Crossref answers `{ message: { next-cursor } }` and
		 * MediaWiki answers `{ continue: { apcontinue } }`. A top-level-only read does not fail loudly
		 * against either: it finds nothing, reports no next page, and the run silently stops after one.
		 */
		| { readonly path: ReadonlyArray<string> }
		/** The greatest value of this field across the records just read — the usual `updated_at` watermark. */
		| { readonly maxOf: string };
};

/**
 * How the source pages, in the four shapes real APIs actually use.
 *
 * `max` bounds the run: a paging bug on either side must cost one run, not an unbounded loop
 * against someone else's API.
 */
export type PullPagesSpec =
	| { readonly style: 'page'; readonly pageQuery: string; readonly sizeQuery?: string; readonly size?: number; readonly firstPage?: number; readonly max?: number }
	| { readonly style: 'offset'; readonly offsetQuery: string; readonly limitQuery: string; readonly size: number; readonly max?: number }
	| { readonly style: 'cursor'; readonly query: string; readonly next: { readonly header: string } | { readonly field: string } | { readonly path: ReadonlyArray<string> }; readonly max?: number }
	| { readonly style: 'link-header'; readonly max?: number };

/** Retry with exponential backoff. `Retry-After` on a 429 or 503 wins over the computed delay. */
export type PullRetrySpec = {
	readonly attempts: number;
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
};

/** The request half of a pull binding: everything needed to ask the source for the next batch. */
export type PullRequestSpec = {
	/** Cron, in the host's scheduler. Carried into the manifest so the host can register the job. */
	readonly schedule: string;
	readonly method?: 'GET' | 'POST';
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
	readonly cursor?: PullCursorSpec;
	readonly pages?: PullPagesSpec;
	readonly retry?: PullRetrySpec;
};

/** Where the records live in a response body. Omitted when the body *is* the array. */
export type PullRecordsSpec = { readonly field: string } | { readonly path: ReadonlyArray<string> };

/**
 * What makes the sync idempotent, stated as a column of this collection.
 *
 * `column` is the collection's own external-key column and `value` reads that key off one decoded
 * record. Every run matches on it, so a re-run updates the row it wrote last time instead of
 * inserting a second one — and the guarantee is visible in the schema (put a unique index on the
 * column) rather than buried in a handler.
 */
export type PullIdentitySpec = {
	readonly column: string;
	readonly value: (record: never) => string;
};

/**
 * How a delivery proves it came from the source, and how long that proof stays good for.
 *
 * The shape follows what providers actually send, because a signature scheme that cannot express
 * GitHub, Shopify, Slack and Stripe is a scheme no template can use:
 *
 * - GitHub — `X-Hub-Signature-256: sha256=<hex>` over the body. `{ header, prefix: 'sha256=' }`.
 * - Shopify — `X-Shopify-Hmac-Sha256: <base64>` over the body. `{ header, encoding: 'base64' }`.
 * - Slack — `X-Slack-Signature: v0=<hex>` over `v0:<ts>:<body>`, timestamp in its own header.
 *   `{ header, prefix: 'v0=', timestamp: { header: 'x-slack-request-timestamp' }, signedPayload: 'v0:{timestamp}:{body}' }`.
 * - Stripe — `Stripe-Signature: t=<ts>,v1=<hex>` over `<ts>.<body>`, timestamp inside the same
 *   header. `{ header, parameter: 'v1', timestamp: { parameter: 't' }, signedPayload: '{timestamp}.{body}' }`.
 *
 * `secret` is a vault reference and never a literal, for the reason `defineConnection` already
 * refuses a literal bearer token: a secret written into a workspace is a secret in the artifact.
 *
 * `signedPayload` is the template the source signed, over the **raw request body** — `{body}` is
 * the bytes as they arrived, not a re-serialisation of the parsed JSON. Those are different strings
 * for the same document (key order, whitespace, unicode escaping), so a digest taken over parsed
 * JSON does not match anything the sender computed. It defaults to `'{body}'`, which is the
 * signature scheme most sources use.
 *
 * `timestamp` is the replay defence, and it is only a defence when the timestamp is *inside*
 * `signedPayload`: a timestamp the signature does not cover is a value the attacker replaying the
 * body can set to whatever they like. `defineWebhook` refuses that combination rather than
 * accepting a declaration whose freshness check does nothing.
 */
export type WebhookSignatureSpec = {
	/** The header carrying the signature, matched case-insensitively. */
	readonly header: string;
	/** The vault name holding the shared secret, resolved exactly as the pull's bearer token is. */
	readonly secret: PrivateEnvReference;
	readonly algorithm?: 'sha256' | 'sha512';
	readonly encoding?: 'hex' | 'base64';
	/** Stripped off the header value before it is decoded — GitHub's `sha256=`, Slack's `v0=`. */
	readonly prefix?: string;
	/** The key naming the signature inside a `k=v,k=v` header — Stripe's `v1`. */
	readonly parameter?: string;
	/** Where the signed timestamp is read from. Omitted only when the source signs no timestamp. */
	readonly timestamp?: { readonly header: string } | { readonly parameter: string };
	/** What the source ran the digest over, with `{body}` and `{timestamp}` substituted. */
	readonly signedPayload?: string;
	/** How far out of date a delivery may be, in seconds. Defaults to 300. */
	readonly toleranceSeconds?: number;
};

/**
 * The push half of an inbound binding: where the delivery lands and what makes it trustworthy.
 *
 * `signature` is not optional. A route that accepts an unsigned body is an unauthenticated write
 * port into a collection, and this codebase has already shipped one of those once.
 *
 * `eventIdHeader` names the header carrying the source's own delivery id — `X-GitHub-Delivery`,
 * `X-Shopify-Event-Id`, the field-operations template's `x-dispatch-event-id`. It is used for the
 * delivery ledger's key, so a redelivery of the same event is recognised as the same delivery
 * before any record is read. It is a *header* and never a body field, because the body is the thing
 * under suspicion; when it is absent the platform keys the ledger on the verified digest instead,
 * which is a value only somebody holding the secret could have produced.
 */
export type WebhookRequestSpec = {
	/** The route the host mounts for this binding, relative to the workspace's webhook root. */
	readonly path: string;
	readonly signature: WebhookSignatureSpec;
	readonly eventIdHeader?: string;
};

/**
 * What every inbound binding shares, whichever direction the bytes travel.
 *
 * `input` is the schema for **one record**, not for the whole body. A whole-body schema cannot
 * express partial failure — one malformed vendor in a page of five hundred fails the decode and
 * discards the other four hundred and ninety-nine — so the platform selects the records first and
 * decodes each one on its own, keeping the good ones and reporting the rest. It is the one part of
 * the pull's design that transferred to push unchanged, and it is the reason a webhook carrying a
 * batch of events does not lose the batch to one bad member.
 *
 * The row a record becomes is decided by the nearest declaration that says so: `map` here if the
 * binding declares one, otherwise the collection's `import` pipeline if it has one, otherwise the
 * decoded record itself.
 *
 * `map` is still `(record) => Row` — pure and synchronous, with no `api` and no Effect — because a
 * function called once per record must not be allowed to reach the database. `resolve` is what
 * lifts the limitation that used to follow from that: it runs **once for the whole batch**, holds
 * an `api`, and hands `map` whatever it looked up as a second argument. So a record carrying a
 * foreign *code* can become a `uuid` foreign key, and an import of five thousand rows costs one
 * lookup rather than five thousand.
 *
 * The arithmetic is the whole reason it is shaped this way. A per-record `api` reads beautifully on
 * ten rows and, at a round trip of roughly 250ms, turns a 5,000-row import into about twenty
 * minutes of sequential waiting for one foreign key and twice that for two. A per-batch step turns
 * the same import into one query per page.
 *
 * A code that resolves to nothing is not this step's failure — `resolve` succeeded, the code simply
 * is not there — so `map` refuses that record by throwing, and the platform rejects that record and
 * keeps its siblings. `resolve` itself failing is a batch failure, because a database that will not
 * answer is not attributable to any one record and the run should be retried rather than have its
 * cursor advanced past records nothing was written for.
 */
type CollectionInboundBinding<S extends AnySchema, N extends TableName<S>> = {
	readonly input: Schema.Codec<unknown, unknown>;
	readonly records?: PullRecordsSpec;
	readonly identity: PullIdentitySpec;
	/**
	 * One lookup for the whole batch, whose result is handed to every `map` call.
	 *
	 * `records` is the decoded batch — every record that survived the schema and produced an
	 * identity — so the step sees exactly the set that is about to be written and can gather its
	 * keys in one `in (…)`.
	 */
	readonly resolve?: (context: { readonly records: ReadonlyArray<never>; readonly api: BeforeApi<S> }) => unknown;
	readonly map?: (record: never, resolved: never) => MutationInsertFor<S, N>;
};

/** One inbound binding driven by the platform's own scheduler. */
export type CollectionPullBinding<S extends AnySchema, N extends TableName<S>> = CollectionInboundBinding<S, N> & {
	readonly pull: PullRequestSpec;
	readonly webhook?: never;
};

/**
 * One inbound binding driven by the source, which pushes.
 *
 * `identity` is required here for the same reason it is required on a pull, and it matters more:
 * webhook delivery is at-least-once by design — every provider retries on a non-2xx and several
 * retry on a timeout they caused themselves — so a binding without an identity would turn one event
 * into as many rows as the source felt like sending. The identity is read from the decoded record
 * and stamped into the identity column by the platform, never taken from whatever the record claims
 * its primary key is.
 */
export type CollectionWebhookBinding<S extends AnySchema, N extends TableName<S>> = CollectionInboundBinding<S, N> & {
	readonly webhook: WebhookRequestSpec;
	readonly pull?: never;
};

/**
 * One inbound binding: a pull the platform schedules, or a webhook the source pushes.
 *
 * The two are one union rather than two sibling maps because they are the same authoring question —
 * how does this collection learn about the outside world — answered two ways, and because the half
 * that is genuinely shared (`input`, `identity`, `records`, `map`) is the half that took the longest
 * to get right. `pull` and `webhook` are mutually exclusive: a binding is scheduled or it is pushed,
 * and the `never` on each side makes declaring both a compile error rather than a silent precedence
 * rule.
 */
export type CollectionReceiveBinding<S extends AnySchema, N extends TableName<S>> =
	| CollectionPullBinding<S, N>
	| CollectionWebhookBinding<S, N>;

export type CollectionIntegrations<S extends AnySchema, N extends TableName<S>> = Readonly<Record<string, {
	/** Omitted by an integration that only receives pushed deliveries: there is nothing to request. */
	readonly connection?: HttpConnection;
	readonly receive?: Readonly<Record<string, CollectionReceiveBinding<S, N>>>;
	readonly send?: Readonly<Record<string, CollectionSendBinding<S, N>>>;
}>>;

export interface ChannelDefinition {
	readonly transport: string;
	readonly policy: string;
	readonly description: string;
	readonly audience: 'public' | 'authenticated';
	readonly groupMessages?: 'disabled' | 'mention_or_reply' | 'all';
	readonly rateLimits?: { readonly perSenderPerMinute: number; readonly totalPerMinute: number };
	readonly task: string;
}
type PolicyGrant<S extends AnySchema> = {
	readonly [N in TableName<S>]: {
		readonly collection: N;
		readonly action: 'read' | 'create' | 'update' | 'delete' | 'history';
		readonly where?: SchemaWhere<SchemaRow<S, N>>;
		readonly approval?: unknown;
	}
}[TableName<S>];
export interface PolicyDefinition<S extends AnySchema = DefaultWorkspaceSchema> {
	readonly name: string;
	readonly description: string;
	readonly apps?: ReadonlyArray<string>;
	readonly grants: ReadonlyArray<PolicyGrant<S>>;
}
export interface McpServerDefinition { readonly url: string; readonly tools?: ReadonlyArray<string>; }
