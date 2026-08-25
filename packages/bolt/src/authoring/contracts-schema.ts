// repository-health:allow SEM_PARALLEL -- contracts-schema and workspace-schema are the authored
// contract and its workspace declaration; they already link by type-only imports in both directions.
import { Effect, Schema } from 'effect';
import type { SystemRowColumns } from './system-row-model.js';
import type { TExportManifest } from './handlers-schema.js';
import type {
	AnyModelFieldBuilder,
	FileRef,
	ModelDeclaration,
	ReferenceBuilder,
	ReferenceTargets
} from './models-schema.js';
import type { RateLimitKey, RateLimitRule, RateLimitRules } from './rate-limits-schema.js';
import type { ApprovalFlow } from './approval-flow.js';
// Type-only, and therefore erased: `workspace-schema.ts` already imports `EnvoyDefinition` from
// here, so a value import in this direction would be a real cycle.
import type { HttpConnection, PrivateEnvReference } from './workspace-schema.js';
import type { WorkspaceAuthoringTypes, WorkspaceTeamAuthoringTypes } from './authoring-types.js';
/**
 * The generated team union is kept on a separate augmentation graph.
 *
 * `TeamName` is `keyof` the authored `+teams.ts` default export. That module uses `satisfies Teams`,
 * and `Teams` resolves the generated policy union through `WorkspaceAuthoringTypes`. Putting the
 * team augmentation on that same interface makes policy-name resolution traverse back through
 * `TeamName` and the `+teams.ts` default export, producing a circular type. This separate interface
 * keeps both generated unions exact while making the dependency graph one-way.
 */

type ApplyDimensions<Value, Dimensions, Depth extends ReadonlyArray<unknown> = readonly []> = [
	Dimensions
] extends [never]
	? Value
	: Dimensions extends number
		? number extends Dimensions
			? Value
			: Depth['length'] extends Dimensions
				? Value
				: ApplyDimensions<ReadonlyArray<Value>, Dimensions, readonly [...Depth, unknown]>
		: Value;
type BuilderValue<Config extends { readonly data: unknown }> = ApplyDimensions<
	Config extends { readonly $type: infer Custom }
		? [Custom] extends [never]
			? Config['data']
			: Custom
		: Config['data'],
	Config extends { readonly dimensions: infer Dimensions } ? Dimensions : 0
>;
type BuilderData<B> = B extends { readonly _: infer Config extends { readonly data: unknown } }
	? Config extends { readonly notNull: true }
		? BuilderValue<Config>
		: BuilderValue<Config> | null
	: never;
/** The selected platform row, derived from the same builders used to create its table. */
export type SystemRow = {
	readonly [K in keyof SystemRowColumns]: BuilderData<SystemRowColumns[K]>;
};
type SelectForColumns<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = SystemRow & {
	readonly [K in keyof C]: BuilderData<C[K]>;
};
type RequiredInsertKeys<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	[K in keyof C]: C[K] extends { readonly _: { readonly notNull: true } }
		? C[K] extends { readonly _: { readonly hasDefault: true } }
			? never
			: K
		: never;
}[keyof C];
type InsertForColumns<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	readonly [K in RequiredInsertKeys<C>]: BuilderData<C[K]>;
} & {
	readonly [K in Exclude<keyof C, RequiredInsertKeys<C>>]?: BuilderData<C[K]>;
};
type ColumnsOf<M extends ModelDeclaration> = M['columns'];
type ReferencesForColumns<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	readonly [
		K in keyof C as C[K] extends ReferenceBuilder ? K : never
	]: C[K] extends ReferenceBuilder<infer Targets, boolean, boolean> ? Targets : never;
};

export interface TableShape<
	Select,
	Insert = Partial<Select>,
	References = Readonly<Record<never, never>>
> {
	readonly $inferSelect: Select;
	readonly $inferInsert: Insert;
	/** Type-only map used to infer discriminated polymorphic-reference hydration. */
	readonly $references?: References;
}

export type TablesForModels<M extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly [K in keyof M]: TableShape<
		SelectForColumns<ColumnsOf<M[K]>>,
		InsertForColumns<ColumnsOf<M[K]>>,
		ReferencesForColumns<ColumnsOf<M[K]>>
	>;
};

export interface AnySchema {
	readonly tables: Readonly<Record<string, TableShape<object, object, object>>>;
	readonly relations: Readonly<Record<string, unknown>>;
	readonly inputs: Readonly<Record<string, { readonly create: unknown; readonly update: unknown }>>;
}

export type DefaultWorkspaceSchema = WorkspaceAuthoringTypes extends {
	readonly schema: infer S extends AnySchema;
}
	? S
	: AnySchema;

/**
 * One generated union, read off the augmentation the compiler writes.
 *
 * Ten names one declaration uses to reach another use this helper. `sync.ts` generates each union
 * from the filenames it discovered and `workspace-authoring.d.ts` augments
 * `WorkspaceAuthoringTypes`, so a rename fails the build at the reference rather than emptying an
 * authority at run time. `TeamName` uses the separate interface above to keep its self-derived map
 * out of this graph. A workspace that has not been synced has no augmentation and falls back to
 * `string`, which is also what Bolt's own sources see.
 *
 * Written once as a helper rather than ten times as a conditional, because repeated copies are how
 * six of them came to be generated, declared, and read by nobody: `AgentToolName`, `McpServerName`,
 * `AppName`, `RemoteName` and `ChannelName` were all emitted by the compiler and only the
 * policy-name union ever had a resolver here.
 */
type DeclaredName<Field extends string> = WorkspaceAuthoringTypes extends {
	readonly [K in Field]: infer Name extends string;
}
	? Name
	: string;

