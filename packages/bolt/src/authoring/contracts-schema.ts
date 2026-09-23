// repository-health:allow SEM_PARALLEL -- contracts-schema and workspace-schema are the authored
// contract and its workspace declaration; they already link by type-only imports in both directions.
import { Effect, Schema } from 'effect';
import type { SystemRowColumns } from './system-row-model.js';
import type { SYSTEM_COLLECTION_MODELS } from './system-models.js';
import type {
	AnyModelFieldBuilder,
	FileRef,
	ModelDeclaration,
	ReferenceBuilder,
	ReferenceTargets
} from './models-schema.js';
import type { RateLimitKey, RateLimitRule, RateLimitRules } from './rate-limits-schema.js';
import type { WorkspaceAuthoringTypes, WorkspaceTeamAuthoringTypes } from './authoring-types.js';
import type { AuthoredRefusal } from './refusal.js';
import type { CollectionInputOf, CollectionOperationDeclaration } from './collection-schema.js';
import type { CollectionSearch } from '@norbital-ai/std/collection';
import type { ConversationChannel } from './channels-schema.js';

/** An environment binding a connection or webhook secret names, validated by `http.source`. */
export interface PrivateEnvReference {
	readonly env: string;
}
export interface HttpConnection {
	/**
	 * The API root, or the environment variable holding it. A variable is how one workspace source
	 * reaches a different system per deployment — the development ERP locally, production's in
	 * production — the way an ERP's communication arrangement names its host per system.
	 */
	readonly baseUrl: string | PrivateEnvReference;
	readonly authentication?:
		| { readonly type: 'bearer'; readonly token: PrivateEnvReference }
		| { readonly type: 'header'; readonly header: string; readonly value: PrivateEnvReference }
		/**
		 * The credential as a query parameter, for the APIs that read nothing else — a Google Apps
		 * Script web app cannot see request headers at all. Prefer a header wherever one is read: a URL
		 * is logged by more things than a header is.
		 */
		| { readonly type: 'query'; readonly name: string; readonly value: PrivateEnvReference };
}

/** The brand an approval flow carries; present only on flows this contract minted. */
export const ApprovalFlowBrand: unique symbol = Symbol('@norbital-ai/bolt/ApprovalFlow');

export type ApprovalStage = Readonly<{
	readonly approvers: readonly [TeamName, ...TeamName[]];
}>;

export type ApprovalFlow = ApprovalReviewFlow | NoApprovalFlow;

export type ApprovalReviewFlow = Readonly<{
	readonly _tag: 'Review';
	readonly stages: ReadonlyArray<ApprovalStage>;
	readonly thenBy: (first: TeamName, ...others: ReadonlyArray<TeamName>) => ApprovalReviewFlow;
	readonly [ApprovalFlowBrand]: true;
}>;

export type NoApprovalFlow = Readonly<{
	readonly _tag: 'NoApproval';
	readonly [ApprovalFlowBrand]: true;
}>;

/**
 * One file an export action hands out.
 *
 * `name` is the whole contract for what lands on disk, extension included: the client writes the
 * attachment under exactly this name and never appends one of its own, which is what lets a
 * workspace emit `payroll.txt`, `payroll.psv` or a bank's own fixed-width `.txt`. `contentType` is a
 * media label, not a format registry — `CSV`, `PDF`, `XLSX`, `JSON`, `TEXT` and `HTML` are the ones
 * whose blob type the client knows, and anything else it writes as `application/octet-stream` while
 * `name` still decides the extension. It is an open string because a bank's file is the bank's name
 * for it, not the platform's.
 */
interface TFileAttachment {
	name: string;
	contentType: string;
	content: unknown;
}
interface TExportAction {
	label: string;
	attachments: Array<TFileAttachment>;
	metadata?: Record<string, unknown>;
}
export type TExportManifest = Array<TExportAction>;
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
export type BuilderData<B> = B extends {
	readonly _: infer Config extends { readonly data: unknown };
}
	? Config extends { readonly notNull: true }
		? BuilderValue<Config>
		: BuilderValue<Config> | null
	: never;
/** The selected platform row, derived from the same builders used to create its table. */
export type SystemRow = {
	readonly [K in keyof SystemRowColumns]: BuilderData<SystemRowColumns[K]>;
};
/**
 * The platform's record embedding, offered to every row shape and optional on all of them.
 *
 * Not part of `SystemRow`: that type is derived from `defineSystemRowModel`, and adding it there
 * would give every table the physical column, when only a collection that declares
 * `embedding` gets one. Optional rather than required because it is absent in exactly two ordinary
 * situations — a collection that declares no embedding, and a row whose vector has not been written
 * yet — so authored code has to narrow before using it, which is the truth about the value.
 */
type RecordEmbeddingRow = {
	readonly record_embedding?: readonly number[] | null;
	/** When the current record embedding was last written by settle. */
	readonly embedded_at?: string | null;
	/** Fingerprint of the authored source values represented by `record_embedding`. */
	readonly record_embedding_fingerprint?: string | null;
};

