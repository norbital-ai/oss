// The names index (§3.1, rule 8). `bolt sync` evaluates the declarations and prints each part's data into
// `.norbital/names.ts` as literal type text (functions dropped), augmenting `Names`; every cross-file type below is read
// from it. No part reads its own file, so a body typed from it is never circular; it is one sync behind an edit.
import type { SystemNames } from '../system/index.ts';
import type { BuiltinFields } from './builtin-fields.ts';
import type { KeyFor, Simplify, ValueOf } from './fields.ts';
import type { ExposureSpec, ModelSpec, NullableOfExpr } from './model.ts';
import type { ApprovalStep } from './access/policy.ts';
import type { CurrencyCode, Id, RecordRef } from './values.ts';

/** Augmented by the generated `.norbital/names.ts`: `declare module '@norbital-ai/bolt' { interface Names { … } }`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface Names {}

/** What the compiler writes into `Names`. Every part is optional: an absent part means "none declared". */
type NamesShape = {
	workspace: {
		currency?: CurrencyCode;
		/** Named instances: the slot name is the `sys_integration` id source addresses. */
		connections?: { readonly [slot: string]: { integration: string; envoy?: string } };
	};
	/** `src/+secrets.ts`: the workspace's secret names. */
	secrets: { readonly [name: string]: unknown };
	/** Each model's storage (`splitModel(name, literal).model`). */
	models: { [model: string]: ModelSpec };
	/** Each ref field, keyed `'<model>.<field>'` (`splitModel(name, literal).relationships`). */
	relationships: { [key: `${string}.${string}`]: RelationshipSpec };
	/** Each exposed model's exposure (`splitModel(name, literal).exposure`); a model without `read` has none. */
	exposures: { [model: string]: ExposureSpec };
	/** Each exposed model's declared layer paths below its root → the model behind each (`layerModels`). */
	layers: { [model: string]: { [path: string]: string } };
	/** Each `src/integration/<name>/+integration.ts`: the workspace's definitions (bolt's own are `SystemNames`). */
	integrations: { [integration: string]: unknown };
	/** Each `src/agent/envoy/+<id>.envoy.ts`. */
	envoys: { [envoy: string]: unknown };
	customFields: { [field: string]: { spec: { shape: unknown } } };
	teams: { [team: string]: unknown };
	/** The base catalogue `src/i18n/+messages.ts`: its keys are the message keys. */
	messages: { [key: string]: string };
	/** Each `src/i18n/+<locale>.messages.ts`: its keys must be the base's (checked by `Verify`). */
	locales: { [locale: string]: { [key: string]: string } };
	policies: { [policy: string]: unknown };
	apps: { [app: string]: unknown };
	/** Each `src/kiosk/<k>/+kiosk.ts`, by its folder path. */
	kiosks: { [kiosk: string]: unknown };
	automations: { [automation: string]: unknown };
	mcp: { [server: string]: unknown };
	skills: { [skill: string]: unknown };
	/** Each app (its folder path) → the union of its `+<page>.page.svelte` names. */
	pages: { [app: string]: string };
	/** Each kiosk (its folder path) → the union of its `+<page>.page.svelte` names. */
	kioskPages: { [kiosk: string]: string };
	/** Each group (its folder path) → the union of its child app and group folder names. */
	groups: { [group: string]: string };
	/** The tools the host advertises (rule 58), written by the build from the host it compiles for. */
	hostTools: { [tool: string]: unknown };
};
// Indexed access touches only the one part, so a part may depend on another (models ← relationships ← models).
export type NamesPart<K extends keyof NamesShape> = K extends keyof Names ? Names[K] : {};

/**
 * One ref field as the relationships part holds it (`'<model>.<field>'`): its target (`to`), the `inverse` many-relation
 * name, `optional`, a default from the requestor, `onDelete`, `owned` children and a `where` on the target.
 */
export type RelationshipSpec = {
	to: string | readonly string[];
	inverse?: string;
	optional?: true;
	default?: { var: 'requestor.id' | 'requestor.party' };
	onDelete?: 'restrict' | 'cascade' | 'setNull';
	owned?: true;
	where?: object;
};

