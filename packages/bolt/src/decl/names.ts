// The names index (§3.1, rule 8). `.norbital/names.ts` augments `Names` with each path-derived name mapped to
// `typeof import('<path>').default`; every cross-file type below is read from it, so it is never stale for content.
import type { SystemNames } from '../system/index.ts';
import type { BuiltinFields } from './builtin-fields.ts';
import type { FieldKind, KeyFor, Simplify, ValueOf } from './fields.ts';
import type { NullableOfExpr } from './model.ts';
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
	models: {
		[model: string]: {
			fields: { readonly [f: string]: FieldKind };
			computed?: object;
			key?: readonly string[];
			unique?: readonly object[];
		};
	};
	relationships: { [key: `${string}.${string}`]: RelationshipSpec };
	collections: { [collection: string]: { spec: object } };
	/** Each `src/integration/<name>/+integration.ts`: the workspace's definitions (bolt's own are `SystemNames`). */
	integrations: { [integration: string]: unknown };
	/** Each feed target → the feed that writes it (`<definition>.<feed>`), a generated literal. */
	fed: { [collection: string]: string };
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
 * One relationship in `+relationship.ts`: its target (`to`), the `inverse` many-relation name, `optional`, a default from the actor,
 * `onDelete`, `owned` children and a `where` on the target.
 */
export type RelationshipSpec = {
	to: string | readonly string[];
	inverse?: string;
	optional?: true;
	default?: { actor: 'id' | 'party' };
	onDelete?: 'restrict' | 'cascade' | 'setNull';
	owned?: true;
	where?: object;
};

// The built-in layer (`src/system/**`, X-18): its models and relationships are declared as a workspace's are and typed
// from their declarations. Its collections are the system collection names; its private models (sys_session,
// sys_challenge, sys_config) are no collection, so no author position names them.
type SystemModels = SystemNames['models'];
/** A built-in layer model: a system collection's, or one of the engine's private models. */
export type SystemModelName = keyof SystemModels & string;
/** The system collections (X-18). */
export type SystemName = keyof SystemNames['collections'] & string;

type Models = NamesPart<'models'>;
type Colls = NamesPart<'collections'>;

/** An authored model (`src/data/model/+<m>.model.ts`). */
export type ModelName = keyof Models & string;
/** Anything a relationship or an `Id<>` may name: authored models and system collections. */
export type TargetName = ModelName | SystemName;
/** Every surface addresses collections (P9): authored ones, plus the system collections. */
export type CollectionName = (keyof Colls & string) | SystemName;
/** Ledgers (X-18): an `Id<>` target, never granted, read by server code, written or triggered on. */
export type Ledger = 'sys_run';
/** A collection a trigger or a read may name: every collection but the ledgers. */
export type ReadableName = Exclude<CollectionName, Ledger>;
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
/** The collections a feed writes. */
export type FedName = keyof NamesPart<'fed'> & string;
/** The MCP server names (`src/agent/mcp/+<n>.mcp.ts`). */
export type McpName = keyof NamesPart<'mcp'> & string;
/** The agent skill names (`src/agent/skill/+<n>.skill.md`). */
export type SkillName = keyof NamesPart<'skills'> & string;
/** The host tools a policy's `capabilities.tools` may name (the host's Studio and browser tools). */
export type HostToolName = keyof NamesPart<'hostTools'> & string;
export type CustomShape<F> = F extends keyof CustomFields
	? CustomFields[F] extends { spec: { shape: infer S } }
		? S
		: never
	: never;

type ModelOf<M> = M extends ModelName
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
 * or collection spec, and a constraint over the whole names index made TS expand every collection for each literal
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
// source on every read. Each view is conditional on `M`, so a generic `M` defers it: model literals feed the
// relationships file, whose literal is checked against models, and an eager read of the relationships here would close
// that loop.
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
/** The FK field on the child that a many-relation of `M` runs through. */
export type ManyRelFk<M, I> = ManyRelFkOf<M, I>;
type ManyRelFkOf<M, I, Keys = ManyRelKeys<M>> = I extends keyof Keys
	? Keys[I] extends `${string}.${infer F}`
		? F
		: never
	: never;
export type OneTarget<M, R> = OneTargetOf<M, R>;
type OneTargetOf<M, R, Targets = View<M>['target']> = R extends keyof Targets
	? Targets[R] & string
	: never;
export type RelTarget<M, R> = R extends keyof OneRels<M>
	? OneTarget<M, R>
	: R extends keyof ManyRels<M>
		? ManyRels<M>[R]
		: never;
/** Inverse names declared by more than one relationship onto `M` (checked by `Verify`). */
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
type ColumnIndex = { [M in ModelName | SystemModelName]: ColumnsOf<M> };
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
type OwnColumnIndex = { [M in ModelName | SystemModelName]: OwnColumnsOf<M> };
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