type SelectForColumns<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = SystemRow &
	RecordEmbeddingRow & {
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
/**
 * The columns a live prefix may order by, read off the builders the way `scalarOf` reads the
 * executed column: a json/jsonb column (which is what `custom()`, `file()` and `geolocation()`
 * build) and a vector are `json` and cannot key a prefix; a dimensioned column is the scalar
 * `string` every array has always been there. `model-introspection.ts` and this type must keep
 * answering alike, or the compiler admits an ordering the guest refuses at `sync.connect`.
 */
type NonScalarDataType = 'object json' | 'array vector';
type ScalarColumnNames<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	[K in keyof C]: C[K] extends { readonly _: infer Config }
		? Config extends { readonly dimensions: 1 | 2 | 3 | 4 | 5 }
			? K
			: Config extends { readonly dataType: NonScalarDataType }
				? never
				: K
		: never;
}[keyof C] &
	string;
type ReferencesForColumns<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	readonly [
		K in keyof C as C[K] extends ReferenceBuilder ? K : never
	]: C[K] extends ReferenceBuilder<infer Targets, boolean, boolean> ? Targets : never;
};

interface TableShape<
	Select,
	Insert = Partial<Select>,
	References = Readonly<Record<never, never>>
> {
	readonly $inferSelect: Select;
	readonly $inferInsert: Insert;
	/** Type-only map used to infer discriminated polymorphic-reference hydration. */
	readonly $references?: References;
	/**
	 * Type-only: the columns a live read may order by. Absent, every selected column qualifies. A
	 * plain `string` rather than `keyof Select` so every generated table stays within `AnySchema`.
	 */
	readonly $scalarColumns?: string;
}
/** The live-orderable columns of one model: the platform's scalars plus the authored scalars. */
type ScalarColumnsOfModel<C extends Readonly<Record<string, AnyModelFieldBuilder>>> =
	| ScalarColumnNames<SystemRowColumns>
	| Exclude<keyof RecordEmbeddingRow, 'record_embedding'>
	| ScalarColumnNames<C>;

export type TablesForModels<M extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly [K in keyof M]: TableShape<
		SelectForColumns<ColumnsOf<M[K]>>,
		InsertForColumns<ColumnsOf<M[K]>>,
		ReferencesForColumns<ColumnsOf<M[K]>>
	> & { readonly $scalarColumns: ScalarColumnsOfModel<ColumnsOf<M[K]>> };
};