// The built-in layer (`src/system/**`, X-18): its models are declared as a workspace's are and its index holds the same
// three parts. Its models are the exposed system models; its private models (sys_session, sys_challenge,
// sys_config) declare no `read`, so no author position names them.
type SystemModels = SystemNames['models'];
/** A built-in layer model: a system model's, or one of the engine's private models. */
export type SystemModelName = keyof SystemModels & string;
/** The system models (X-18). */
export type SystemName = keyof SystemNames['exposures'] & string;

type Models = NamesPart<'models'>;
type Exposed = NamesPart<'exposures'>;

/** An authored model (`src/data/model/<m>/+model.ts`). */
export type AuthoredModelName = keyof Models & string;
/** Anything a ref field or an `Id<>` may name: authored models and system models. */
export type TargetName = AuthoredModelName | SystemName;
/** Every surface addresses models (P9): authored ones, plus the system models. */
export type ModelName = (keyof Exposed & string) | SystemName;
/** Ledgers (X-18): an `Id<>` target, never granted, read by server code, written or triggered on. */
export type Ledger = 'sys_run';
/** A model a trigger or a read may name: every model but the ledgers. */
export type ReadableName = Exclude<ModelName, Ledger>;
/** Every custom field: the built-ins (`money`, `file`, `point`, `phone`) and the workspace's (`src/data/custom_field/<f>/`), one namespace. */
type CustomFields = BuiltinFields & NamesPart<'customFields'>;
/** A custom field name a model may store as `{ kind: 'custom', of }`: a built-in's or the workspace's own. */
export type CustomFieldName = keyof CustomFields & string;
/** The team names `+team.ts` declares. */
export type TeamName = keyof NamesPart<'teams'> & string;
/** The policy names (`src/access_control/policy/+<name>.policy.ts`). */
export type PolicyName = keyof NamesPart<'policies'> & string;
/** The app names (`src/app/<a>/+app.ts`). */
export type AppName = keyof NamesPart<'apps'> & string;
/** The kiosk names (`src/kiosk/<k>/+kiosk.ts`). */
export type KioskName = keyof NamesPart<'kiosks'> & string;
/** The automation names (`src/automation/+<a>.automation.ts`). */
export type AutomationName = keyof NamesPart<'automations'> & string;
/** The envoy names (`src/agent/envoy/+<id>.envoy.ts`). */
export type EnvoyName = keyof NamesPart<'envoys'> & string;
type Definitions = NamesPart<'integrations'> & SystemNames['integrations'];
/** The integration definitions: the workspace's (`src/integration/<name>/`) and bolt's conversation definitions. */
export type IntegrationName = keyof Definitions & string;
/** The literal of definition `D`. */
export type IntegrationSpecOf<D> = D extends keyof Definitions
	? Definitions[D] extends { spec: infer S }
		? S
		: never
	: never;
declare const definition: unique symbol;
/** A `sys_integration` id known to be an instance of definition `D`: what an FK pinned to `D` holds. */
export type InstanceId<D extends string = IntegrationName> = Id<'sys_integration'> & {
	readonly [definition]: D;
};
/** The MCP server names (`src/agent/mcp/+<n>.mcp.ts`). */
export type McpName = keyof NamesPart<'mcp'> & string;
/** The agent skill names (`src/agent/skill/<n>/+skill.md`). */
export type SkillName = keyof NamesPart<'skills'> & string;
/** The host tools a policy's `capabilities.tools` may name (the host's Studio and browser tools). */
export type HostToolName = keyof NamesPart<'hostTools'> & string;
export type CustomShape<F> = F extends keyof CustomFields
	? CustomFields[F] extends { spec: { shape: infer S } }
		? S
		: never
	: never;

type ModelOf<M> = M extends AuthoredModelName
	? Models[M]
	: M extends SystemModelName
		? SystemModels[M]
		: never;
// Index the field union directly: inferring it reduces subtypes pairwise and can discard nullable variants.
// Preserve inference's empty/broad-model fallback without reducing the concrete model union.
type FieldsOf<M, T = ModelOf<M>> = [T] extends [never]
	? unknown
	: unknown extends T
		? ModelOf<M> extends { fields: infer F }
			? F
			: {}
		: [T] extends [{ fields: unknown }]
			? T['fields']
			: {};
