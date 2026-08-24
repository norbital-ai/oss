[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-card-derivation

# ui/build/collection-table/collection-card-derivation

## Type Aliases

<a id="authoredlaneinput"></a>

### AuthoredLaneInput

```ts
type AuthoredLaneInput = string | AuthoredLane;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:114

***

<a id="autocardmodel"></a>

### AutoCardModel

```ts
type AutoCardModel = typeof autoCardModelSchema.Type;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:55

## Functions

<a id="createactionlabel"></a>

### createActionLabel()

```ts
function createActionLabel(
   collectionName,
   override?,
   t?): string;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:128

The create-action label: an explicit override, else `New <humanized singular collection>`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `collectionName` | `string` |
| `override?` | `string` |
| `t?` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

`string`

***

<a id="deriveautocard"></a>

### deriveAutoCard()

```ts
function deriveAutoCard(
   fields,
   columnOrder,
   options): object;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:68

The auto card model derived from column card-role hints and, where a role is unfilled, the
field structure (RFC V.2d / V.3).

- title: `card:'title'` → the first non-nullable text-ish field → the first visible column →
  the collection `record_label` (when present).
- subtitle: `card:'subtitle'` columns → the next text-ish / relation fields (title excluded),
  capped at two.
- badge: `card:'badge'` → the first enum-backed field.

`columnOrder` is the visible column key order used for the title fallback.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |
| `columnOrder` | readonly `string`[] |
| `options` | \{ `hasRecordLabel`: `boolean`; `roles?`: \{ `badge?`: `string`; `subtitle?`: readonly `string`[]; `title?`: `string`; \}; \} |
| `options.hasRecordLabel` | `boolean` |
| `options.roles?` | \{ `badge?`: `string`; `subtitle?`: readonly `string`[]; `title?`: `string`; \} |
| `options.roles.badge?` | `string` |
| `options.roles.subtitle?` | readonly `string`[] |
| `options.roles.title?` | `string` |

#### Returns

##### badge?

```ts
readonly optional badge?: string;
```

Badge field name, if any.

##### subtitles

```ts
readonly subtitles: readonly string[];
```

Secondary field names, capped at two, title excluded.

##### title

```ts
readonly title:
  | {
  kind: "field";
  name: string;
}
  | {
  kind: "record-label";
};
```

***

<a id="derivecolumnfieldnames"></a>

### deriveColumnFieldNames()

```ts
function deriveColumnFieldNames(fields): string[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:32

Ordered non-system field names in declaration order. Used by kanban auto-card derivation when no
authored column order is available — table columns are always authored via a `columns` snippet.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |

#### Returns

`string`[]

***

<a id="deriveformfieldnames"></a>

### deriveFormFieldNames()

```ts
function deriveFormFieldNames(fields): string[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:133

Ordered field names for an auto-emitted form (RFC V.4a): every writable field in declaration
order. System and read-only fields are excluded. The `fields` prop narrows this.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |

#### Returns

`string`[]

***

<a id="derivelanes"></a>

### deriveLanes()

```ts
function deriveLanes(field): object[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:121

Kanban lanes derived from the groupBy field's bare `values`, in model order (RFC V.3).
Labels humanize the value; colours are supplied by view `lanes`, not schema.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | \| [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\> \| `undefined` |

#### Returns

`object`[]

***

<a id="formatautocardbadge"></a>

### formatAutoCardBadge()

```ts
function formatAutoCardBadge(
   model,
   record,
   text):
  | {
  label: string;
}
  | null;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:97

Resolve the optional badge selected by an auto-card model.

The record is still read directly: a badge is dropped when the field is empty, which is not the
same as a resolver that formats an empty value into a dash.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `model` | \{ `badge?`: `string`; `subtitles`: readonly `string`[]; `title`: \| \{ `kind`: `"field"`; `name`: `string`; \} \| \{ `kind`: `"record-label"`; \}; \} | - |
| `model.badge?` | `string` | Badge field name, if any. |
| `model.subtitles` | readonly `string`[] | Secondary field names, capped at two, title excluded. |
| `model.title` | \| \{ `kind`: `"field"`; `name`: `string`; \} \| \{ `kind`: `"record-label"`; \} | - |
| `record` | `object` | - |
| `text` | `CardText` | - |

#### Returns

  \| \{
  `label`: `string`;
\}
  \| `null`

***

<a id="formatautocardfield"></a>

### formatAutoCardField()

```ts
function formatAutoCardField(
   fields,
   name,
   record,
   t?): string;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:78

Format one field from an auto-card model without coupling the view to a renderer component.

This is the schema's answer, and the default `CardText` for a surface that has no other. A
surface with authored columns has a better one: see `CardText`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |
| `name` | `string` |
| `record` | `object` |
| `t?` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

`string`

***

<a id="formatautocardsubtitle"></a>

### formatAutoCardSubtitle()

```ts
function formatAutoCardSubtitle(model, text): string;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:90

Join the non-empty subtitle values selected by an auto-card model.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `model` | \{ `badge?`: `string`; `subtitles`: readonly `string`[]; `title`: \| \{ `kind`: `"field"`; `name`: `string`; \} \| \{ `kind`: `"record-label"`; \}; \} | - |
| `model.badge?` | `string` | Badge field name, if any. |
| `model.subtitles` | readonly `string`[] | Secondary field names, capped at two, title excluded. |
| `model.title` | \| \{ `kind`: `"field"`; `name`: `string`; \} \| \{ `kind`: `"record-label"`; \} | - |
| `text` | `CardText` | - |

#### Returns

`string`

***

<a id="issystemfield"></a>

### isSystemField()

```ts
function isSystemField(name): boolean;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:19

System fields are framework-managed and never authored into a view.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |

#### Returns

`boolean`

***

<a id="mergeauthoredlanes"></a>

### mergeAuthoredLanes()

```ts
function mergeAuthoredLanes(derived, authored?): Map<string, {
  color?: string;
  label: string;
  value: string;
}>;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:126

Merge schema-derived lane metadata with authored view lanes. Authored labels/colours override
schema-derived lanes; string lanes inherit derived metadata when present.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `derived` | readonly `object`[] |
| `authored?` | readonly [`AuthoredLaneInput`](/docs/api-reference/ui/build/collection-table/collection-card-derivation.md#authoredlaneinput)[] |

#### Returns

`Map`\<`string`, \{
  `color?`: `string`;
  `label`: `string`;
  `value`: `string`;
\}\>

***

<a id="optionalcollectionrecordid"></a>

### optionalCollectionRecordId()

```ts
function optionalCollectionRecordId(record): string | undefined;
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:27

The framework row key, when the value is a persisted row rather than a draft.

This is the single place the framework reads `id` off a caller-supplied object, so an
authored surface never has to: it hands over the record it already has and the framework tells
create and update apart from the presence of the key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | `object` \| `null` \| `undefined` |

#### Returns

`string` \| `undefined`

***

<a id="parseauthoredlanevalues"></a>

### parseAuthoredLaneValues()

```ts
function parseAuthoredLaneValues(lanes): string[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:116

Lane values in authored order — accepts `{ value, label?, color? }[]` or `string[]`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `lanes` | readonly [`AuthoredLaneInput`](/docs/api-reference/ui/build/collection-table/collection-card-derivation.md#authoredlaneinput)[] |

#### Returns

`string`[]

***

<a id="pickfieldnames"></a>

### pickFieldNames()

```ts
function pickFieldNames(fields, names): string[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:34

Ordered pick of existing field names, preserving the requested order (RFC V.2b `fields`).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fields` | readonly [`CollectionField`](/docs/api-reference/std/build/collection.md#collectionfield)\<`string`\>[] |
| `names` | readonly `string`[] |

#### Returns

`string`[]

***

<a id="resolvedrecordmetadatafor"></a>

### resolvedRecordMetadataFor()

```ts
function resolvedRecordMetadataFor<TRow>(
   record,
   metadata,
   t): readonly ResolvedCollectionRecordMetadata[];
```

Defined in: packages/ui/build/collection-table/collection-card-derivation.d.ts:138

Resolve the metadata cells a collection surface shows for one record, with the catalog-back
copy both the table and the board use for the framework-provided entries.

#### Type Parameters

| Type Parameter |
| ------ |
| `TRow` *extends* `object` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | `TRow` |
| `metadata` | \| [`CollectionRecordMetadataResolver`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#collectionrecordmetadataresolver)\<`TRow`\> \| `undefined` |
| `t` | [`Translate`](/docs/api-reference/ui/build/data-renderer/data-renderer.utils.md#translate) |

#### Returns

readonly [`ResolvedCollectionRecordMetadata`](/docs/api-reference/ui/build/collection-record-metadata/collection-record-metadata.md#resolvedcollectionrecordmetadata)[]