// ── collection exposure (R1): what a collection's `read` admits ──
// a system collection is typed by its declaration too (sys_integration's create and update allowlists)
type SpecOf<C> = C extends keyof Colls
	? Colls[C] extends { spec: infer S }
		? S
		: never
	: C extends SystemName
		? SystemNames['collections'][C] extends { spec: infer S }
			? S
			: never
		: { read: { fields: 'all' } };
type ReadSpec<C> = SpecOf<C> extends { read: infer R } ? R : never;
/** Fields of `C` any grant can ever see (system columns always). */
export type ReadField<C> =
	| (ReadSpec<C> extends { fields: 'all' }
			? FieldName<C>
			: ReadSpec<C> extends { fields: readonly (infer F)[] }
				? F & string
				: never)
	| keyof SystemColumns<C>;
/** Relations of `C` a Where, a select or a view may cross. */
export type ReadRelation<C> =
	ReadSpec<C> extends { relations: 'all' }
		? RelNameOf<C>
		: ReadSpec<C> extends { relations: readonly (infer R)[] }
			? R & string
			: ReadSpec<C> extends { fields: 'all' }
				? RelNameOf<C>
				: never;
export type CollectionSpecOf<C> = SpecOf<C>;

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
export interface Masked {
	readonly [masked]: true;
}
/** The canonical wire marker for a field omitted by the reading caller's grants. */
export const isMasked = (value: unknown): value is Masked =>
	typeof value === 'object' && value !== null && '$masked' in value && value.$masked === true;
// What one grant's read admits: its `fields`, or 'all'. An identity grant writes `fields` beside `read`.
type Admits<G> = G extends
	{ read: { fields: readonly (infer F)[] } } | { read: unknown; fields: readonly (infer F)[] }
	? F
	: 'all';
type Policies = NamesPart<'policies'>;
/** Fields of `C` some policy's read grant leaves out: `Value | Masked` to every caller, since any caller may hold it. */
type Maskable<C> = (C extends Granted ? ReadGrants[C] : never) extends infer X
	? X extends { admits: infer F }
		? 'all' extends F
			? never
			: Exclude<ReadField<C>, F | keyof SystemColumns<C>>
		: never
	: never;
// Every policy's read grants grouped by collection in one scan, `{ admits }` per grant: scanning every policy for each
// collection was quadratic in the workspace.
type ReadGrants = { [X in GrantOf<keyof Policies> as X['c']]: { admits: X['admits'] } };
type GrantOf<P> = P extends keyof Policies
	? Policies[P] extends { grants: infer G }
		? { [C in keyof G & string]: { c: C; admits: Admits<G[C]> } }[keyof G & string]
		: never
	: never;
type Granted = keyof ReadGrants;
/** A caller's value of column or FK `P` of `C`. */
export type CallerValue<C, P> =
	P extends Maskable<C> ? ColumnValue<C, P> | Masked : ColumnValue<C, P>;
/** A caller's row of collection `C`: its exposed fields (maskable ones `| Masked`), FK ids and system columns (rule 10). */
export type Row<C> = RowOf<C> & RowState;
/** What a caller's read attaches to each root row beside its fields, whatever it selects (§4.2, rule 46b). */
export type RowState = {
	readonly $outbound?: { readonly [rule: string]: OutboundState };
	readonly $approval?: RowApproval;
};
/**
 * A record an open approval request holds (rule 46b): its request, `Pending` at `step` (from 0) of `steps` or
 * `ChangesRequested`, who asked and whom it waits on. Absent once the request closes.
 */
export type RowApproval = {
	readonly requestId: string;
	readonly state: 'Pending' | 'ChangesRequested';
	readonly step: number;
	readonly steps: number;
	readonly requestedBy: string;
	readonly waitingOn: readonly string[];
};
/** Where the latest send of an outbound rule (`<definition>.<rule>`) for a row stands. */
export type OutboundState = {
	readonly status: 'queued' | 'sending' | 'sent' | 'skipped' | 'failed' | 'uncertain';
	readonly error: string | null;
};
type RowOf<C, Mask = Maskable<C>> = Simplify<{
	readonly [P in ReadField<C> & (keyof Columns<C> | keyof OneRels<C>)]: P extends Mask
		? ColumnValue<C, P> | Masked
		: ColumnValue<C, P>;
}>;
/** A transform's row (`ctx.existing`, `ctx.db`): never masked, all stored fields, no seq, roll-up or computed (rule 10). */
export type StoredRow<M> = Simplify<ColumnValues<M, WritableField<M> | keyof SystemColumns<M>>>;
export type WorkspaceReadField<M> = (
	WritableField<M> | OfKind<M, { kind: 'seq' }> | keyof SystemColumns<M>
) &
	(keyof Columns<M> | keyof OneRels<M>);
/** Explicit workspace projections also admit existing engine-assigned sequence labels; never roll-ups or computed fields. */
export type WorkspaceReadRow<M> = Simplify<ColumnValues<M, WorkspaceReadField<M>>>;