type ComputedOf<M> =
	ModelOf<M> extends { computed: infer C }
		? { [P in keyof C]: ComputedEntry<C, P, FieldsOf<M>> }
		: {};
type ComputedEntry<C, P extends keyof C, F> = C[P] extends { kind: infer K; expr: infer X }
	? { kind: K } & (true extends NullableOfExpr<X, F, C> ? { optional: true } : {})
	: never;

/** A name parameter's check. Name parameters are constrained to `string` and checked through `Is<N, Names>`: while a
 * call is inferred, its literal arguments are typed against the uninstantiated `Where<C>`, `Select<C>`, `ActInput<N>`
 * or model spec, and a constraint over the whole names index made TS expand every model for each literal
 * (G1 scale fixture: ~40 ms per nested literal). */
export type Is<N, Names> = N extends Names ? N : Names;

// ── relationships ──
export type TargetsOf<R> = R extends { to: infer T }
	? T extends readonly (infer A)[]
		? A
		: T
	: never;
// The relationship views are built once per workspace and read by indexed access (G1 scale fixture: they were ~10M of
// 16M instantiations). Two global scans group the relationship keys by source and by target; each model's view is a
// property of `RelIndex`, instantiated once and kept (an alias re-instantiates its defaults on every reference). A view
// is a mapped type over a key union, so `keyof` it is that union: `keyof` a mapped type with an `as` clause re-scans its
// source on every read. Each view is conditional on `M`, so a generic `M` defers it.
type AllRels = NamesPart<'relationships'> & SystemNames['relationships'];
type BySource = { [K in keyof AllRels as K extends `${infer S}.${string}` ? S : never]: K };
type ByTarget = {
	[
		K in keyof AllRels as AllRels[K] extends { inverse: string }
			? TargetsOf<AllRels[K]> & string
			: never
	]: K;
};
type Sources = keyof BySource;
type Targets = keyof ByTarget;
type RelView<
	M,
	Own = M extends Sources ? BySource[M] : never,
	One extends string = Own extends `${string}.${infer F}` ? F : never,
	// inverse name → the relationship key it runs back through (a union when declared twice)
	Back = M extends Targets
		? {
				[
					K in ByTarget[M] & keyof AllRels as AllRels[K] extends { inverse: infer I extends string }
						? I
						: never
				]: K;
			}
		: {},
	BackKeys extends keyof Back = keyof Back,
	Many extends string = BackKeys & string
> = {
	one: { [F in One]: AllRels[`${M & string}.${F}` & keyof AllRels] };
	// `& TargetName` here, once: a literal intersected with the names union is a union built per use
	target: { [F in One]: TargetsOf<AllRels[`${M & string}.${F}` & keyof AllRels]> & TargetName };
	keys: { [I in Many]: Back[I & BackKeys] };
	many: { [I in Many]: Back[I & BackKeys] extends `${infer S}.${string}` ? S & TargetName : never };
};
// a mapped type's property is instantiated once and kept
type RelIndex = { [M in TargetName]: RelView<M> };
type View<M> = M extends TargetName ? RelIndex[M] : { one: {}; target: {}; keys: {}; many: {} };
type ManyRelKeys<M> = View<M>['keys'];
/** One-relations of `M`: the FK field name → its spec. */
export type OneRels<M> = View<M>['one'];
/** Many-relations of `M` (inverses): the inverse name → the source model. */
export type ManyRels<M> = View<M>['many'];
export type OneTarget<M, R> = OneTargetOf<M, R>;
type OneTargetOf<M, R, Targets = View<M>['target']> = R extends keyof Targets
	? Targets[R] & string
	: never;
export type RelTarget<M, R> = R extends keyof OneRels<M>
	? OneTarget<M, R>
	: R extends keyof ManyRels<M>
		? ManyRels<M>[R]
		: never;
/** Inverse names declared by more than one ref field onto `M` (checked by `Verify`). */
export type DuplicateInverse<M> = DuplicateInverseOf<M>;
// Capture keys separately to preserve union and never results.
type DuplicateInverseOf<M, R = ManyRelKeys<M>, Keys extends keyof R = keyof R> = {
	[I in Keys]: IsUnion<R[I]> extends true ? I : never;
}[Keys] &
	string;
