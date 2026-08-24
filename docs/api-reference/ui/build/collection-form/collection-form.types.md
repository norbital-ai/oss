[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-form/collection-form.types

# ui/build/collection-form/collection-form.types

## Interfaces

<a id="collectionformcomposition"></a>

### CollectionFormComposition

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:64

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
| `TName` *extends* [`CollectionFormName`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformname)\<`TCollections`\> |

#### Properties

<a id="field"></a>

##### Field

```ts
Field: CollectionFormFieldComponent<Extract<keyof CollectionRow<TCollections[TName]>, string>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:65

<a id="form"></a>

##### form

```ts
form: CollectionFormController;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:66

***

<a id="collectionformcontroller"></a>

### CollectionFormController

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:55

#### Properties

<a id="setvalues"></a>

##### setValues

```ts
readonly setValues: (values) => void;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:57

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | [`CollectionFormValidationValues`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformvalidationvalues) |

###### Returns

`void`

<a id="values"></a>

##### values

```ts
readonly values: () => CollectionFormValidationValues;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:56

###### Returns

[`CollectionFormValidationValues`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformvalidationvalues)

***

<a id="collectionformdeleteaction"></a>

### CollectionFormDeleteAction

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:59

#### Properties

<a id="disabled"></a>

##### disabled?

```ts
readonly optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:61

<a id="label"></a>

##### label?

```ts
readonly optional label?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:60

<a id="ondelete"></a>

##### onDelete

```ts
readonly onDelete: () => void | Effect<void, unknown, never>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:62

###### Returns

`void` \| `Effect`\<`void`, `unknown`, `never`\>

***

<a id="collectionformfieldcomponent"></a>

### CollectionFormFieldComponent()

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:49

`Field` as handed to form composition snippets. Callable shape, so svelte-check accepts it as a
component; the generic lets each usage instantiate `TRendererProps` from `renderer={...}` so
`rendererProps` stays typed.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TFieldName` *extends* `string` | `string` |

```ts
CollectionFormFieldComponent<TRenderer>(
   this,
   internals,
   props): object;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:51

`Field` as handed to form composition snippets. Callable shape, so svelte-check accepts it as a
component; the generic lets each usage instantiate `TRendererProps` from `renderer={...}` so
`rendererProps` stays typed.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRenderer` *extends* `Component`\<`never`, \{ \}, `string`\> | `Component`\<[`CollectionFormRendererProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendererprops), \{ \}, `string`\> |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `void` |
| `internals` | `Brand` |
| `props` | [`CollectionFormFieldProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformfieldprops)\<`TFieldName`, `TRenderer`\> |

#### Returns

`object`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CollectionFormFieldComponent<TRenderer>(options): SvelteComponent<CollectionFormFieldProps<TFieldName, TRenderer>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:50

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | `ComponentConstructorOptions`\<[`CollectionFormFieldProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformfieldprops)\<`TFieldName`, `TRenderer`\>\> |

###### Returns

`SvelteComponent`\<[`CollectionFormFieldProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformfieldprops)\<`TFieldName`, `TRenderer`\>\>

#### Properties

<a id="element"></a>

##### element?

```ts
optional element?: () => HTMLElement;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:52

###### Returns

`HTMLElement`

<a id="z_bindings"></a>

##### z\_$$bindings?

```ts
optional z_$$bindings?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:53

***

<a id="collectionformfieldprops"></a>

### CollectionFormFieldProps

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:37

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TFieldName` *extends* `string` | `string` |
| `TRenderer` *extends* `Component`\<`never`\> | `Component`\<[`CollectionFormRendererProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendererprops)\> |

#### Properties

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:40

<a id="label-1"></a>

##### label?

```ts
optional label?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:39

<a id="name"></a>

##### name

```ts
name: TFieldName;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:38

<a id="renderer"></a>

##### renderer?

```ts
optional renderer?: TRenderer;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:41

<a id="rendererprops"></a>

##### rendererProps?

```ts
optional rendererProps?: CollectionFormCallerRendererProps<RendererProps<TRenderer>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:42

***

<a id="collectionformprops"></a>

### CollectionFormProps

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:68

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |
| `TName` *extends* [`CollectionFormName`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformname)\<`TCollections`\> |

#### Properties

<a id="children"></a>

##### children?

```ts
optional children?: Snippet<[CollectionFormComposition<TCollections, TName>]>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:101

Field composition. Omit to auto-emit a `Field` per writable field in declaration order and
laid out with the intrinsic `Grid` (RFC V.4a).

<a id="class-1"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:90

<a id="client"></a>

##### client

```ts
client: CollectionDbClient<TCollections>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:69

<a id="collection"></a>

##### collection

```ts
collection: TName;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:70

<a id="defaultvalues"></a>

##### defaultValues?

```ts
optional defaultValues?:
  | Partial<CollectionRow<TCollections[TName]>>
| Partial<CollectionMutationInput<TCollections[TName]>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:80

The row being edited, or a partial seed for a new one.

This alone decides create vs. update: a value carrying the framework's row key is an existing
record, anything else is a draft. There is deliberately no `recordId` prop — it was always the
same id the caller had just dug out of this record, and every authored `+representation.svelte`
threaded it back by hand. An optional override would be an escape hatch that silently
re-legalises reaching into framework-owned fields from authored source.

<a id="deleteaction"></a>

##### deleteAction?

```ts
optional deleteAction?: CollectionFormDeleteAction;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:84

<a id="disabled-1"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:87

<a id="fields"></a>

##### fields?

```ts
optional fields?: readonly Extract<keyof CollectionRow<TCollections[TName]>, string>[];
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:96