/**
 * A policy, named the way every other authored thing in a workspace is named: by its file.
 *
 * `PolicyName` is generated from the `src/access/policies/+*.ts` filenames, so this union is
 * `'employee' | 'supervisor' | …` — the file keys, folded nowhere and spelled exactly once.
 *
 * Everything that binds to a policy uses this one type: a team's holdings in `+teams.ts`, an envoy's
 * ceiling, an automation's authority. The policy no longer restates its own name — there is no
 * `name:` field left to disagree with the filename, which is the defect this union was introduced
 * to catch and the file field was the reason it existed at all.
 */
export type PolicyName = DeclaredName<'policyName'>;

/**
 * A team, by the name `src/access/+teams.ts` gives it, and the only thing an approver may be.
 *
 * `approvers: ['HR Manger']` shipped, and produced an approval nobody could ever decide: a bare
 * string compared against `team.name` matches nothing when it is misspelled, and nothing says
 * so. Case-folding closed the casing half and left the typo half open. This closes it: a step names
 * a key of `+teams.ts` or the build fails.
 *
 * The union is derived from the teams module's own keys rather than from a scan of its text, so a
 * team declared behind a spread or a computed key is still in it.
 */
export type TeamName = WorkspaceTeamAuthoringTypes extends {
	readonly teamName: infer Name extends string;
}
	? Name
	: string;

/** An app, by its `src/apps/+<name>.svelte` file. */
export type AppName = DeclaredName<'appName'>;
/** A workspace tool, by its `src/capabilities/tools/+<name>.ts` file. */
type DeclaredToolName = DeclaredName<'toolName'>;
/** An MCP server, by its `src/capabilities/mcp/+<name>.ts` file. */
type McpServerName = DeclaredName<'mcpServerName'>;
/** A skill, by its `src/capabilities/skills/<name>/` directory. */
type DeclaredSkillName = DeclaredName<'skillName'>;

/**
 * The shape of `src/access/+teams.ts`: which policies each named team holds.
 *
 * Keys are team names, matched case-insensitively against `team.name`, and free strings on
 * purpose — a team is a row an operator creates from a dashboard, so no compiled union can enumerate
 * them, and this file is where the enumeration comes from. Values are narrowed to *this* workspace's
 * declared policy names, so renaming or deleting a policy breaks the build here, in the map that
 * hands it to people, instead of quietly emptying somebody's authority at run time.
 *
 * The runtime is deliberately more forgiving than this type: a team naming a policy the release does
 * not declare has that name dropped and warned about, never refused, because a row and a release
 * move independently and a workspace must not fall over on a stale string. This check is what makes
 * that tolerance a safety net rather than the only line of defence.
 */
export type Teams = Readonly<Record<string, ReadonlyArray<PolicyName>>>;
export type TableName<S extends AnySchema> = keyof S['tables'] & string;
export type SchemaRow<S extends AnySchema, N extends TableName<S>> = S['tables'][N]['$inferSelect'];
type SchemaReferences<S extends AnySchema, N extends TableName<S>> = NonNullable<
	S['tables'][N]['$references']
>;
type QueryScalar = string | number | boolean | bigint | Date | null;
type QueryOperand<Value> =
	Exclude<Value, undefined> extends QueryScalar ? Exclude<Value, undefined> | Date : unknown;