/** FKs of `M` to an owning parent: set on create, never updated (rule 41). */
export type OwnedFk<M> = [M] extends [never]
	? {
			[F in keyof OneRels<M>]: OneRels<M>[F] extends { owned: true } ? F : never;
		}[keyof OneRels<M>] &
			string
	: KeyFor<OneRels<M>, { owned: true }>;
/** Inverse names on `M` of owned children (composition). */
export type OwnedInverse<M> = OwnedInverseOf<M>;
type OwnedInverseOf<M, R = ManyRelKeys<M>, Keys extends keyof R = keyof R> = {
	[I in Keys]: AllRels[R[I] & keyof AllRels] extends { owned: true } ? I : never;
}[Keys] &
	string;
export type RelNameOf<M> = (keyof OneRels<M> | keyof ManyRels<M>) & string;
type FkValue<R, Targets = TargetsOf<R>> =
	| ([Targets] extends [infer T extends string]
			? [T] extends [TargetName]
				? IsUnion<T> extends true
					? RecordRef<T>
					: [T] extends ['sys_integration']
						? InstanceRef<R>
						: Id<T>
				: never
			: never)
	| (R extends { optional: true } ? null : never);
// an instance FK pinned to a definition (`where: { integration: { eq: D } }`) holds that definition's instances
type InstanceRef<R> = R extends { where: { integration: { eq: infer D extends string } } }
	? InstanceId<D>
	: Id<'sys_integration'>;
export type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

// ── columns ──
/** Read-only system columns on every workspace row (§3.3.9); a built-in layer row has its key alone (`table`). */
export type SystemColumns<M> = M extends SystemModelName
	? { id: { kind: 'id'; of: M & string } }
	: {
			id: { kind: 'id'; of: M & string };
			revision: { kind: 'int' };
			created_at: { kind: 'instant' };
			updated_at: { kind: 'instant' };
			created_by: { kind: 'id'; of: 'sys_user'; optional: true };
			updated_by: { kind: 'id'; of: 'sys_user'; optional: true };
		};
type ColumnsOf<M> = FieldsOf<M> & ComputedOf<M> & SystemColumns<M>;
// Cache concrete columns; keep the original intersection semantics for union names.
type ColumnIndex = { [M in AuthoredModelName | SystemModelName]: ColumnsOf<M> };
/** Every scalar column of `M` by kind: fields, computed values, system columns (FKs are separate: `OneRels`). */
export type Columns<M> =
	IsUnion<M> extends false
		? M extends keyof ColumnIndex
			? ColumnIndex[M]
			: ColumnsOf<M>
		: ColumnsOf<M>;
export type ColumnName<M> = keyof Columns<M> & string;
// Cache the shared own-field map; broad, union and never names retain their original intersection.
type OwnColumnsOf<M> = FieldsOf<M> & ComputedOf<M>;
type OwnColumnIndex = { [M in AuthoredModelName | SystemModelName]: OwnColumnsOf<M> };
type OwnColumns<M> = [M] extends [never]
	? OwnColumnsOf<M>
	: unknown extends M
		? OwnColumnsOf<M>
		: IsUnion<M> extends false
			? M extends keyof OwnColumnIndex
				? OwnColumnIndex[M]
				: OwnColumnsOf<M>
			: OwnColumnsOf<M>;
/** A field name of `M` as author positions use it: own fields, computed values and FKs. */
export type FieldName<M> = (keyof OwnColumns<M> | keyof OneRels<M>) & string;
/** Fields a create/update selection may list: stored, non-derived fields and FKs. */
/** Own and computed fields of `M` of kind `K` (§3.3.10 signature helpers). */
type OfKind<M, K> = KeyFor<OwnColumns<M>, K>;
type NotBtree =
	| { kind: 'json' | 'file' | 'point' | 'vector' | 'period' | 'custom' | 'sum' | 'count' }
	| { many: true };
/** A field a btree index, `key` or `unique` may name: scalar fields and FKs. */
export type BtreeField<M> = Exclude<FieldName<M>, OfKind<M, NotBtree>>;
/** A btree field that is never null (`key`). */
export type RequiredBtreeField<M> = Exclude<
	BtreeField<M>,
	| OfKind<M, { optional: true }>
	| {
			[F in keyof OneRels<M>]: OneRels<M>[F] extends { optional: true } ? F : never;
	  }[keyof OneRels<M>]
