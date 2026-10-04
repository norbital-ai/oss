// The names index (§3.1, rule 8). `.norbital/names.ts` augments `Names` with each path-derived name mapped to
// `typeof import('<path>').default`; every cross-file type below is read from it, so it is never stale for content.
import type { SystemNames } from '../system/index.ts';
import type { BuiltinFields } from './builtin-fields.ts';
import type { FieldKind, Simplify, ValueOf } from './fields.ts';
import type { CurrencyCode, Id, RecordRef } from './values.ts';

/** Augmented by the generated `.norbital/names.ts`: `declare module '@norbital-ai/bolt' { interface Names { … } }`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface Names {}

/** What the compiler writes into `Names`. Every part is optional: an absent part means "none declared". */
export type NamesShape = {
	workspace: { currency?: CurrencyCode; env?: { readonly [name: string]: unknown } };
	models: { [model: string]: { fields: { readonly [f: string]: FieldKind }; computed?: object; key?: readonly string[]; unique?: readonly object[] } };
	relationships: { [key: `${string}.${string}`]: RelationshipSpec };
	collections: { [collection: string]: { spec: object } };
	/** Each collection's integration direction, a generated literal (P14); absent = no integration. */
	integrations: { [collection: string]: 'one_way' | 'two_way' };
	customFields: { [field: string]: { spec: { shape: unknown } } };
	teams: { [team: string]: unknown };
	/** The base catalogue `src/i18n/+messages.ts`: its keys are the message keys. */
	messages: { [key: string]: string };
	/** Each `src/i18n/+<locale>.messages.ts`: its keys must be the base's (checked by `Verify`). */
	locales: { [locale: string]: { [key: string]: string } };
	policies: { [policy: string]: unknown };
	channelTypes: { [type: string]: unknown };
	apps: { [app: string]: unknown };
	automations: { [automation: string]: unknown };
	mcp: { [server: string]: unknown };
	skills: { [skill: string]: unknown };
	connections: { [connection: string]: unknown };
	/** Each app (its folder path) → the union of its `+<page>.page.svelte` names. */
	pages: { [app: string]: string };
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
	to: string | readonly string[]; inverse?: string; optional?: true; default?: { actor: 'id' | 'party' };
	onDelete?: 'restrict' | 'cascade' | 'setNull'; owned?: true; where?: object;
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

/** An authored model (`src/data/model/<m>/+model.ts`). */
export type ModelName = keyof Models & string;
/** Anything a relationship or an `Id<>` may name: authored models and system collections. */
export type TargetName = ModelName | SystemName;
/** Every surface addresses collections (P9): authored ones, plus the system collections. */
export type CollectionName = (keyof Colls & string) | SystemName;
/** Ledgers (X-18): an `Id<>` target, never granted, read by server code, written or triggered on. */
export type Ledger = 'sys_run' | 'sys_event';
export type ReadableName = Exclude<CollectionName, Ledger>;
/** Every custom field: the built-ins (`money`, `file`, `point`, `phone`) and the workspace's (`src/data/custom_field/<f>/`), one namespace. */
type CustomFields = BuiltinFields & NamesPart<'customFields'>;
/** A custom field name a model may store as `{ kind: 'custom', of }`: a built-in's or the workspace's own. */
export type CustomFieldName = keyof CustomFields & string;
/** The team names `+team.ts` declares. */
export type TeamName = keyof NamesPart<'teams'> & string;
/** The policy names (`src/access/+<name>.policy.ts`). */
export type PolicyName = keyof NamesPart<'policies'> & string;
/** Runtime channel connection identifiers (`sys_channel_connection`). */
export type ChannelName = string;
/** A channel a person is notified on: a runtime connection or the built-in `inbox`. */
export type PersonChannelName = 'inbox' | ChannelName;
/** The app names (`src/app/<a>/+app.ts`). */
export type AppName = keyof NamesPart<'apps'> & string;
/** The automation names (`src/automation/+<a>.automation.ts`). */
export type AutomationName = keyof NamesPart<'automations'> & string;
/** Runtime envoy identifiers (`sys_envoy`). */
export type EnvoyName = string;
/** The MCP server names (`src/agent/mcp/+<n>.mcp.ts`). */
export type McpName = keyof NamesPart<'mcp'> & string;
/** The agent skill names (`src/agent/skill/+<n>.skill.md`). */
export type SkillName = keyof NamesPart<'skills'> & string;
/** The host tools a policy's `capabilities.tools` may name (the host's Studio and browser tools). */
export type HostToolName = keyof NamesPart<'hostTools'> & string;
export type CustomShape<F> = F extends keyof CustomFields ? CustomFields[F] extends { spec: { shape: infer S } } ? S : never : never;
export type Direction<C> = C extends keyof NamesPart<'integrations'> ? NamesPart<'integrations'>[C] : 'none';

type ModelOf<M> = M extends ModelName ? Models[M] : M extends SystemModelName ? SystemModels[M] : never;
type FieldsOf<M> = ModelOf<M> extends { fields: infer F } ? F : {};
type ComputedOf<M> = ModelOf<M> extends { computed: infer C } ? { [P in keyof C]: C[P] extends { kind: infer K } ? { kind: K } : never } : {};

/** A name parameter's check. Name parameters are constrained to `string` and checked through `Is<N, Names>`: while a
 * call is inferred, its literal arguments are typed against the uninstantiated `Where<C>`, `Select<C>`, `ActInput<N>`
 * or collection spec, and a constraint over the whole names index made TS expand every collection for each literal
 * (G1 scale fixture: ~40 ms per nested literal). */
export type Is<N, Names> = N extends Names ? N : Names;

// ── relationships ──
type TargetsOf<R> = R extends { to: infer T } ? T extends readonly (infer A)[] ? A : T : never;
// The relationship views are built once per workspace and read by indexed access (G1 scale fixture: they were ~10M of
// 16M instantiations). Two global scans group the relationship keys by source and by target; each model's view is a
// property of `RelIndex`, instantiated once and kept (an alias re-instantiates its defaults on every reference). A view
// is a mapped type over a key union, so `keyof` it is that union: `keyof` a mapped type with an `as` clause re-scans its
// source on every read. Each view is conditional on `M`, so a generic `M` defers it: model literals feed the
// relationships file, whose literal is checked against models, and an eager read of the relationships here would close
// that loop.
type AllRels = NamesPart<'relationships'> & SystemNames['relationships'];
type BySource = { [K in keyof AllRels as K extends `${infer S}.${string}` ? S : never]: K };
type ByTarget = { [K in keyof AllRels as AllRels[K] extends { inverse: string } ? TargetsOf<AllRels[K]> & string : never]: K };
type Sources = keyof BySource;
type Targets = keyof ByTarget;
type RelView<M,
	Own = M extends Sources ? BySource[M] : never,
	One extends string = Own extends `${string}.${infer F}` ? F : never,
	// inverse name → the relationship key it runs back through (a union when declared twice)
	Back = M extends Targets ? { [K in ByTarget[M] & keyof AllRels as AllRels[K] extends { inverse: infer I extends string } ? I : never]: K } : {},
	Many extends string = keyof Back & string
> = {
	one: { [F in One]: AllRels[`${M & string}.${F}` & keyof AllRels] };
	// `& TargetName` here, once: a literal intersected with the names union is a union built per use
	target: { [F in One]: TargetsOf<AllRels[`${M & string}.${F}` & keyof AllRels]> & TargetName };
	keys: { [I in Many]: Back[I & keyof Back] };
	many: { [I in Many]: Back[I & keyof Back] extends `${infer S}.${string}` ? S & TargetName : never };
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
export type ManyRelFk<M, I> = I extends keyof ManyRelKeys<M> ? ManyRelKeys<M>[I] extends `${string}.${infer F}` ? F : never : never;
export type OneTarget<M, R> = R extends keyof OneRels<M> ? View<M>['target'][R & keyof View<M>['target']] & string : never;
export type RelTarget<M, R> = R extends keyof OneRels<M> ? OneTarget<M, R> : R extends keyof ManyRels<M> ? ManyRels<M>[R] : never;
/** Inverse names declared by more than one relationship onto `M` (checked by `Verify`). */
export type DuplicateInverse<M> = { [I in keyof ManyRelKeys<M>]: IsUnion<ManyRelKeys<M>[I]> extends true ? I : never }[keyof ManyRelKeys<M>] & string;
/** FKs of `M` to an owning parent: set on create, never updated (rule 41). */
export type OwnedFk<M> = { [F in keyof OneRels<M>]: OneRels<M>[F] extends { owned: true } ? F : never }[keyof OneRels<M>] & string;
/** Inverse names on `M` of owned children (composition). */
export type OwnedInverse<M> = { [I in keyof ManyRelKeys<M>]: AllRels[ManyRelKeys<M>[I] & keyof AllRels] extends { owned: true } ? I : never }[keyof ManyRelKeys<M>] & string;
export type RelNameOf<M> = (keyof OneRels<M> | keyof ManyRels<M>) & string;
type FkValue<R> = (TargetsOf<R> extends infer T extends string ? [T] extends [TargetName] ? IsUnion<T> extends true ? RecordRef<T> : Id<T> : never : never)
	| (R extends { optional: true } ? null : never);
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

// ── columns ──
/** Read-only system columns on every workspace row (§3.3.9); a built-in layer row has its key alone (`table`). */
export type SystemColumns<M> = M extends SystemModelName ? { id: { kind: 'id'; of: M & string } } : {
	id: { kind: 'id'; of: M & string }; revision: { kind: 'int' }; approval_id: { kind: 'text'; optional: true };
	created_at: { kind: 'instant' }; updated_at: { kind: 'instant' };
	created_by: { kind: 'id'; of: 'sys_user'; optional: true }; updated_by: { kind: 'id'; of: 'sys_user'; optional: true };
};
/** Every scalar column of `M` by kind: fields, computed values, system columns (FKs are separate: `OneRels`). */
export type Columns<M> = FieldsOf<M> & ComputedOf<M> & SystemColumns<M>;
export type ColumnName<M> = keyof Columns<M> & string;
/** A field name of `M` as author positions use it: own fields, computed values and FKs. */
export type FieldName<M> = (keyof FieldsOf<M> | keyof ComputedOf<M> | keyof OneRels<M>) & string;
/** Fields a create/update selection may list: stored, non-derived fields and FKs. */
/** Own and computed fields of `M` of kind `K` (§3.3.10 signature helpers). */
type OfKind<M, K> = { [P in keyof (FieldsOf<M> & ComputedOf<M>)]: (FieldsOf<M> & ComputedOf<M>)[P] extends K ? P : never }[keyof (FieldsOf<M> & ComputedOf<M>)] & string;
type NotBtree = { kind: 'json' | 'file' | 'point' | 'vector' | 'period' | 'custom' | 'sum' | 'count' } | { many: true };
/** A field a btree index, `key` or `unique` may name: scalar fields and FKs. */
export type BtreeField<M> = Exclude<FieldName<M>, OfKind<M, NotBtree>>;
/** A btree field that is never null (`key`). */
export type RequiredBtreeField<M> = Exclude<BtreeField<M>, OfKind<M, { optional: true }>
	| { [F in keyof OneRels<M>]: OneRels<M>[F] extends { optional: true } ? F : never }[keyof OneRels<M>]>;
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
export type RelPath<M> = { [R in keyof ManyRels<M> & string]: `${R}.${FieldName<ManyRels<M>[R]>}` }[keyof ManyRels<M> & string];
export type WritableField<M> = ({ [P in keyof FieldsOf<M> & string]: FieldsOf<M>[P] extends { kind: 'seq' | 'sum' | 'count' } ? never : P }[keyof FieldsOf<M> & string]
	| keyof OneRels<M>) & string;

// ── collection exposure (R1): what a collection's `read` admits ──
type SpecOf<C> = C extends keyof Colls ? Colls[C] extends { spec: infer S } ? S : never : { read: { fields: 'all' } };
type ReadSpec<C> = SpecOf<C> extends { read: infer R } ? R : never;
/** Fields of `C` any grant can ever see (system columns always). */
export type ReadField<C> = (ReadSpec<C> extends { fields: 'all' } ? FieldName<C> : ReadSpec<C> extends { fields: readonly (infer F)[] } ? F & string : never)
	| keyof SystemColumns<C>;
/** Relations of `C` a Where, a select or a view may cross. */
export type ReadRelation<C> = ReadSpec<C> extends { relations: 'all' } ? RelNameOf<C>
	: ReadSpec<C> extends { relations: readonly (infer R)[] } ? R & string
	: ReadSpec<C> extends { fields: 'all' } ? RelNameOf<C> : never;
export type CollectionSpecOf<C> = SpecOf<C>;

// ── rows ──
/** The value of one column or FK of `M`. */
export type ColumnValue<M, P> = P extends keyof OneRels<M> ? FkValue<OneRels<M>[P]> : P extends keyof Columns<M> ? ValueOf<Columns<M>[P]> : never;
/** A column an insert may omit: optional, defaulted, or an FK filled from the writer (rule 23a). */
export type OmittableOnInsert<M, P> = P extends keyof OneRels<M> ? OneRels<M>[P] extends { optional: true } | { default: unknown } ? true : false
	: P extends keyof Columns<M> ? Columns<M>[P] extends { optional: true } | { default: unknown } ? true : false : false;
type ColumnValues<M, P extends PropertyKey> = { readonly [K in P & keyof Columns<M>]: ValueOf<Columns<M>[K]> }
	& { readonly [K in P & keyof OneRels<M>]: FkValue<OneRels<M>[K]> };
declare const masked: unique symbol;
/** A value the reading caller's grants do not admit (rules 10, 14). */
export interface Masked { readonly [masked]: true }
// What one grant's read admits: its `fields`, or 'all'. An identity grant writes `fields` beside `read`.
type Admits<G> = G extends { read: { fields: readonly (infer F)[] } } | { read: unknown; fields: readonly (infer F)[] } ? F : 'all';
type Policies = NamesPart<'policies'>;
/** Fields of `C` some policy's read grant leaves out: `Value | Masked` to every caller, since any caller may hold it. */
export type Maskable<C> = (C extends Granted ? ReadGrants[C] : never) extends infer X
	? X extends { admits: infer F } ? 'all' extends F ? never : Exclude<ReadField<C>, F | keyof SystemColumns<C>> : never : never;
// Every policy's read grants grouped by collection in one scan, `{ admits }` per grant: scanning every policy for each
// collection was quadratic in the workspace.
type ReadGrants = { [X in GrantOf<keyof Policies> as X['c']]: { admits: X['admits'] } };
type GrantOf<P> = P extends keyof Policies ? Policies[P] extends { grants: infer G }
	? { [C in keyof G & string]: { c: C; admits: Admits<G[C]> } }[keyof G & string] : never : never;
type Granted = keyof ReadGrants;
/** A caller's value of column or FK `P` of `C`. */
export type CallerValue<C, P> = P extends Maskable<C> ? ColumnValue<C, P> | Masked : ColumnValue<C, P>;
/** A caller's row of collection `C`: its exposed fields (maskable ones `| Masked`), FK ids and system columns (rule 10). */
export type Row<C> = Simplify<{ readonly [P in ReadField<C> & (keyof Columns<C> | keyof OneRels<C>)]: CallerValue<C, P> }>;
/** A transform's row (`ctx.existing`, `ctx.db`): never masked, all stored fields, no seq, roll-up or computed (rule 10). */
export type StoredRow<M> = Simplify<ColumnValues<M, WritableField<M> | keyof SystemColumns<M>>>;