Ordered field-name pick for the auto-emitted form (RFC V.4b). Wins over auto field emission;
ignored when a `children` composition is provided.

<a id="loading"></a>

##### loading?

```ts
optional loading?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:88

<a id="onaftersubmit"></a>

##### onAfterSubmit?

```ts
optional onAfterSubmit?: () => void | Effect<void, unknown, never>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:91

###### Returns

`void` \| `Effect`\<`void`, `unknown`, `never`\>

<a id="onsubmit"></a>

##### onSubmit?

```ts
optional onSubmit?: (values) => Effect<void, unknown>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:83

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | [`CollectionFormValidationValues`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformvalidationvalues) |

###### Returns

`Effect`\<`void`, `unknown`\>

<a id="recordmetadata"></a>

##### recordMetadata?

```ts
optional recordMetadata?: readonly (
  | {
  kind: "restriction";
  label?: string;
  operations: readonly ["update" | "delete", "update" | "delete"];
  reason: string;
}
  | {
  description?: string;
  icon?: string;
  kind: "flag";
  label: string;
  tone: "info" | "neutral" | "success" | "warning" | "danger";
})[];
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:86

Application-authored behaviour and flags for this record. System metadata is injected.

<a id="skeletonrows"></a>

##### skeletonRows?

```ts
optional skeletonRows?: number;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:89

<a id="submitlabel"></a>

##### submitLabel?

```ts
optional submitLabel?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:81

<a id="validation"></a>

##### validation?

```ts
optional validation?: CollectionFormValidation;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:82

***

<a id="collectionformrendereroptions"></a>

### CollectionFormRendererOptions

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:23

#### Extended by

- [`CollectionFormRendererProps`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendererprops)

#### Properties

<a id="disabled-2"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:25

<a id="placeholder"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:26

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:24

<a id="relationoptions"></a>

##### relationOptions?

```ts
optional relationOptions?: CollectionRelationOptions<CollectionRecord>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:27

***

<a id="collectionformrendererprops"></a>

### CollectionFormRendererProps

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:29

#### Extends

- [`CollectionFormRendererOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendereroptions)

#### Properties

<a id="disabled-3"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:25

###### Inherited from

[`CollectionFormRendererOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendereroptions).[`disabled`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#disabled-2)

<a id="field-1"></a>

##### field

```ts
field: CollectionField;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:31

<a id="onvaluechange"></a>

##### onValueChange

```ts
onValueChange: (value) => void;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:34

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

###### Returns

`void`

<a id="placeholder-1"></a>

##### placeholder?

```ts
optional placeholder?: string;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:26

###### Inherited from

[`CollectionFormRendererOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendereroptions).[`placeholder`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#placeholder)

<a id="readonly-1"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:24

###### Inherited from

[`CollectionFormRendererOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendereroptions).[`readonly`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#readonly)

<a id="relationoptions-1"></a>

##### relationOptions?

```ts
optional relationOptions?: CollectionRelationOptions<CollectionRecord>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:27

###### Inherited from

[`CollectionFormRendererOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformrendereroptions).[`relationOptions`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#relationoptions)

<a id="row"></a>

##### row

```ts
row: Record<string, unknown>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:33

Current form record, including unsaved sibling-field values.

<a id="value"></a>

##### value

```ts
value: unknown;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:30

***

<a id="collectionformvalidation"></a>

### CollectionFormValidation

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:13

#### Properties

<a id="schema"></a>

##### schema?

```ts
readonly optional schema?: StandardSchemaOf<Codec<unknown, unknown, never, never>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:15

Effect schema validation, read through the schema's `~standard` adapter.

<a id="semantic"></a>

##### semantic?

```ts
readonly optional semantic?: (values) => Effect<void | readonly object[], unknown>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:17

Cross-field or domain validation that may perform asynchronous checks.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | [`CollectionFormValidationValues`](/docs/api-reference/ui/build/collection-form/collection-form.types.md#collectionformvalidationvalues) |

###### Returns

`Effect`\<`void` \| readonly `object`[], `unknown`\>

## Type Aliases

<a id="collectionformcallerrendererprops"></a>

### CollectionFormCallerRendererProps

```ts
type CollectionFormCallerRendererProps<TRendererProps> = Omit<TRendererProps, CollectionFormInjectedRendererKey>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:22

#### Type Parameters

| Type Parameter |
| ------ |
| `TRendererProps` |

***

<a id="collectionforminjectedrendererkey"></a>

### CollectionFormInjectedRendererKey

```ts
type CollectionFormInjectedRendererKey = typeof collectionFormInjectedRendererKeySchema.Type;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:21

Props CollectionFormField always injects; callers supply the rest via `rendererProps`.

***

<a id="collectionformname"></a>

### CollectionFormName

```ts
type CollectionFormName<TCollections> = Extract<keyof TCollections, string>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:6

#### Type Parameters

| Type Parameter |
| ------ |
| `TCollections` *extends* [`CollectionRegistry`](/docs/api-reference/std/build/collection.md#collectionregistry) |

***

<a id="collectionformvalidationissue"></a>

### CollectionFormValidationIssue

```ts
type CollectionFormValidationIssue = typeof collectionFormValidationIssueSchema.Type;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:12

***

<a id="collectionformvalidationvalues"></a>

### CollectionFormValidationValues

```ts
type CollectionFormValidationValues = Readonly<Record<string, unknown>>;
```

Defined in: packages/ui/build/collection-form/collection-form.types.d.ts:7