type SchemaFieldFilter<Value> = {
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
type ReferenceHandleKind<Value> =
	Exclude<Value, null | undefined> extends {
		readonly kind: infer Kind;
	}
		? Kind
		: never;
type SchemaReferenceFilter<Value> = {
	readonly eq?: Exclude<Value, null | undefined>;
	readonly ne?: Exclude<Value, null | undefined>;
	readonly in?: ReadonlyArray<Exclude<Value, null | undefined>>;
	readonly notIn?: ReadonlyArray<Exclude<Value, null | undefined>>;
	readonly kind?: Readonly<{
		readonly eq?: ReferenceHandleKind<Value>;
		readonly ne?: ReferenceHandleKind<Value>;
	}>;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
};
type SchemaWhere<Row extends object, References extends object = Readonly<Record<never, never>>> = {
	readonly [K in keyof Row]?: K extends keyof References
		? SchemaReferenceFilter<Row[K]>
		: SchemaFieldFilter<Row[K]> | QueryOperand<Row[K]>;
} & {
	readonly AND?: ReadonlyArray<SchemaWhere<Row, References>>;
	readonly OR?: ReadonlyArray<SchemaWhere<Row, References>>;
	readonly NOT?: SchemaWhere<Row, References>;
	readonly $sql?: string;
};
export interface SchemaQueryConfig<S extends AnySchema, N extends TableName<S>> {
	readonly where?: SchemaWhere<SchemaRow<S, N>, SchemaReferences<S, N>>;
	readonly columns?: Partial<Readonly<Record<keyof SchemaRow<S, N>, boolean>>>;
	readonly orderBy?: Partial<
		Readonly<Record<Exclude<keyof SchemaRow<S, N>, keyof SchemaReferences<S, N>>, 'asc' | 'desc'>>
	>;
	readonly with?: Readonly<
		Partial<{
			readonly [K in keyof SchemaReferences<S, N>]: SchemaReferences<
				S,
				N
			>[K] extends ReferenceTargets
				? ReferenceQueryConfig<S, SchemaReferences<S, N>[K]>
				: never;
		}> &
			Record<string, boolean | Readonly<Record<string, unknown>>>
	>;
	readonly limit?: number;
	readonly offset?: number;
}

type ReferenceTargetName<
	S extends AnySchema,
	Targets extends ReferenceTargets,
	Kind extends keyof Targets
> = Extract<Targets[Kind], TableName<S>>;
type ReferenceQueryConfig<S extends AnySchema, Targets extends ReferenceTargets> =
	| true
	| Readonly<{
			readonly [Kind in keyof Targets]?:
				true | SchemaQueryConfig<S, ReferenceTargetName<S, Targets, Kind>>;
	  }>;

type SelectedKeys<Row, Columns> = true extends Columns[keyof Columns]
	? { [K in keyof Columns & keyof Row]: Columns[K] extends false ? never : K }[keyof Columns &
			keyof Row]
	: Exclude<
			keyof Row,
			{ [K in keyof Columns & keyof Row]: Columns[K] extends false ? K : never }[keyof Columns &
				keyof Row]
		>;
type SelectColumns<Row, Config> = Config extends { readonly columns: infer Columns }
	? Pick<Row, SelectedKeys<Row, Columns>>
	: Row;
type ReferenceTargetConfig<Spec, Kind> = Spec extends true
	? undefined
	: Spec extends Readonly<Record<PropertyKey, unknown>>
		? Kind extends keyof Spec
			? Spec[Kind] extends true
				? undefined
				: Spec[Kind]
			: undefined
		: undefined;
type HydratedReference<S extends AnySchema, Targets extends ReferenceTargets, Spec> = {
	readonly [Kind in keyof Targets & string]: Readonly<{
		readonly kind: Kind;
		readonly id: string;
		readonly record: SchemaQueryRow<
			S,
			ReferenceTargetName<S, Targets, Kind>,
			Extract<
				ReferenceTargetConfig<Spec, Kind>,
				SchemaQueryConfig<S, ReferenceTargetName<S, Targets, Kind>> | undefined
			>
		> | null;
	}>;
}[keyof Targets & string];
type WithRows<S extends AnySchema, N extends TableName<S>, Config> = Config extends {
	readonly with: infer W;
}
	? {
			readonly [K in keyof W]: K extends keyof SchemaReferences<S, N>
				? SchemaReferences<S, N>[K] extends ReferenceTargets
					? | HydratedReference<S, SchemaReferences<S, N>[K], W[K]>
						| (null extends SchemaRow<S, N>[K & keyof SchemaRow<S, N>] ? null : never)
					: never
				: | Readonly<Record<string, unknown>>
					| ReadonlyArray<Readonly<Record<string, unknown>>>
					| null;
		}
	: Readonly<Record<never, never>>;
export type SchemaQueryRow<
	S extends AnySchema,
	N extends TableName<S>,
	Config extends SchemaQueryConfig<S, N> | undefined = undefined
> = Omit<SelectColumns<SchemaRow<S, N>, Config>, keyof WithRows<S, N, Config>> &
	WithRows<S, N, Config>;

export type MutationInsertFor<
	S extends AnySchema,
	N extends TableName<S>
> = S['tables'][N]['$inferInsert'];
export type MutationUpdateFor<S extends AnySchema, N extends TableName<S>> = Partial<
	S['tables'][N]['$inferSelect']
>;
export type InputValuesForTables<T extends Readonly<Record<string, TableShape<unknown, unknown>>>> =
	{
		readonly [K in keyof T]: {
			readonly create: T[K]['$inferInsert'];
			readonly update: Partial<T[K]['$inferSelect']>;
		};
	};

/**
 * One nearest-neighbour read, answered by pgvector against the declared HNSW index.
 *
 * Every field here was ignored for a long time: both implementations spread this config into an
 * ordinary `findMany`, which knows no `column`, `probe` or `metric` — so the query returned the
 * collection's first rows in insertion order with no `distance` on them at all, and a caller doing
 * duplicate detection found every record a near-duplicate of every other.
 *
 * `metric` picks the pgvector operator: `cosine` is `<=>`, `l2` is `<->`, and `ip` is `<#>` — the
 * *negative* inner product, which is what makes ascending order mean "most similar" for all three,
 * so an `ip` `maxDistance` is compared against a negative number.
 */
interface NearestQueryConfig<Row> {
	readonly column: keyof Row & string;
	readonly probe: ReadonlyArray<number>;
	readonly metric: 'cosine' | 'l2' | 'ip';
	readonly maxDistance?: number;
	readonly limit: number;
	readonly excludeIds?: ReadonlyArray<string>;
}

interface CollectionQuery<S extends AnySchema, N extends TableName<S>> {
	findMany(): Effect.Effect<Array<SchemaRow<S, N> & Readonly<Record<string, unknown>>>>;
	findMany<const Config extends SchemaQueryConfig<S, N>>(
		config: Config
	): Effect.Effect<Array<SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>>>;
	findFirst(): Effect.Effect<(SchemaRow<S, N> & Readonly<Record<string, unknown>>) | undefined>;
	findFirst<const Config extends SchemaQueryConfig<S, N>>(
		config: Config
	): Effect.Effect<(SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>) | undefined>;
	readonly count: (config?: Pick<SchemaQueryConfig<S, N>, 'where'>) => Effect.Effect<number>;
	readonly findNearest: (
		config: NearestQueryConfig<SchemaRow<S, N>>
	) => Effect.Effect<Array<SchemaRow<S, N> & { readonly distance: number }>>;
}
interface ApprovalRequestRow extends SystemRow {
	readonly collection_name: string;
	readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
	readonly closed_at: Date | null;
	readonly locked_record_refs: unknown;
}
interface ApprovalRequestQuery {
	readonly findMany: <
		const Config extends {
			readonly where?: SchemaWhere<ApprovalRequestRow>;
			readonly columns?: Partial<Readonly<Record<keyof ApprovalRequestRow, boolean>>>;
			readonly orderBy?: Partial<Readonly<Record<keyof ApprovalRequestRow, 'asc' | 'desc'>>>;
			readonly limit?: number;
		}
	>(
		config?: Config
	) => Effect.Effect<Array<ApprovalRequestRow>>;
	readonly findFirst: <
		const Config extends {
			readonly where?: SchemaWhere<ApprovalRequestRow>;
			readonly limit?: number;
		}
	>(
		config?: Config
	) => Effect.Effect<ApprovalRequestRow | undefined>;
}
/**
 * One schema-validated model call from an authored handler.
 *
 * `profile` and `collections` used to be declared here too — a named inference profile and a set of
 * collections to offer the turn as tools. Neither was ever built: the runtime read `schema`,
 * `prompt` and `model` and nothing else, so a handler naming collections got a turn with no tools
 * and no indication that it had. They are gone rather than stubbed, because a declared capability
 * that silently does nothing is the defect, not the absence of one.
 *
 * `images` is real. Each entry carries a `file()` column's value straight through — that value is
 * the whole description of the file, so pass `record.photo`, not an id off it — and the runtime
 * reads the object it names, inlines the bytes on the turn, and refuses a non-image, more than
 * eight of them, or more than 20 MiB in total rather than dropping any silently.
 *
 * `webSearch` is provider-neutral on purpose. An author can bound result count and sources without
 * naming the host's gateway or its server-tool dialect; the host adapter owns that translation.
 */
interface StructuredInferenceInput<Output> {
	readonly schema: Schema.Schema<Output>;
	readonly prompt: string;
	readonly model?: string;
	readonly webSearch?: Readonly<{
		/** Maximum results returned by each search call. */
		readonly maxResults: number;
		/** Optional allow-list of domains the provider may search. */
		readonly allowedDomains?: ReadonlyArray<string>;
	}>;
	readonly images?: ReadonlyArray<{
		readonly file: FileRef;
		readonly detail?: 'auto' | 'low' | 'high';
	}>;
}

export type BeforeApi<S extends AnySchema = DefaultWorkspaceSchema> = {
	readonly db: {
		readonly query: { readonly [N in TableName<S>]: CollectionQuery<S, N> } & {
			readonly approval_request: ApprovalRequestQuery;
		};
	} & {
		readonly [N in TableName<S>]: CollectionQuery<S, N> & {
			readonly create: (input: MutationInsertFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
			readonly update: (
				id: string,
				input: MutationUpdateFor<S, N>
			) => Effect.Effect<SchemaRow<S, N>>;
		};
	};
	/**
	 * Manually run a declared automation from code, in the background, with retry.
	 *
	 * Every automation has this manual entry point. `defineAutomation({ schedule })` additionally
	 * starts it on a clock, `defineAutomation({ trigger })` additionally starts it when a record
	 * changes, and `defineAutomation({})` has no automatic start. This is the entry point an author
	 * previously had no way to say, and the alternatives were both bad: a hook must either fail the
	 * user's write or swallow the error, and a change trigger is lost if it throws.
	 *
	 * There is deliberately no `api.tasks`. A task is not a thing an author has — it is how the
	 * runtime carries out something the workspace already declared — and a second way to start
	 * background work would compete with the automations that declaration produces. Two ways to say
	 * one thing is one too many.
	 *
	 * `after` takes any duration this codebase takes: `'1 hour'`, `'30 seconds'`, or milliseconds.
	 * Omitted, the automation runs as soon as the queue can take it.
	 */
	readonly automations: {
		readonly run: (
			name: string,
			input?: Schema.Json,
			options?: { readonly after?: string | number }
		) => Effect.Effect<{ readonly taskId: string }>;
	};
	readonly infer: <Output>(input: StructuredInferenceInput<Output>) => Effect.Effect<Output>;
	readonly readFileAsset: (file: FileRef) => Effect.Effect<{
		readonly id: string;
		readonly name: string;
		readonly mimeType: string | null;
		readonly size: number;
		readonly bytes: Uint8Array;
	}>;
};
export type HookApi<S extends AnySchema = DefaultWorkspaceSchema> = BeforeApi<S>;
type ElevatedMutationPayload<S extends AnySchema, N extends TableName<S>> =
	MutationInsertFor<S, N> | ({ readonly id: string } & MutationUpdateFor<S, N>);
/**
 * How a batched write wants to be cut up.
 *
 * `batchSize` is an atomicity frontier and a progress boundary: each batch is one transaction, so a
 * failure loses at most one batch and never a row that a later batch would have written. Absent, the
 * whole call is one transaction — which is the right default and the reason there is a ceiling on it
 * rather than a silent split.
 *
 * There is deliberately no concurrency knob. There is one thread in the isolate, so a number there
 * would only ever describe how many facility calls may be outstanding at once, which is the
 * runtime's business and not a decision an author has the information to make.
 */
type MutateOptions = { readonly batchSize?: number };
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
export type AfterHookApi<S extends AnySchema = DefaultWorkspaceSchema> = Omit<
	BeforeApi<S>,
	'db'
> & {
	readonly db: { readonly query: BeforeApi<S>['db']['query'] } & {
		readonly [N in TableName<S>]: CollectionQuery<S, N> & {
			readonly create: (input: MutationInsertFor<S, N>) => Effect.Effect<SchemaRow<S, N>>;
			readonly update: (
				id: string,
				input: MutationUpdateFor<S, N>
			) => Effect.Effect<SchemaRow<S, N>>;
			readonly mutate: (
				payloads: ReadonlyArray<ElevatedMutationPayload<S, N>>,
				options?: MutateOptions
			) => Effect.Effect<Array<SchemaRow<S, N> & Readonly<Record<string, unknown>>>>;
			readonly delete: (identifiers: ReadonlyArray<string>) => Effect.Effect<void>;
		};
	};
};

/**
 * A hook, and the only shape a hook has.
 *
 * There used to be a second one beside it — `batchHandler`, taking every row of a batch at once —
 * declared here, re-typed in `runtime/collections/authored.ts`, and called from nowhere in the
 * runtime. An author could write batch validation there, ship it, and have it silently never run.
 *
 * It is gone rather than wired, because a hook is authored for one record and that is the claim the
 * write surface makes. Its two real uses live elsewhere now: a read that all N rows need is served
 * by one query without the hook knowing a batch exists, and "these N rows contain a duplicate" is a
 * unique index — which is stricter, because it also catches a collision with a row already stored.
 */
type DescribedHook<Handler> = { readonly description: string; readonly handler: Handler };
type CreateInput<S extends AnySchema, N extends TableName<S>> = MutationInsertFor<S, N>;

/** The relations `+relationship.ts` declared for one collection, as the compiler emits them. */
type RelationsOf<S extends AnySchema, N extends TableName<S>> = S extends {
	readonly relations: infer R;
}
	? N extends keyof R
		? R[N]
		: Readonly<Record<never, never>>
	: Readonly<Record<never, never>>;

/**
 * The relations a nested write may expand: `many`, and with a foreign key to fill.
 *
 * A `one` relation is the child pointing at a parent that must already exist, so writing it inline
 * would mean inventing the parent. A `many` with no declared endpoint carries `never` as its column
 * and is excluded here rather than guessed at — an edge the author declared loosely is one a nested
 * write refuses, not one it improvises a foreign key for.
 */
type ChildRelation<S extends AnySchema, N extends TableName<S>> = {
	[K in keyof RelationsOf<S, N>]: RelationsOf<S, N>[K] extends {
		readonly cardinality: 'many';
		readonly column: string;
	}
		? K
		: never;
}[keyof RelationsOf<S, N>];

type ChildTable<
	S extends AnySchema,
	N extends TableName<S>,
	K extends ChildRelation<S, N>
> = RelationsOf<S, N>[K] extends { readonly target: infer T }
	? T extends TableName<S>
		? T
		: never
	: never;

type ChildColumn<
	S extends AnySchema,
	N extends TableName<S>,
	K extends ChildRelation<S, N>
> = RelationsOf<S, N>[K] extends { readonly column: infer C } ? C : never;

/**
 * How deep a nested write may go, as a countdown.
 *
 * Not decoration. `relations` is a graph with cycles in it — `payroll_runs → payslips →
 * payroll_runs` — and a naively recursive type over it never terminates. This also gives the
 * runtime's own graph bound a compile-time twin, so the two agree by construction rather than by
 * comment.
 */
type Depth = 0 | 1 | 2 | 3 | 4 | 5;
type Prev = [never, 0, 1, 2, 3, 4];

/**
 * A record and, optionally, the records that belong to it.
 *
 * Every child key is optional, which is what makes depth the author's choice: returning columns
 * alone is valid, one level is valid, three is valid, and each level is checked against the
 * collection it names. The child's foreign key is `Omit`ted rather than made optional — the runtime
 * fills it from the parent's assigned id, so writing it is not a redundant statement of the truth,
 * it is a claim that could disagree with one.
 */
type ChildrenOf<S extends AnySchema, N extends TableName<S>, D extends Depth> = {
	readonly [K in ChildRelation<S, N>]?: ReadonlyArray<
		CreateGraph<S, ChildTable<S, N, K>, Prev[D]> extends infer G
			? Omit<G, ChildColumn<S, N, K> & keyof G>
			: never
	>;
};

export type CreateGraph<S extends AnySchema, N extends TableName<S>, D extends Depth = 5> = [
	D
] extends [never]
	? MutationInsertFor<S, N>
	: MutationInsertFor<S, N> & ChildrenOf<S, N, D>;

/**
 * What a `create.before` may return: this record, and optionally the records that belong to it.
 *
 * It used to return `MutationInsertFor<S, N> | (MutationInsertFor<S, N> & Record<string, unknown>)`,
 * and that second arm is why any key at all was legal — the seam for a nested return already
 * existed, typed as "anything goes" and backed by nothing.
 *
 * **Where the check lands.** A handler that returns an object literal directly is checked for excess
 * properties, so a misspelled relation name is a compile error there. A handler that builds its
 * result in a variable — which the payroll engine must, since it computes for a second and a half
 * before it has one — gets no such check from TypeScript, in any formulation: making the return type
 * generic in what was returned cannot work, because the type parameter appears only in return
 * position and there is nothing to infer it from. So the second half of this guarantee is the
 * runtime's: FLATTEN refuses a key that is neither a column of the collection nor one of its
 * declared relations, rather than dropping it on the way to the database. Between them nothing is
 * silently lost, which is the property that actually matters.
 */
type CreateBefore<S extends AnySchema, N extends TableName<S>, Prepared> = (context: {
	readonly input: CreateInput<S, N>;
	/**
	 * What this batch's `load` returned, or `undefined` if the collection declares none.
	 *
	 * Its type is `load`'s return type, so the two cannot drift apart: a `load` that stops returning
	 * what `handler` reads is a compile error at the `satisfies`, not a runtime surprise on a
	 * four-thousand-row import.
	 */
	readonly prepared: Prepared;
	readonly api: HookApi<S>;
}) => Effect.Effect<CreateGraph<S, N>, unknown, never> | CreateGraph<S, N>;
type CreateAfter<S extends AnySchema, N extends TableName<S>> = (context: {
	readonly record: SchemaRow<S, N>;
	readonly api: AfterHookApi<S>;
}) => Effect.Effect<void, unknown, never> | void;
type UpdateAfterContext<S extends AnySchema, N extends TableName<S>> = Readonly<{
	/** The stored row immediately before this update. */
	readonly previous: SchemaRow<S, N>;
	/** The prepared patch that was committed, including values derived by `update.before`. */
	readonly changes: MutationUpdateFor<S, N>;
	/** The exact row committed by this update. */
	readonly record: SchemaRow<S, N>;
	readonly api: AfterHookApi<S>;
}>;
type UpdateAfter<S extends AnySchema, N extends TableName<S>> = (
	context: UpdateAfterContext<S, N>
) => Effect.Effect<void, unknown, never> | void;

/**
 * The reads a whole batch needs, done once.
 *
 * A hook is authored for one record, and a hook that *reads* per record is an N+1 by construction:
 * `time_entries` asks two questions per row, so a four-thousand-row import asks eight thousand
 * times. The rule and the reads are separable, and only the reads want to be batched.
 *
 * This is deliberately **not** a second place to write the rule. `batchHandler` was that, and the
 * drift it invites is not hypothetical — one collection had the same assertion written into both of
 * its hooks and five carried batch validation the runtime never called. `load` is not an alternative
 * branch: it runs before `handler`, every time, for a batch of four thousand and for a single
 * `create` alike. Nothing has to decide which one applies.
 *
 * What it is *for* is the query a person would write and a resolver cannot derive: four thousand
 * questions of the form "is this employment's day covered by leave" become one query over the window
 * the batch spans. Merging identical queries with different keys is something the runtime can do on
 * its own; reformulating them into a different query is judgement about the domain.
 *
 * Scoped to the batch, not the call: with `batchSize: 250` over 4 000 rows it runs sixteen times,
 * each seeing its own 250. A batch is the unit of atomicity and of the isolate's span, so it is the
 * unit a read belongs to as well.
 */
type CreatePrepare<S extends AnySchema, N extends TableName<S>, Prepared> = (context: {
	readonly inputs: ReadonlyArray<CreateInput<S, N>>;
	readonly api: HookApi<S>;
}) => Effect.Effect<Prepared, unknown, never> | Prepared;

/**
 * Everything a collection may say about a write, arranged by how often it runs.
 *
 * ```
 * create: {
 *   input,                 // the shape a caller may send
 *   prepare,               // ONCE for the batch  ─┐
 *   perRecord: {           //                      │  what prepare returns
 *     before,              // ONCE per record  ◄───┤  arrives here as `prepared`
 *     after                // ONCE per settled record, with the stored `record`
 *   }
 * }
 * ```
 *
 * The nesting is the documentation. An earlier shape put a batch-wide function beside a per-record
 * one at the same level — `batchHandler` next to `handler` — and nothing about the declaration said
 * which ran when, or that one was a rule and the other was a second copy of it. Five collections
 * shipped batch validation that the runtime never called, and one had the same assertion written
 * into both halves.
 *
 * `prepare` is not a place to put rules. It returns data and nothing else decides anything there.
 * `perRecord` is where every decision lives, once, for one record — whether the write was one row or
 * four thousand.
 */
export type CollectionHooks<S extends AnySchema, N extends TableName<S>, Prepared = void> = {
	readonly create?: {
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly prepare?: CreatePrepare<S, N, Prepared>;
		readonly perRecord?: {
			readonly before?: DescribedHook<CreateBefore<S, N, Prepared>>;
			/** Runs only after the create is settled; an approval hold defers it until approval. */
			readonly after?: DescribedHook<CreateAfter<S, N>>;
		};
	};
	readonly update?: {
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly perRecord?: {
			readonly before?: DescribedHook<
				(context: {
					readonly input: MutationUpdateFor<S, N>;
					readonly existing: SchemaRow<S, N>;
					readonly api: HookApi<S>;
				}) => Effect.Effect<MutationUpdateFor<S, N>, unknown, never> | MutationUpdateFor<S, N>
			>;
			/** Runs only after the update is settled; an approval hold defers it until approval. */
			readonly after?: DescribedHook<UpdateAfter<S, N>>;
		};
	};
	readonly delete?: {
		readonly perRecord?: {
			readonly before?: DescribedHook<
				(context: {
					readonly existing: SchemaRow<S, N>;
					readonly api: HookApi<S>;
				}) => Effect.Effect<void, unknown, never> | void
			>;
			readonly after?: DescribedHook<
				(context: {
					readonly record: SchemaRow<S, N>;
					readonly api: AfterHookApi<S>;
				}) => Effect.Effect<void, unknown, never> | void
			>;
		};
	};
};

export type CollectionPipelines<S extends AnySchema, N extends TableName<S>> = {
	readonly export?: {
		readonly description: string;
		readonly handler: (
			context: { readonly records: ReadonlyArray<SchemaRow<S, N>> },
			api: BeforeApi<S>
		) => Effect.Effect<TExportManifest, unknown, never> | TExportManifest;
	};
	readonly import?: {
		readonly description: string;
		readonly input: Schema.Codec<unknown, unknown>;
		readonly handler: (
			context: { readonly input: unknown },
			api: BeforeApi<S>
		) =>
			| Effect.Effect<ReadonlyArray<MutationInsertFor<S, N>>, unknown, never>
			| ReadonlyArray<MutationInsertFor<S, N>>;
	};
};
type CollectionEventTrigger<S extends AnySchema, N extends TableName<S>> =
	| 'create'
	| 'update'
	| 'delete'
	| {
			readonly create?: (context: { readonly record: SchemaRow<S, N> }) => boolean;
			readonly update?: (context: {
				readonly previous: SchemaRow<S, N>;
				readonly record: SchemaRow<S, N>;
			}) => boolean;
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
	| {
			readonly style: 'page';
			readonly pageQuery: string;
			readonly sizeQuery?: string;
			readonly size?: number;
			readonly firstPage?: number;
			readonly max?: number;
	  }
	| {
			readonly style: 'offset';
			readonly offsetQuery: string;
			readonly limitQuery: string;
			readonly size: number;
			readonly max?: number;
	  }
	| {
			readonly style: 'cursor';
			readonly query: string;
			readonly next:
				| { readonly header: string }
				| { readonly field: string }
				| { readonly path: ReadonlyArray<string> };
			readonly max?: number;
	  }
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
type PullIdentitySpec = {
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
	readonly resolve?: (context: {
		readonly records: ReadonlyArray<never>;
		readonly api: BeforeApi<S>;
	}) => unknown;
	readonly map?: (record: never, resolved: never) => MutationInsertFor<S, N>;
};

/** One inbound binding driven by the platform's own scheduler. */
type CollectionPullBinding<S extends AnySchema, N extends TableName<S>> = CollectionInboundBinding<
	S,
	N
> & {
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
type CollectionWebhookBinding<
	S extends AnySchema,
	N extends TableName<S>
> = CollectionInboundBinding<S, N> & {
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
type CollectionReceiveBinding<S extends AnySchema, N extends TableName<S>> =
	CollectionPullBinding<S, N> | CollectionWebhookBinding<S, N>;

export type CollectionIntegrations<S extends AnySchema, N extends TableName<S>> = Readonly<
	Record<
		string,
		{
			/** The complete authority this static integration principal holds. Empty means no data access. */
			readonly policies: ReadonlyArray<PolicyName>;
			/** Omitted by an integration that only receives pushed deliveries: there is nothing to request. */
			readonly connection?: HttpConnection;
			readonly receive?: Readonly<Record<string, CollectionReceiveBinding<S, N>>>;
			readonly send?: Readonly<Record<string, CollectionSendBinding<S, N>>>;
		}
	>
>;

/**
 * The exact prepared JavaScript value a write rule decides against.
 *
 * A create has not acquired database defaults yet, so its record is the prepared insert plus the
 * runtime-assigned id. An update has a complete stored row on both sides and exposes only the
 * prepared patch as `changes`. A delete sees the complete stored row it is about to remove.
 */
export type PolicyWriteContext<
	StoredRecord,
	Action extends 'create' | 'update' | 'delete',
	CreateRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = Action extends 'update'
	? Readonly<{
			readonly previous: Readonly<StoredRecord>;
			readonly changes: Readonly<Changes>;
			readonly record: Readonly<StoredRecord>;
		}>
	: Action extends 'create'
		? Readonly<{ readonly record: Readonly<CreateRecord> }>
		: Readonly<{ readonly record: Readonly<StoredRecord> }>;

type PolicyWriteDecision<
	S extends AnySchema,
	StoredRecord,
	Action extends 'create' | 'update' | 'delete',
	CreateRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = (
	context: PolicyWriteContext<StoredRecord, Action, CreateRecord, Changes>,
	api: PolicyDecisionApi<S>
) => boolean | Effect.Effect<boolean>;

/**
 * One function chooses one concrete approval flow.
 *
 * The author uses ordinary TypeScript or Effect control flow and returns `approveBy(...).thenBy(...)`
 * or `noApproval`. `superceded_by` names additional teams allowed to finish every remaining step;
 * administrators always hold that capability and are deliberately implicit here.
 */
type PolicyApproval<
	S extends AnySchema,
	StoredRecord,
	Action extends 'create' | 'update' | 'delete',
	CreateRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = {
	readonly flow: (
		context: PolicyWriteContext<StoredRecord, Action, CreateRecord, Changes>,
		api: PolicyDecisionApi<S>
	) => ApprovalFlow | Effect.Effect<ApprovalFlow>;
	readonly superceded_by: ReadonlyArray<TeamName>;
};

/**
 * What write authorization and approval-flow functions may reach: reads, and nothing else.
 *
 * Deciding whether a write may proceed or who must sign it must not itself write. The read surface
 * is the same `db.query` a hook gets, without the mutation half of that hook API.
 */
export type PolicyDecisionApi<S extends AnySchema = DefaultWorkspaceSchema> = Readonly<{
	readonly db: Readonly<{ readonly query: BeforeApi<S>['db']['query'] }>;
	readonly requestor: Readonly<{
		readonly id: string;
		readonly userId: string;
		readonly tenantId: string;
		readonly email?: string;
		readonly team?: TeamName;
		readonly teamPath: ReadonlyArray<TeamName>;
		readonly admin: boolean;
	}>;
}>;

/**
 * An envoy: an agent that is not the web agent, with its own identity and one transport.
 *
 * Each field answers a question no policy can be asked. Everything a policy *can* answer
 * is deliberately absent — `tools`, `mcp`, `skills`, `collections`, `access`, `rateLimits`, `model`,
 * `maxTokens`, `description` and `prompt` were all on the shape this replaces, and every one of them
 * was a second place to say something the model already says once. A field that can be said twice is
 * a field that can disagree with itself, and on a public surface the disagreement is a security bug.
 *
 * There is no `agent` back-pointer either. An envoy *is* the agent.
 */
export interface EnvoyDefinition {
	/** How it is reached: `telegram`, `whatsapp`. Not what it may do. */
	readonly transport: string;
	/**
	 * Who may reach it. `public` is anyone who can message the transport; `authenticated` is a member
	 * who has proved the address is theirs.
	 *
	 * It is reach and not conversation shape, which `groupMessages` answers more precisely.
	 */
	readonly audience: 'public' | 'authenticated';
	/**
	 * Everything this envoy MAY DO — tools, MCP servers, skills, apps, grants and rate limits alike.
	 *
	 * Choosing these *is* choosing what the public may do, which is why "what can a stranger do to my
	 * database?" has a written answer: read the policies named here. That is the whole attack surface.
	 *
	 * An array, and safe as one only because the compiler refuses a holder that names an
	 * unconditional grant beside a narrowed one on the same collection — `rowPredicate` unions the
	 * `where` of every matching grant, so that combination collapses the predicate to `true`.
	 */
	readonly policies: ReadonlyArray<PolicyName>;
	/** The standing instruction for this envoy's turns, on top of the workspace's `+agents.md`. */
	readonly task: string;
	readonly groupMessages?: 'disabled' | 'mention_or_reply' | 'all';
	/**
	 * Whether this envoy may create and coordinate delegated sandbox-agent sessions.
	 *
	 * Delegation is enabled when omitted for compatibility. Disable it for narrow ingress envoys that
	 * must act alone, even though the same principal-scoped sandbox tools remain available elsewhere.
	 */
	readonly delegation?: 'enabled' | 'disabled';
}
/**
 * The only columns a grant exposes or accepts for its action.
 *
 * System row columns such as `id` are part of `SchemaRow`, so the mask is checked against the same
 * complete row the runtime filters. Omitting it leaves the grant unrestricted by field.
 */
type PolicyGrantFields<S extends AnySchema, N extends TableName<S>> = ReadonlyArray<
	keyof SchemaRow<S, N> & string
>;

/**
 * Reading is a filter, and that is the whole of it.
 *
 * `where` selects which rows are visible and nothing else happens to them, so a read grant has no
 * approval to carry: nobody signs off on somebody having looked. It used to be one shape for all
 * five actions, which made `approval` on a `read` typecheck and then do nothing at all — a grant
 * that reads as a control and enforces none. It is a compile error now.
 *
 * `history` sits here for the same reason: reading what a record used to be is still reading.
 */
type PolicyReadGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly where?: SchemaWhere<SchemaRow<S, N>>;
	readonly fields?: PolicyGrantFields<S, N>;
};

/**
 * A create is authorized against its prepared candidate.
 *
 * The action key itself is the opt-in; an empty object means every prepared candidate, while an
 * absent `create` key means no create authority. `authorize` is server-only Effect code and
 * `approval` resolves one concrete review path after authorization succeeds.
 */
type PolicyCreateGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly fields?: PolicyGrantFields<S, N>;
	readonly authorize?: PolicyWriteDecision<
		S,
		SchemaRow<S, N>,
		'create',
		{ readonly id: string } & MutationInsertFor<S, N>
	>;
	readonly approval?: PolicyApproval<
		S,
		SchemaRow<S, N>,
		'create',
		{ readonly id: string } & MutationInsertFor<S, N>
	>;
};

type PolicyUpdateGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly fields?: PolicyGrantFields<S, N>;
	readonly authorize?: PolicyWriteDecision<
		S,
		SchemaRow<S, N>,
		'update',
		SchemaRow<S, N>,
		MutationUpdateFor<S, N>
	>;
	readonly approval?: PolicyApproval<
		S,
		SchemaRow<S, N>,
		'update',
		SchemaRow<S, N>,
		MutationUpdateFor<S, N>
	>;
};

type PolicyDeleteGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly authorize?: PolicyWriteDecision<S, SchemaRow<S, N>, 'delete'>;
	readonly approval?: PolicyApproval<S, SchemaRow<S, N>, 'delete'>;
};

type PolicyCollectionGrants<S extends AnySchema, N extends TableName<S>> = Readonly<{
	readonly read?: PolicyReadGrant<S, N>;
	readonly history?: PolicyReadGrant<S, N>;
	readonly create?: PolicyCreateGrant<S, N>;
	readonly update?: PolicyUpdateGrant<S, N>;
	readonly delete?: PolicyDeleteGrant<S, N>;
}>;

/**
 * One slot per collection/action coordinate.
 *
 * The old array could state the same coordinate twice and `rowPredicate` would union it, so an
 * unrestricted sibling silently erased a narrowed one. An object has one key for that coordinate;
 * absence is denial, presence is the whole rule, and there is no merge order to misunderstand.
 */
type PolicyGrants<S extends AnySchema> = Readonly<
	Partial<{
		readonly [N in TableName<S>]: PolicyCollectionGrants<S, N>;
	}>
>;

/**
 * What a policy grants beyond data: the tools, servers, skills and apps its holders may reach.
 *
 * It lives on the policy and nowhere else, because tool access *is* authority. Different classes of
 * person hold different policies and some may author code while others may not — that is a
 * capability question, and capability questions have exactly one home. Filing these under an agent
 * would teach a new author the opposite of the model on their first day, and would not survive the
 * fact that a sales rep and a controller reach different tools through the same web agent.
 *
 * Every list is a generated union, so a renamed tool or a deleted skill fails the build here.
 */
export interface PolicyCapabilities {
	readonly apps?: ReadonlyArray<AppName>;
	readonly tools?: ReadonlyArray<DeclaredToolName>;
	readonly mcp?: ReadonlyArray<McpServerName>;
	readonly skills?: ReadonlyArray<DeclaredSkillName>;
	/** Allows an envoy to reach other sessions owned by the same declaration through history search. */
	readonly envoyHistory?: 'this_envoy';
}

/**
 * How much a policy's holders may do, keyed by what shares a bucket with what.
 *
 * `subject` bounds a person or an envoy as a whole; `sender` bounds each outside sender; `tenant`
 * bounds the workspace surface. `address` is excluded because it exists only before sign-in.
 * Omitted keys resolve to `subject`, and multiple differently keyed rules on one command all apply.
 */
type PolicyLimits = Readonly<
	Record<string, RateLimitRules<RateLimitRule<Exclude<RateLimitKey, 'address'>, true>>>
>;

/**
 * A policy: the complete statement of what its holder may do.
 *
 * Four keys, and every one answers a question about *this policy's holders* — whether that holder is
 * a person through a team, an envoy, or an automation. `grants` is what they may touch,
 * `capabilities` is what they may call, `limits` is how much, and the approval on a grant is who has
 * to agree first. Nothing else in the system grants capability.
 *
 * There is no `name`. The filename is the name, exactly as it is for a collection, an app and an
 * envoy, and a restated `name:` is precisely what let five workspaces ship a display-cased string
 * that compiled and matched nothing. There is no field left to disagree with the file.
 */
export interface PolicyDefinition<S extends AnySchema = DefaultWorkspaceSchema> {
	readonly description: string;
	readonly grants: PolicyGrants<S>;
	readonly capabilities?: PolicyCapabilities;
	readonly limits?: PolicyLimits;
}
