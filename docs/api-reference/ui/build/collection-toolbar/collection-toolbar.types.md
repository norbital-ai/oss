[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-toolbar/collection-toolbar.types

# ui/build/collection-toolbar/collection-toolbar.types

## Interfaces

<a id="collectionactiontoolbarprops"></a>

### CollectionActionToolbarProps

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:126

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) | - |
| `TName` *extends* [`CollectionToolbarName`](/docs/api-reference/ui/build/collection-toolbar/collection-toolbar.types.md#collectiontoolbarname)\<`TCollections`\> | - |
| `TRow` *extends* `object` | [`CollectionRow`](/docs/api-reference/std/build/collection.md#collectionrow)\<`TCollections`\[`TName`\]\> |

#### Properties

<a id="about"></a>

##### about?

```ts
optional about?: CollectionToolbarAbout;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:137

<a id="actions"></a>

##### actions?

```ts
optional actions?: Snippet<[CollectionToolbarComposition<NoInfer<TRow>>]>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:153

Mutating actions, placed at the trailing edge.

<a id="client"></a>

##### client

```ts
client: CollectionDbClient<TCollections>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:127

<a id="collection"></a>

##### collection

```ts
collection: TName;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:128

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:143

<a id="features"></a>

##### features?

```ts
optional features?: CollectionToolbarFeatures;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:144

<a id="filterpersistencekey"></a>

##### filterPersistenceKey?

```ts
optional filterPersistenceKey?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:148

View key a cleared seed is remembered against.

<a id="filters"></a>

##### filters?

```ts
optional filters?: Snippet<[CollectionToolbarComposition<NoInfer<TRow>>]>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:151

Derived-predicate controls, placed in the filter popover above the builder.

<a id="initialfilters"></a>

##### initialFilters?

```ts
optional initialFilters?: readonly CollectionTableInitialFilter[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:146

Conditions the view opens with, seeded into the builder as removable rows.

<a id="navigation"></a>

##### navigation?

```ts
optional navigation?: Snippet<[]>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:142

The scope the surface is pinned to and can step through — a month, a period, a legal entity.
Placed at the leading edge, before search, on every surface.

<a id="operations"></a>

##### operations?

```ts
optional operations?: CollectionToolbarOperations<NoInfer<TRow>>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:149

<a id="query"></a>

##### query

```ts
query: CollectionQueryState<TRow>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:135

The query model the search box and the filter popover write to.

Owned by the surface rather than the toolbar, because the surface is what runs the query. The
filter paths a surface may set are checked against the row type this state was created with.

<a id="title"></a>

##### title?

```ts
optional title?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:136

***

<a id="collectiontoolbarabout"></a>

### CollectionToolbarAbout

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:104

What the view applies on the operator's behalf, shown behind the toolbar's info button.

#### Properties

<a id="applied"></a>

##### applied?

```ts
readonly optional applied?: readonly string[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:107

Conditions the view pins that the operator cannot see in the filter builder.

<a id="appliedcontent"></a>

##### appliedContent?

```ts
readonly optional appliedContent?: Snippet<[]>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:109

Schema-aware rendering for pinned conditions whose values are not plain text.

<a id="description"></a>

##### description?

```ts
readonly optional description?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:105

***

<a id="collectiontoolbaractionprops"></a>

### CollectionToolbarActionProps

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:64

#### Properties

<a id="icon"></a>

##### icon?

```ts
optional icon?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:67

Iconify name. With `iconOnly`, the label becomes the accessible name.

<a id="icononly"></a>

##### iconOnly?

```ts
optional iconOnly?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:68

<a id="label"></a>

##### label

```ts
label: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:65

<a id="onrun"></a>

##### onRun

```ts
onRun: () => void | Effect<void, unknown, never>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:82

###### Returns

`void` \| `Effect`\<`void`, `unknown`, `never`\>

<a id="pending"></a>

##### pending?

```ts
optional pending?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:71

Shows a spinner and refuses re-entry while the action is in flight.

<a id="unavailable"></a>

##### unavailable?

```ts
optional unavailable?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:81

Why this action cannot be run right now, in the operator's words.

A refusal is a fact about the record, not about the button: "the month is published, so it
cannot take an import" is the same sentence whether the operator reads it from the toolbar or
from the pipeline panel. Given here it disables the control *and* states the reason where
both a pointer and a screen reader reach it — a `title` attribute does neither reliably, and
a bare disabled button leaves the operator guessing which precondition they missed.

<a id="variant"></a>

##### variant?

```ts
optional variant?: CollectionToolbarActionVariant;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:69

***

<a id="collectiontoolbarcomposition"></a>

### CollectionToolbarComposition

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:120

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="action"></a>

##### Action

```ts
Action: Component<CollectionToolbarActionProps>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:122

<a id="filter"></a>

##### Filter

```ts
Filter: CollectionToolbarFilterComponent;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:121

<a id="query-1"></a>

##### query

```ts
query: CollectionQueryState<TRow>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:124

The one search + filter + page model this toolbar drives.

***

<a id="collectiontoolbarfeatures"></a>

### CollectionToolbarFeatures

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:111

#### Properties

<a id="filter-1"></a>

##### filter?

```ts
readonly optional filter?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:118

The schema-derived filter builder. Declared `Filter` controls are unaffected — a surface whose
conditions are all derived turns the builder off and still gets the filter popover.

<a id="search"></a>

##### search?

```ts
readonly optional search?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:113

Free-text search over the collection's text fields.

***

<a id="collectiontoolbarfiltercomponent"></a>

### CollectionToolbarFilterComponent()

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:44

`Filter` as handed to the toolbar's filter composition. Callable (the Svelte 5 component shape) so
svelte-check accepts it as a component; the generic lets each usage instantiate `TValue` from
`options` so `value` and `onValueChange` stay tied to the same union.

```ts
CollectionToolbarFilterComponent<TValue>(
   this,
   internals,
   props): object;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:45

`Filter` as handed to the toolbar's filter composition. Callable (the Svelte 5 component shape) so
svelte-check accepts it as a component; the generic lets each usage instantiate `TValue` from
`options` so `value` and `onValueChange` stay tied to the same union.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TValue` *extends* `string` | `string` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `void` |
| `internals` | `Brand` |
| `props` | [`CollectionToolbarFilterProps`](/docs/api-reference/ui/build/collection-toolbar/collection-toolbar.types.md#collectiontoolbarfilterprops)\<`TValue`\> |

#### Returns

`object`

##### $on()?

```ts
optional $on(type, callback): () => void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `type` | `string` |
| `callback` | (`e`) => `void` |

###### Returns

() => `void`

##### $set()?

```ts
optional $set(props): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | `Partial`\<[`CollectionToolbarFilterProps`](/docs/api-reference/ui/build/collection-toolbar/collection-toolbar.types.md#collectiontoolbarfilterprops)\<`TValue`\>\> |

###### Returns

`void`

#### Properties

<a id="element"></a>

##### element?

```ts
optional element?: () => HTMLElement;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:49

###### Returns

`HTMLElement`

<a id="z_bindings"></a>

##### z\_$$bindings?

```ts
optional z_$$bindings?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:50

***

<a id="collectiontoolbarfilterdeclaration"></a>

### CollectionToolbarFilterDeclaration

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:53

A registered `Filter`, with its authored props kept live by getters.

#### Properties

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:54

<a id="label-1"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:55

<a id="options"></a>

##### options

```ts
readonly options: readonly CollectionToolbarFilterOption<string>[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:56

<a id="placeholder"></a>

##### placeholder?

```ts
readonly optional placeholder?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:58

<a id="searchable"></a>

##### searchable?

```ts
readonly optional searchable?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:60

<a id="searchplaceholder"></a>

##### searchPlaceholder?

```ts
readonly optional searchPlaceholder?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:59

<a id="value"></a>

##### value

```ts
readonly value: string | null;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:57

#### Methods

<a id="change"></a>

##### change()

```ts
change(value): void;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:61

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` \| `null` |

###### Returns

`void`

***

<a id="collectiontoolbarfilteroption"></a>

### CollectionToolbarFilterOption

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:7

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TValue` *extends* `string` | `string` |

#### Properties

<a id="description-1"></a>

##### description?

```ts
readonly optional description?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:10

<a id="label-2"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:9

<a id="search_term"></a>

##### search\_term?

```ts
readonly optional search_term?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:12

Extra text a searchable control matches on, beyond the label.

<a id="value-1"></a>

##### value

```ts
readonly value: TValue;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:8

***

<a id="collectiontoolbarfilterprops"></a>

### CollectionToolbarFilterProps

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:27

A filter control for a predicate the collection has no field for.

The schema filter builder can only address what the collection stores. A surface that derives its
own facts — "this person has a day rostered on shift N", "this month is still drafted" — has
nothing for the builder to point at, and every such surface has so far grown its own popover, its
own active-count badge and its own "clear all". Declaring the control instead puts it in the same
popover, under the same count, cleared by the same button, and resets the page on change like
every other narrowing does.

`TValue` is inferred from `options`, so `onValueChange` receives the surface's own union rather
than a bare `string` it has to re-narrow.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TValue` *extends* `string` | `string` |

#### Properties

<a id="id-1"></a>

##### id

```ts
id: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:29

Stable identity for the control, used to key it and to label its combobox.

<a id="label-3"></a>

##### label

```ts
label: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:30

<a id="onvaluechange"></a>

##### onValueChange

```ts
onValueChange: (value) => void;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:37

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `TValue` \| `null` |

###### Returns

`void`

<a id="options-1"></a>

##### options

```ts
options: readonly CollectionToolbarFilterOption<TValue>[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:31

<a id="placeholder-1"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:34

Shown when nothing is selected; reads as the unfiltered case ("Any status").

<a id="searchable-1"></a>

##### searchable?

```ts
optional searchable?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:36

<a id="searchplaceholder-1"></a>

##### searchPlaceholder?

```ts
optional searchPlaceholder?: string;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:35

<a id="value-2"></a>

##### value

```ts
value: TValue | null;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:32

***

<a id="collectiontoolbaroperations"></a>

### CollectionToolbarOperations

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:90

Import, export and integrations, as the shared operations menu takes them.

`fields` is deliberately absent: the toolbar has the client and the collection name, so it reads
the field list from the same definition the filter builder does.

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Properties

<a id="disabled-1"></a>

##### disabled?

```ts
readonly optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:101

Refuses the menu on its own without taking search and filters down with it.

<a id="exportpipelines"></a>

##### exportPipelines?

```ts
readonly optional exportPipelines?: readonly CollectionTablePipeline<TRow>[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:91

<a id="importpipelines"></a>

##### importPipelines?

```ts
readonly optional importPipelines?: readonly CollectionTablePipeline<TRow>[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:92

<a id="integrations"></a>

##### integrations?

```ts
readonly optional integrations?: readonly object[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:93

<a id="selectedrows"></a>

##### selectedRows?

```ts
readonly optional selectedRows?: readonly TRow[];
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:94

<a id="selectioncontrols"></a>

##### selectionControls?

```ts
readonly optional selectionControls?: object;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:95

###### allSelected

```ts
readonly allSelected: boolean;
```

###### totalRows

```ts
readonly totalRows: number;
```

###### toggleAll()

```ts
toggleAll(): void;
```

###### Returns

`void`

## Type Aliases

<a id="collectiontoolbaractionvariant"></a>

### CollectionToolbarActionVariant

```ts
type CollectionToolbarActionVariant = "default" | "outline" | "ghost" | "destructive";
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:63

***

<a id="collectiontoolbarname"></a>

### CollectionToolbarName

```ts
type CollectionToolbarName<TCollections> = Extract<keyof TCollections, string>;
```

Defined in: packages/ui/build/collection-toolbar/collection-toolbar.types.d.ts:6

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