export interface AnySchema {
	readonly tables: Readonly<Record<string, TableShape<object, object, object>>>;
	readonly relations: Readonly<Record<string, unknown>>;
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
/** A release-indexed skill declared from `src/capabilities/skills/<name>/SKILL.md`. */
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
/** The columns a live read of `N` may order by; every row key when the schema declares no set. */
export type SchemaScalarColumns<
	S extends AnySchema,
	N extends TableName<S>
> = S['tables'][N] extends { readonly $scalarColumns: infer Scalar extends string }
	? Scalar
	: Extract<keyof SchemaRow<S, N>, string>;
type SchemaReferences<S extends AnySchema, N extends TableName<S>> = NonNullable<
	S['tables'][N]['$references']
>;
type SchemaRelations<S extends AnySchema, N extends TableName<S>> = N extends keyof S['relations']
	? NonNullable<S['relations'][N]>
	: Readonly<Record<never, never>>;
type QueryScalar = string | number | boolean | bigint | Date | null;
type ScalarQueryOperand<Value> =
	Exclude<Value, undefined> extends QueryScalar ? Exclude<Value, undefined> | Date : unknown;

export type PredicateSubjectName = 'id' | 'email' | 'team' | 'teamIds' | 'tenantId' | 'admin';
export type PredicateSubjectOperand<Name extends PredicateSubjectName = PredicateSubjectName> =
	Readonly<{ readonly $subject: Name }>;

type PredicateScalarSubjectName = Exclude<PredicateSubjectName, 'teamIds'>;

/** Typed operands for read policies; they are values, never arbitrary subject-property paths. */
export const subject = Object.freeze({
	id: Object.freeze({ $subject: 'id' as const }),
	email: Object.freeze({ $subject: 'email' as const }),
	team: Object.freeze({ $subject: 'team' as const }),
	teamIds: Object.freeze({ $subject: 'teamIds' as const }),
	tenantId: Object.freeze({ $subject: 'tenantId' as const }),
	admin: Object.freeze({ $subject: 'admin' as const })
});

type PredicateOperand<Value, AllowSubject extends boolean> =
	| ScalarQueryOperand<Value>
	| (AllowSubject extends true ? PredicateSubjectOperand<PredicateScalarSubjectName> : never);

type PredicateSetOperand<Value, AllowSubject extends boolean> =
	| ReadonlyArray<PredicateOperand<Value, AllowSubject>>
	| (AllowSubject extends true ? PredicateSubjectOperand<'teamIds'> : never);

type JsonPathFilter<AllowSubject extends boolean> = Readonly<{
	readonly path: readonly [string, ...string[]];
	readonly type: 'string' | 'number' | 'boolean' | 'instant' | 'json';
	readonly transform?: 'case-fold';
	readonly eq?: PredicateOperand<unknown, AllowSubject>;
	readonly ne?: PredicateOperand<unknown, AllowSubject>;
	readonly gt?: PredicateOperand<unknown, AllowSubject>;
	readonly gte?: PredicateOperand<unknown, AllowSubject>;
	readonly lt?: PredicateOperand<unknown, AllowSubject>;
	readonly lte?: PredicateOperand<unknown, AllowSubject>;
	readonly in?: PredicateSetOperand<unknown, AllowSubject>;
	readonly notIn?: PredicateSetOperand<unknown, AllowSubject>;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
}>;

type JsonArraySomeFilter<AllowSubject extends boolean> = Readonly<{
	readonly path?: ReadonlyArray<string>;
	readonly transform?: 'case-fold';
	readonly eq?: PredicateOperand<unknown, AllowSubject>;
	readonly in?: PredicateSetOperand<unknown, AllowSubject>;
}>;

type SchemaFieldFilter<Value, AllowSubject extends boolean = false> = {
	readonly eq?: PredicateOperand<Value, AllowSubject>;
	readonly ne?: PredicateOperand<Value, AllowSubject>;
	readonly gt?: PredicateOperand<Value, AllowSubject>;
	readonly gte?: PredicateOperand<Value, AllowSubject>;
	readonly lt?: PredicateOperand<Value, AllowSubject>;
	readonly lte?: PredicateOperand<Value, AllowSubject>;
	readonly in?: PredicateSetOperand<Value, AllowSubject>;
	readonly notIn?: PredicateSetOperand<Value, AllowSubject>;
	readonly like?: string;
	readonly ilike?: string;
	readonly notLike?: string;
	readonly notIlike?: string;
	readonly caseFoldEq?: PredicateOperand<Value, AllowSubject>;
	readonly caseFoldIn?: PredicateSetOperand<Value, AllowSubject>;
	readonly contains?: unknown;
	readonly arrayContains?: unknown;
	readonly arrayContained?: unknown;
	readonly arrayOverlaps?: unknown;
	readonly contains_date?: string;
	readonly overlaps?: Readonly<{
		readonly start: PredicateOperand<Value, AllowSubject>;
		readonly end: PredicateOperand<Value, AllowSubject>;
	}>;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
	readonly jsonPath?: JsonPathFilter<AllowSubject>;
	readonly jsonArraySome?: JsonArraySomeFilter<AllowSubject>;
	/** Policy-only membership in users attached to the subject's team subtree. */
	readonly teamScopeUsers?: AllowSubject extends true ? true : never;
	/** Runtime-owned approval membership; valid only on an approval request identity field. */
	readonly approvalParty?: true;
};
type ReferenceHandleKind<Value> =
	Exclude<Value, null | undefined> extends {
		readonly kind: infer Kind;
	}
		? Kind
		: never;
type SchemaReferenceFilter<Value, AllowSubject extends boolean = false> = {
	readonly eq?:
		| Exclude<Value, null | undefined>
		| (AllowSubject extends true ? PredicateSubjectOperand<PredicateScalarSubjectName> : never);
	readonly ne?:
		| Exclude<Value, null | undefined>
		| (AllowSubject extends true ? PredicateSubjectOperand<PredicateScalarSubjectName> : never);
	readonly in?: ReadonlyArray<Exclude<Value, null | undefined>>;
	readonly notIn?: ReadonlyArray<Exclude<Value, null | undefined>>;
	readonly kind?: Readonly<{
		readonly eq?: ReferenceHandleKind<Value>;
		readonly ne?: ReferenceHandleKind<Value>;
	}>;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
};
type ScalarWhere<
	Row extends object,
	References extends object = Readonly<Record<never, never>>,
	AllowSubject extends boolean = false
> = {
	readonly [K in keyof Row]?: K extends keyof References
		? SchemaReferenceFilter<Row[K], AllowSubject>
		: SchemaFieldFilter<Row[K], AllowSubject> | PredicateOperand<Row[K], AllowSubject>;
};

type PredicateDepth = 0 | 1 | 2 | 3 | 4;
type PreviousDepth = readonly [0, 0, 1, 2, 3];
type RelationTarget<S extends AnySchema, Relation> = Relation extends {
	readonly target: infer Target extends TableName<S>;
}
	? Target
	: never;
type RelationWhere<
	S extends AnySchema,
	N extends TableName<S>,
	AllowSubject extends boolean,
	Depth extends PredicateDepth
> = Depth extends 0
	? Readonly<Record<never, never>>
	: {
			readonly [K in keyof SchemaRelations<S, N>]?: Readonly<{
				readonly some?: SchemaWhereFor<
					S,
					RelationTarget<S, SchemaRelations<S, N>[K]>,
					AllowSubject,
					PreviousDepth[Depth]
				>;
				readonly none?: SchemaWhereFor<
					S,
					RelationTarget<S, SchemaRelations<S, N>[K]>,
					AllowSubject,
					PreviousDepth[Depth]
				>;
				readonly every?: SchemaWhereFor<
					S,
					RelationTarget<S, SchemaRelations<S, N>[K]>,
					AllowSubject,
					PreviousDepth[Depth]
				>;
			}>;
		};

type SchemaWhereFor<
	S extends AnySchema,
	N extends TableName<S>,
	AllowSubject extends boolean = false,
	Depth extends PredicateDepth = 4
> = ScalarWhere<SchemaRow<S, N>, SchemaReferences<S, N>, AllowSubject> &
	RelationWhere<S, N, AllowSubject, Depth> & {
		readonly AND?: ReadonlyArray<SchemaWhereFor<S, N, AllowSubject, Depth>>;
		readonly OR?: ReadonlyArray<SchemaWhereFor<S, N, AllowSubject, Depth>>;
		readonly NOT?: SchemaWhereFor<S, N, AllowSubject, Depth>;
	};

type SchemaWhere<
	Row extends object,
	References extends object = Readonly<Record<never, never>>
> = ScalarWhere<Row, References> & {
	readonly AND?: ReadonlyArray<SchemaWhere<Row, References>>;
	readonly OR?: ReadonlyArray<SchemaWhere<Row, References>>;
	readonly NOT?: SchemaWhere<Row, References>;
};

/** The closed structured row-filter language available to authored policies. */
type PolicyWhere<S extends AnySchema, N extends TableName<S>> = SchemaWhereFor<S, N, true>;

export type { CollectionSearch } from '@norbital-ai/std/collection';

export interface SchemaQueryConfig<S extends AnySchema, N extends TableName<S>> {
	readonly where?: SchemaWhereFor<S, N>;
	readonly search?: CollectionSearch;
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
			Partial<{
				readonly [K in keyof SchemaRelations<S, N>]:
					boolean | SchemaQueryConfig<S, RelationTarget<S, SchemaRelations<S, N>[K]>>;
			}> &
			Record<string, boolean | Readonly<Record<string, unknown>>>
	>;
	readonly limit?: number;
}

type ExactConfig<Input, Shape> = Input & Readonly<Record<Exclude<keyof Input, keyof Shape>, never>>;

/** Rejects raw-SQL escape keys at every logical branch without publishing one on `SchemaWhere`. */
type ExactWhere<Input> = Input extends object
	? {
			readonly [K in keyof Input]: K extends '$sql'
				? never
				: K extends 'AND' | 'OR'
					? Input[K] extends ReadonlyArray<infer Branch>
						? ReadonlyArray<ExactWhere<Branch>>
						: Input[K]
					: K extends 'NOT'
						? ExactWhere<Input[K]>
						: Input[K];
		}
	: Input;

type ExactWhereMember<Input> = Input extends { readonly where?: infer Where }
	? Readonly<{ readonly where?: ExactWhere<Where> }>
	: unknown;

type ExactQueryInput<
	S extends AnySchema,
	N extends TableName<S>,
	Input extends SchemaQueryConfig<S, N>
> = ExactConfig<Input, SchemaQueryConfig<S, N>> & ExactWhereMember<Input>;

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
type HydratedRelation<S extends AnySchema, Relation, Spec> = Relation extends {
	readonly target: TableName<S>;
	readonly cardinality: 'one' | 'many';
}
	? SchemaQueryRow<
			S,
			RelationTarget<S, Relation>,
			Extract<
				Spec extends true ? undefined : Spec,
				SchemaQueryConfig<S, RelationTarget<S, Relation>> | undefined
			>
		> extends infer Row
		? Relation extends { readonly cardinality: 'many' }
			? ReadonlyArray<Row>
			: Row | null
		: never
	: Readonly<Record<string, unknown>> | ReadonlyArray<Readonly<Record<string, unknown>>> | null;
type WithRows<S extends AnySchema, N extends TableName<S>, Config> = Config extends {
	readonly with: infer W;
}
	? {
			readonly [
				K in keyof W as W[K] extends false | undefined ? never : K
			]: K extends keyof SchemaReferences<S, N>
				? SchemaReferences<S, N>[K] extends ReferenceTargets
					? | HydratedReference<S, SchemaReferences<S, N>[K], W[K]>
						| (null extends SchemaRow<S, N>[K & keyof SchemaRow<S, N>] ? null : never)
					: never
				: HydratedRelation<
						S,
						K extends keyof SchemaRelations<S, N> ? SchemaRelations<S, N>[K] : unknown,
						W[K]
					>;
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
type MutationUpdateFor<S extends AnySchema, N extends TableName<S>> = Partial<
	S['tables'][N]['$inferSelect']
>;

/** The distances pgvector can measure: Euclidean, cosine, and negative inner product. */
type NearestMetric = 'l2' | 'cosine' | 'ip';

/**
 * The collection's vector columns, and only those.
 *
 * `column` used to be a `string`, so a typo, a text column, or a column of another collection all
 * compiled and were refused at run time by a workspace that had already done the query's work. The
 * match is bidirectional on purpose: a column is a vector column when its type is exactly an array
 * of numbers, so a tuple or a narrower array — which pgvector cannot measure — does not qualify.
 * `.array()` is unavailable on the authoring surface, so this is the only way a column reaches that
 * type.
 */
type VectorColumnName<S extends AnySchema, N extends TableName<S>> = {
	readonly [K in keyof SchemaRow<S, N>]-?: NonNullable<
		SchemaRow<S, N>[K]
	> extends ReadonlyArray<number>
		? Array<number> extends NonNullable<SchemaRow<S, N>[K]>
			? K
			: never
		: never;
}[keyof SchemaRow<S, N>];

/**
 * A nearest-neighbour read: an ordinary query config, plus what to measure against.
 *
 * `orderBy` is absent because the ordering *is* the query — the distance decides it, and offering a
 * second ordering would be offering to throw the answer away. It shares only ordinary narrowing,
 * projection and limit with `findMany`; text search and relation hydration are different operations.
 * The predecessor's bespoke `excludeIds` could exclude by id and by nothing else.
 */
export interface SchemaNearestConfig<
	S extends AnySchema,
	N extends TableName<S>,
	Col extends VectorColumnName<S, N>
> {
	readonly where?: SchemaWhereFor<S, N>;
	readonly columns?: Partial<Readonly<Record<keyof SchemaRow<S, N>, boolean>>>;
	readonly limit?: number;
	readonly column: Col;
	/** The vector to measure against, typed as the column that stores it. */
	readonly probe: NonNullable<SchemaRow<S, N>[Col]>;
	readonly metric?: NearestMetric;
	/** Rows further than this are not returned at all, so a caller never filters after the fact. */
	readonly maxDistance?: number;
}

interface CollectionQuery<S extends AnySchema, N extends TableName<S>> {
	findMany(): Effect.Effect<Array<SchemaRow<S, N> & Readonly<Record<string, unknown>>>>;
	findMany<const Config extends SchemaQueryConfig<S, N>>(
		config: ExactQueryInput<S, N, Config>
	): Effect.Effect<Array<SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>>>;
	findFirst(): Effect.Effect<(SchemaRow<S, N> & Readonly<Record<string, unknown>>) | undefined>;
	findFirst<const Config extends SchemaQueryConfig<S, N>>(
		config: ExactQueryInput<S, N, Config>
	): Effect.Effect<(SchemaQueryRow<S, N, Config> & Readonly<Record<string, unknown>>) | undefined>;
	readonly count: (
		config?: Pick<SchemaQueryConfig<S, N>, 'where' | 'search'>
	) => Effect.Effect<number>;
	/**
	 * The rows nearest a probe vector, closest first, each carrying its measured `distance`.
	 *
	 * Answered by the collection's vector index, so this stays exact and bounded as the collection
	 * grows: the same comparison done after reading rows would have to read all of them.
	 */
	findNearest<
		const Col extends VectorColumnName<S, N>,
		const Config extends SchemaNearestConfig<S, N, Col>
	>(
		config: ExactConfig<Config, SchemaNearestConfig<S, N, Col>> &
			ExactWhereMember<Config> & { readonly column: Col }
	): Effect.Effect<Array<SchemaQueryRow<S, N, Config> & Readonly<{ readonly distance: number }>>>;
}
type ApprovalRequestRow = SelectForColumns<
	typeof SYSTEM_COLLECTION_MODELS.approval_request.columns
>;
type ApprovalRequestManyConfig = Readonly<{
	readonly where?: SchemaWhere<ApprovalRequestRow>;
	readonly columns?: Partial<Readonly<Record<keyof ApprovalRequestRow, boolean>>>;
	readonly orderBy?: Partial<Readonly<Record<keyof ApprovalRequestRow, 'asc' | 'desc'>>>;
	readonly limit?: number;
}>;
type ApprovalRequestFirstConfig = Pick<ApprovalRequestManyConfig, 'where' | 'limit'>;
interface ApprovalRequestQuery {
	readonly findMany: <const Config extends ApprovalRequestManyConfig>(
		config?: ExactConfig<Config, ApprovalRequestManyConfig> & ExactWhereMember<Config>
	) => Effect.Effect<Array<ApprovalRequestRow>>;
	readonly findFirst: <const Config extends ApprovalRequestFirstConfig>(
		config?: ExactConfig<Config, ApprovalRequestFirstConfig> & ExactWhereMember<Config>
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
 */
/**
 * One tool `api.infer` lets the model call before it answers.
 *
 * `run` is an ordinary closure over the authored api — a page read through `api.readUrl`, a
 * lookup through `api.db` — and its JSON result is what the model sees next. The model decides
 * whether and how often to call it, with no step cap; the result is still the structured value
 * `schema` decodes. A failing `run` becomes a failed tool result the model can react to.
 */
export interface InferenceTool<Input = unknown> {
	/** A unique snake_case identifier the model calls the tool by. */
	readonly name: string;
	/** What the tool does and when to use it, written for the model. */
	readonly description: string;
	readonly input: Schema.Schema<Input>;
	run(input: Input): Effect.Effect<Schema.Json>;
}

/**
 * A structured inference: one prompt, optionally some tools the model may use on the way, and a
 * schema the answer must decode to. Without tools it is a single provider turn; with them the
 * model researches with tool turns for as long as it needs, then answers.
 *
 * `hostTools` names host capabilities (the browser an agent drives, for instance) the runtime
 * resolves from the host's own catalogue and dispatches itself; `tools` are closures the author
 * writes. A name the host does not advertise is a refusal, never a silently missing tool.
 */
interface StructuredInferenceInput<Output> {
	readonly schema: Schema.Schema<Output>;
	/** Standing directive: who the model is, the current state, and the goal it must pursue. */
	readonly system?: string;
	readonly prompt: string;
	readonly model?: string;
	readonly images?: ReadonlyArray<{
		readonly file: FileRef;
		readonly detail?: 'auto' | 'low' | 'high';
	}>;
	readonly tools?: ReadonlyArray<InferenceTool>;
	readonly hostTools?: ReadonlyArray<string>;
}

type AuthoredReadDatabase<S extends AnySchema> = {
	readonly [N in TableName<S>]: CollectionQuery<S, N>;
} & {
	readonly approval_request: ApprovalRequestQuery;
	/** Durable outcomes let scheduled work resume an earlier automation's deferred decisions. */
	readonly automation_run: Pick<
		CollectionQuery<
			{
				tables: TablesForModels<Pick<typeof SYSTEM_COLLECTION_MODELS, 'automation_run'>>;
				relations: Readonly<Record<never, never>>;
			},
			'automation_run'
		>,
		'findMany' | 'findFirst' | 'count'
	>;
};
/**
 * The workspace's declared collections, read off the generated augmentation.
 *
 * `generated/collections.d.ts` augments `WorkspaceAuthoringTypes` with one `typeof import` per
 * `+collection.ts`; unsynced workspaces and Bolt's own sources have no augmentation and see every
 * collection as read-only.
 */
type WorkspaceCollectionsOf = WorkspaceAuthoringTypes extends {
	readonly collections: infer Collections;
}
	? Collections
	: Readonly<Record<never, never>>;

/**
 * Matched structurally, not against `AnyCollectionDeclaration`: a declaration's `transform` takes
 * its own model's rows, so under variance no concrete `defineCollection` value extends the widened
 * one, and a constrained `infer` here would type every declared collection as read-only.
 */
type DeclaredCollection<N extends PropertyKey> =
	WorkspaceCollectionsOf extends Readonly<Record<N, infer Declared>> ? Declared : never;

/**
 * The operations are optional keys of `CollectionDeclaration`, so they are matched as optional here
 * and the `undefined` a non-exact workspace tsconfig adds is extracted away: a required-key pattern
 * never matches a `defineCollection` value and would type every declared collection as read-only.
 */
type ModelOf<D> = D extends { readonly model: infer M extends ModelDeclaration } ? M : never;
type DeclaredCreate<D> = D extends { readonly create?: infer Create }
	? CollectionInputOf<ModelOf<D>, Extract<Create, CollectionOperationDeclaration>, 'create'>
	: never;
type DeclaredUpdate<D> = D extends { readonly update?: infer Update }
	? CollectionInputOf<ModelOf<D>, Extract<Update, CollectionOperationDeclaration>, 'update'>
	: never;
type DeclaresDelete<D> = D extends { readonly delete?: infer Delete }
	? [Delete] extends [undefined]
		? false
		: true
	: false;

/** The browser-side input of one declared operation, `never` where the collection declares none. */
export type CollectionClientInput<
	N extends PropertyKey,
	Mode extends 'create' | 'update'
> = Mode extends 'create'
	? DeclaredCreate<DeclaredCollection<N>>
	: DeclaredUpdate<DeclaredCollection<N>>;

/**
 * The declared write surface of one collection (RFC §4.2): only the operations its `+collection.ts`
 * declares exist, and each takes exactly the declared input. Every call is one transaction.
 */
export type CollectionWriteApi<S extends AnySchema, N extends TableName<S>, D> = ([
	DeclaredCreate<D>
] extends [never]
	? Readonly<Record<never, never>>
	: Readonly<{
			readonly create: (input: DeclaredCreate<D>) => Effect.Effect<SchemaRow<S, N>>;
			readonly createMany: (
				inputs: ReadonlyArray<DeclaredCreate<D>>
			) => Effect.Effect<Array<SchemaRow<S, N>>>;
		}>) &
	([DeclaredUpdate<D>] extends [never]
		? Readonly<Record<never, never>>
		: Readonly<{
				readonly update: (id: string, input: DeclaredUpdate<D>) => Effect.Effect<SchemaRow<S, N>>;
				readonly updateMany: (
					inputs: ReadonlyArray<DeclaredUpdate<D> & { readonly id: string }>
				) => Effect.Effect<Array<SchemaRow<S, N>>>;
			}>) &
	(DeclaresDelete<D> extends true
		? Readonly<{
				readonly delete: (id: string) => Effect.Effect<void>;
				readonly deleteMany: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
			}>
		: Readonly<Record<never, never>>);

type AuthoredCollectionsApi<S extends AnySchema> = {
	readonly [
		N in TableName<S> as [DeclaredCollection<N>] extends [never] ? never : N
	]: CollectionWriteApi<S, N, DeclaredCollection<N>>;
};

/** Where a history read stands: an instant, a revision ordinal, or an approval's restore point. */
export type CollectionHistoryAnchor =
	| Readonly<{ readonly instant: string }>
	| Readonly<{ readonly revision: number }>
	| Readonly<{ readonly before: string }>;

export type CollectionRevision<Row> = Readonly<{
	readonly values: Row;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
}>;

/** `api.collection_history.<name>`: the record's log, reconstructed and masked like a live read. */
type AuthoredCollectionHistory<S extends AnySchema> = {
	readonly [N in TableName<S>]: Readonly<{
		/** Every revision of one record, oldest first. */
		readonly revisions: (id: string) => Effect.Effect<Array<CollectionRevision<SchemaRow<S, N>>>>;
		/** The record as it stood at the anchor, or `undefined` when it did not exist yet. */
		readonly at: (
			id: string,
			anchor: CollectionHistoryAnchor
		) => Effect.Effect<SchemaRow<S, N> | undefined>;
	}>;
};

export type Api<S extends AnySchema = DefaultWorkspaceSchema> = {
	/** Reads. Writes go through `collection`. */
	readonly db: AuthoredReadDatabase<S>;
	/** The declared write surface (RFC §4.2), one entry per `+collection.ts`. */
	readonly collection: AuthoredCollectionsApi<S>;
	readonly collection_history: AuthoredCollectionHistory<S>;
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
	/**
	 * Fills missing platform record embeddings for one collection, host-side.
	 *
	 * A record embedding is a platform column, so no authored write can set it: the host reads the
	 * collection's declared embedding fields, resolves a file field into its image, embeds, and
	 * writes the vector. One call is bounded and re-runnable — it selects only rows that have none —
	 * so a scheduled pass loops until `selected` is zero. `ids` narrows the pass to named rows.
	 */
	readonly embed: (input: {
		readonly collection: TableName<S>;
		readonly ids?: ReadonlyArray<string>;
		readonly limit?: number;
	}) => Effect.Effect<
		Readonly<{
			readonly collection: string;
			readonly selected: number;
			readonly embedded: number;
			readonly failed: number;
			readonly issues?: ReadonlyArray<string>;
		}>,
		AuthoredRefusal
	>;
};
export type CollectionPipelines<S extends AnySchema, N extends TableName<S>> = {
	readonly export?: {
		readonly description: string;
		readonly handler: (
			context: { readonly records: ReadonlyArray<SchemaRow<S, N>> },
			api: Api<S>
		) => Effect.Effect<TExportManifest, AuthoredRefusal, never> | TExportManifest;
	};
	readonly import?: {
		readonly description: string;
		readonly input: Schema.Codec<unknown, unknown>;
		readonly handler: (
			context: { readonly input: unknown },
			api: Api<S>
		) =>
			| Effect.Effect<ReadonlyArray<DeclaredCreate<DeclaredCollection<N>>>, AuthoredRefusal, never>
			| ReadonlyArray<DeclaredCreate<DeclaredCollection<N>>>;
	};
};
/** Retry with exponential backoff. `Retry-After` on a 429 or 503 wins over the computed delay. */
export type PullRetrySpec = {
	readonly attempts: number;
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
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
 * `secret` is a vault reference and never a literal, as a connection token is: a secret written
 * into a workspace is a secret in the artifact.
 *
 * `signedPayload` is the template the source signed, over the **raw request body** — `{body}` is
 * the bytes as they arrived, not a re-serialisation of the parsed JSON. Those are different strings
 * for the same document (key order, whitespace, unicode escaping), so a digest taken over parsed
 * JSON does not match anything the sender computed. It defaults to `'{body}'`, which is the
 * signature scheme most sources use.
 *
 * `timestamp` is the replay defence, and it is only a defence when the timestamp is *inside*
 * `signedPayload`: a timestamp the signature does not cover is a value the attacker replaying the
 * body can set to whatever they like. `http.source` refuses that combination rather than
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
 * The exact prepared JavaScript value a write rule decides against.
 *
 * A new-row mutation has not acquired database defaults yet, so its record is the prepared insert
 * plus the runtime-assigned id. An existing-row mutation has a complete stored row on both sides
 * and exposes only the prepared patch as `changes`. A delete sees the complete stored row it is
 * about to remove.
 */
type PolicyWriteContext<
	StoredRecord,
	Action extends 'new' | 'existing' | 'delete',
	NewRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = Action extends 'existing'
	? Readonly<{
			readonly previous: Readonly<StoredRecord>;
			readonly changes: Readonly<Changes>;
			readonly record: Readonly<StoredRecord>;
		}>
	: Action extends 'new'
		? Readonly<{ readonly record: Readonly<NewRecord> }>
		: Readonly<{ readonly record: Readonly<StoredRecord> }>;

type PolicyWriteDecision<
	S extends AnySchema,
	StoredRecord,
	Action extends 'new' | 'existing' | 'delete',
	NewRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = (
	context: PolicyWriteContext<StoredRecord, Action, NewRecord, Changes>,
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
	Action extends 'new' | 'existing' | 'delete',
	NewRecord = StoredRecord,
	Changes = Partial<StoredRecord>
> = {
	readonly flow: (
		context: PolicyWriteContext<StoredRecord, Action, NewRecord, Changes>,
		api: PolicyDecisionApi<S>
	) => ApprovalFlow | Effect.Effect<ApprovalFlow>;
	readonly superceded_by: ReadonlyArray<TeamName>;
};

/**
 * What write authorization and approval-flow functions may reach: collection reads.
 *
 * Deciding whether a write may proceed or who must sign it is evaluated through the direct
 * `db.<collection>` route.
 */
export type PolicyDecisionApi<S extends AnySchema = DefaultWorkspaceSchema> = Readonly<{
	readonly db: AuthoredReadDatabase<S>;
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
	/**
	 * The declared channel it speaks on (`src/channels/+<name>.ts`), not what it may do. One envoy per
	 * channel; an `http` or `inbox` channel carries no conversation and is a type error here.
	 */
	readonly channel: ConversationChannel;
	/**
	 * Who may reach it, and whose authority a turn carries. One literal, so no combination of fields
	 * can hand a stranger a member's authority:
	 *
	 * - `public` — anyone who can message the transport; every turn holds `policies`.
	 * - `authenticated` — a member who has proved the address is theirs; a turn holds what that member
	 *   may do in the web app, capped by `policies`, in a direct message and a group alike.
	 *
	 * It is reach and not conversation shape, which `groupMessages` answers more precisely.
	 */
	readonly audience: 'public' | 'authenticated';
	/**
	 * What this envoy MAY DO wherever it speaks as itself — tools, MCP servers, skills, apps, grants
	 * and rate limits alike. Its `envoys.*` rate limits bound every turn.
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
	/** Whether this envoy may create and coordinate delegated sandbox-agent sessions. */
	readonly delegation: 'enabled' | 'disabled';
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
	readonly where?: PolicyWhere<S, N>;
	readonly fields?: PolicyGrantFields<S, N>;
};

/**
 * A new-row mutation is authorized against its prepared candidate.
 *
 * The action key itself is the opt-in; an empty object means every prepared candidate, while an
 * absent `mutate.new` key means no new-row authority. `authorize` is server-only Effect code and
 * `approval` resolves one concrete review path after authorization succeeds.
 */
type PolicyNewMutationGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly fields?: PolicyGrantFields<S, N>;
	readonly authorize?: PolicyWriteDecision<
		S,
		SchemaRow<S, N>,
		'new',
		{ readonly id: string } & MutationInsertFor<S, N>
	>;
	readonly approval?: PolicyApproval<
		S,
		SchemaRow<S, N>,
		'new',
		{ readonly id: string } & MutationInsertFor<S, N>
	>;
};

/** An existing-row mutation is authorized against its stored row, submitted changes and result. */
type PolicyExistingMutationGrant<S extends AnySchema, N extends TableName<S>> = {
	readonly fields?: PolicyGrantFields<S, N>;
	readonly authorize?: PolicyWriteDecision<
		S,
		SchemaRow<S, N>,
		'existing',
		SchemaRow<S, N>,
		MutationUpdateFor<S, N>
	>;
	readonly approval?: PolicyApproval<
		S,
		SchemaRow<S, N>,
		'existing',
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
	readonly mutate?: Readonly<{
		readonly new?: PolicyNewMutationGrant<S, N>;
		readonly existing?: PolicyExistingMutationGrant<S, N>;
	}>;
	readonly delete?: PolicyDeleteGrant<S, N>;
}>;

/**
 * One slot per collection grant coordinate, with new and existing mutations nested under
 * `mutate`.
 *
 * The old array could state the same coordinate twice and `rowPredicate` would union it, so an
 * unrestricted sibling silently erased a narrowed one. An object has one key for each coordinate;
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