>;
/** The `text` fields of model `M`. */
export type TextField<M> = OfKind<M, { kind: 'text' }>;
/** The `period` fields of model `M`. */
export type PeriodField<M> = OfKind<M, { kind: 'period' }>;
/** The `file` fields of model `M`: what `$bolt.upload` names as `'<c>.<field>'`. */
export type FileField<M> = OfKind<M, { kind: 'file' }>;
/** The `vector` fields of model `M`. */
export type VectorField<M> = OfKind<M, { kind: 'vector' }>;
/** The fields of `M` a text search reads: `text` and `enum`. */
export type SearchableField<M> = OfKind<M, { kind: 'text' | 'enum' }>;
/** Fields a read returns only when its `select` names them (a `get` returns them too): json, custom and file. */
export type HeavyField<M> = OfKind<M, { kind: 'json' | 'custom' | 'file' }>;
/** The relation names of model `M`: its FKs and the inverse many-relations. */
export type RelName<M> = RelNameOf<M>;
/** A roll-up path: `<many-relation>.<child field>`. */
export type RelPath<M> = {
	[R in keyof ManyRels<M> & string]: `${R}.${FieldName<ManyRels<M>[R]>}`;
}[keyof ManyRels<M> & string];
export type WritableField<M> = WritableFieldOf<M>;
type WritableFieldOf<M, F = FieldsOf<M>, Keys extends keyof F & string = keyof F & string> = (
	| { [P in Keys]: F[P] extends { kind: 'seq' | 'sum' | 'count' } ? never : P }[Keys]
	| keyof OneRels<M>
) &
	string;

// ── exposure (R1): what a model's `read` admits ──
// a system model is typed by its declaration too (sys_integration's create and update allowlists)
type SpecOf<C> = C extends keyof Exposed
	? Exposed[C]
	: C extends SystemName
		? SystemNames['exposures'][C]
		: { read: { readonly [path: string]: { fields: 'all' } } };
type ReadSpec<C> = SpecOf<C> extends { read: infer R } ? R : never;
type RootSpec<C> = ReadSpec<C> extends infer R ? (C extends keyof R ? R[C] : never) : never;
/** Fields of `C`'s root layer any grant can ever see (system columns always). */
export type ReadField<C> =
	| (RootSpec<C> extends { fields: 'all' }
			? FieldName<C>
			: RootSpec<C> extends { fields: readonly (infer F)[] }
				? F & string
				: never)
	| keyof SystemColumns<C>;
/** The relations path `P` of its root's `read` declares as layers (`'<P>.<rel>'`): the only ones a filter or sort crosses. */
export type LayerRelation<P> =
	ReadPath<RootOf<P>> extends infer K
		? K extends `${P & string}.${infer R}`
			? R extends `${string}.${string}`
				? never
				: R
			: never
		: never;
/**
 * Relations of `C` a `Where` or a sort may cross: the layers its `read` declares, read under the root's policy. A
 * relation it does not declare is a type error, never the target model's own access point.
 */
export type ReadRelation<C> = LayerRelation<C>;
export type ExposureSpecOf<C> = SpecOf<C>;

// ── layer paths (decision 1): generated literal unions, so a path's type is a lookup, never a recursive walk ──
type Layers = NamesPart<'layers'>;
/** The read paths `C` declares: `'<C>'` and each `'<C>.<rel>…'` layer of its `read`. */
export type ReadPath<C> = keyof ReadSpec<C> & string;
type WriteLayers<C, V> = SpecOf<C> extends { [P in V & string]: { columns: infer L } } ? L : {};
/** The write paths `C`'s `create` or `update` declares: `'<C>'` and each child layer of its `columns`. */
export type WritePath<C, V extends 'create' | 'update'> = keyof WriteLayers<C, V> & string;
/** The root of a path: the model before its first dot. */
export type RootOf<P> = P extends `${infer C}.${string}` ? C : P;
/** The model behind path `P` of `C`'s declaration (`'orders.lines'` → `'order_lines'`). */
export type PathModel<C, P> = P extends C
	? C
	: C extends keyof Layers
		? P extends keyof Layers[C]
			? Layers[C][P] & TargetName
			: never
		: never;
type LayerSpec<C, P> = ReadSpec<C> extends infer R ? R[P & keyof R] : never;
/** The fields layer `P` of `C`'s `read` exposes (system columns always): what its `where`, `fields` and output name. */
export type LayerField<C, P> =
	| (LayerSpec<C, P> extends { fields: 'all' }
			? FieldName<PathModel<C, P>>
			: LayerSpec<C, P> extends { fields: readonly (infer F)[] }
				? F & string
				: never)
	| keyof SystemColumns<PathModel<C, P>>;
/** The columns layer `P` of `C`'s `create` or `update` admits. */
export type LayerColumn<C, V extends 'create' | 'update', P> =
	WriteLayers<C, V> extends infer L
		? P extends keyof L
			? L[P] extends readonly (infer F)[]
				? F & string
				: never
			: never
		: never;
/** The columns layer `P` of `C`'s `create` fills when the writer omits them (`create.filled`). */
export type LayerFilled<C, P> =
	SpecOf<C> extends { create: { filled: infer L } }
		? P extends keyof L
			? L[P] extends readonly (infer F)[]
				? F & string
				: never
			: never
		: never;
/** The relation names one segment below `P` among `Paths`: `SubLayer<'o' | 'o.lines' | 'o.lines.product', 'o'>` = `'lines'`. */
export type SubLayer<Paths, P extends string> = Paths extends `${P}.${infer S}`
	? S extends `${string}.${string}`
		? never
		: S
	: never;
/** Every prefix of each path: naming a deep path implies its parents. */
export type Prefixes<P> = P extends `${infer H}.${infer T}` ? H | `${H}.${Prefixes<T>}` : P;
type SyncsOf<C> = SpecOf<C> extends { syncs: infer S } ? S : {};
/** The syncs model `C` declares. */
export type SyncName<C> = keyof SyncsOf<C> & string;
/** File syncs offer import, template and export runs even when they use the built-in adapters. */
export type FileSyncName<C, S = SyncsOf<C>> = {
	[N in keyof S]: S[N] extends { with: 'file' } ? N : never;
}[keyof S] &
	string;
type ReadSyncName<C, S = SyncsOf<C>> = {
	[N in keyof S]: S[N] extends { with: infer W; read: true }
		? W extends 'file'
			? never
			: N
		: never;
}[keyof S] &
	string;
/** A remote sync that reads, as a run a policy's `automations` may start and `bolt.start` runs: `'<model>.sync.<name>'`. */
export type SyncCallable = {
	[C in ModelName]: `${C}.sync.${ReadSyncName<C> | FileSyncName<C>}`;
}[ModelName];

// ── search indexes (`search.indexes` of the models part) ──
type IndexesOf<M> = ModelOf<M> extends { search: { indexes: infer X } } ? X : {};
/** The custom search indexes of model `M`. */
export type IndexName<M> = keyof IndexesOf<M> & string;
/** The fields index `I` of `M` takes as its probe input (`query(m, { search: { [I]: input } })`). */
export type IndexInput<M, I> = IndexesOf<M>[I & keyof IndexesOf<M>] extends { input: infer F }
	? F
	: {};
/** Whether `M` declares `search.semantic`. */
export type HasSemantic<M> = ModelOf<M> extends { search: { semantic: object } } ? true : false;

// ── rows ──
/** The value of one column or FK of `M`. */
export type ColumnValue<M, P> = P extends keyof OneRels<M>
	? FkValue<OneRels<M>[P]>
	: P extends keyof Columns<M>
		? ValueOf<Columns<M>[P]>
		: never;
/** A column an insert may omit: optional, defaulted, or an FK filled from the writer (rule 23a). */
export type OmittableOnInsert<M, P> = P extends keyof OneRels<M>
	? OneRels<M>[P] extends { optional: true } | { default: unknown }
		? true
		: false
	: P extends keyof Columns<M>
		? Columns<M>[P] extends { optional: true } | { default: unknown }
			? true
			: false
		: false;
type ColumnValues<M, P extends PropertyKey, Rels = OneRels<M>> = {
	readonly [K in P & keyof Columns<M>]: ValueOf<Columns<M>[K]>;
} & { readonly [K in P & keyof Rels]: FkValue<Rels[K]> };
declare const masked: unique symbol;
/** A value the reading caller's grants do not admit (rules 10, 14). */
export type Masked = {
	readonly [masked]: true;
	readonly $masked: true;
};
/** The canonical wire marker for a field omitted by the reading caller's grants. */
export const isMasked = (value: unknown): value is Masked =>
	typeof value === 'object' && value !== null && '$masked' in value && value.$masked === true;
// What one grant's read admits on each declared path of `C`: a named layer's `fields`, else 'all' (`read: true` and a
// layer the grant does not name read in full). An identity grant writes `fields` beside `read`.
type PathAdmits<C extends string, G> = G extends { read: unknown; fields: readonly (infer F)[] }
	? { path: C; admits: F }
	: G extends { read: infer R }
		? {
				[P in ReadPath<C>]: {
					path: P;
					admits: R extends object
						? P extends keyof R
							? R[P] extends { fields: readonly (infer F)[] }
								? F
								: 'all'
							: 'all'
						: 'all';
				};
			}[ReadPath<C>]
		: never;
type Policies = NamesPart<'policies'>;
/**
 * Fields of layer `P` of `C` some policy's read grant leaves out: `Value | Masked` to every caller, since any caller may
 * hold it. Only the root's policy masks a layer (decision 3).
 */
export type Maskable<C, P = C> = (P extends Granted ? ReadGrants[P] : never) extends infer X
	? X extends { admits: infer F }
		? 'all' extends F
			? never
			: Exclude<LayerField<C, P>, F | keyof SystemColumns<PathModel<C, P>>>
		: never
	: never;
// Every policy's read grants grouped by path in one scan, `{ admits }` per grant: scanning every policy for each
// model was quadratic in the workspace. A path names its root, so paths of different roots never collide.
type ReadGrants = { [X in GrantOf<keyof Policies> as X['path']]: { admits: X['admits'] } };
type GrantOf<P> = P extends keyof Policies
	? Policies[P] extends { grants: infer G }
		? { [C in keyof G & string]: PathAdmits<C, G[C]> }[keyof G & string]
		: never
	: never;
type Granted = keyof ReadGrants;
/** A caller's value of column or FK `F` on layer `P` of `C`, masked by the root's policies. */
export type LayerValue<C, P, F> =
	F extends Maskable<C, P>
		? ColumnValue<PathModel<C, P>, F> | Masked
		: ColumnValue<PathModel<C, P>, F>;
/** A caller's row of model `C`: its exposed fields (maskable ones `| Masked`), FK ids and system columns (rule 10). */
export type Row<C> = RowOf<C> & RowState;
/** What a read, the caller's or the workspace's, attaches to each root row beside its fields, whatever it selects (§4.2, rule 46b). */
export type RowState = {
	readonly $sync?: { readonly [sync: string]: SyncState };
	readonly $approval?: RowApproval;
};
/**
 * A record an open approval request holds (rule 46b): its request, `Pending` at `step` (from 0) of its named `steps` (each
 * decided by its teams or users) or `ChangesRequested`, and who asked. Absent once the request closes.
 */
export type RowApproval = {
	readonly requestId: string;
	readonly state: 'Pending' | 'ChangesRequested';
	readonly step: number;
	readonly steps: readonly ApprovalStep[];
	readonly requestedBy: string;
};
/** Where a row's latest change stands with one write sync (`$sync.<name>`): queued, acknowledged, or refused with `message`. */
export type SyncState = {
	readonly status: 'pending' | 'ok' | 'failed';
	readonly message?: string;
};
type RowOf<C, Mask = Maskable<C>> = Simplify<{
	readonly [P in ReadField<C> & (keyof Columns<C> | keyof OneRels<C>)]: P extends Mask
		? ColumnValue<C, P> | Masked
		: ColumnValue<C, P>;
}>;
/** A stored row as write callbacks see it (`before`, `delete.check`'s rows, `ctx.db`): never masked, every stored field,
 * no seq, roll-up or computed (rule 10). */
export type StoredRow<M> = Simplify<ColumnValues<M, WritableField<M> | keyof SystemColumns<M>>>;
