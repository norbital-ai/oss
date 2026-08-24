[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/collection-table/collection-table-row-query

# ui/build/collection-table/collection-table-row-query

## Classes

<a id="collectionfilterpatherror"></a>

### CollectionFilterPathError

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:14

A filter whose path cannot be resolved against the row in hand.

This is thrown rather than answered with `false` because those two are not the same statement.
"No row matched" is a result; "this predicate could not be evaluated" is a defect, and rendering
it as an empty table shows a filter that looks like it worked and quietly hides every record.
A caller filtering rows in memory should let this surface, or catch it and say the filter could
not be applied — never fold it into the result set.

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CollectionFilterPathError(path, segment): CollectionFilterPathError;
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:17

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | readonly `string`[] |
| `segment` | `string` |

###### Returns

[`CollectionFilterPathError`](/docs/api-reference/ui/build/collection-table/collection-table-row-query.md#collectionfilterpatherror)

###### Overrides

```ts
Error.constructor
```

#### Properties

<a id="path"></a>

##### path

```ts
readonly path: readonly string[];
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:15

<a id="segment"></a>

##### segment

```ts
readonly segment: string;
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:16

## Variables

<a id="isplainrecord"></a>

### isPlainRecord

```ts
const isPlainRecord: <I>(input) => input is I & { [x: string]: unknown };
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:2

#### Type Parameters

| Type Parameter |
| ------ |
| `I` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `I` |

#### Returns

`input is I & { [x: string]: unknown }`

## Functions

<a id="collectiontablerowmatchesfilters"></a>

### collectionTableRowMatchesFilters()

```ts
function collectionTableRowMatchesFilters(row, filters): boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:24

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `object` |
| `filters` | \| readonly [`CollectionFilter`](/docs/api-reference/std/build/collection.md#collectionfilter)[] \| `undefined` |

#### Returns

`boolean`

#### Throws

when a path cannot be resolved against `row`. A predicate
that cannot be evaluated must not answer "did not match" — see the error's own note.

***

<a id="collectiontablerowmatchessearch"></a>

### collectionTableRowMatchesSearch()

```ts
function collectionTableRowMatchesSearch(row, search): boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:19

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `object` |
| `search` | `string` |

#### Returns

`boolean`

***

<a id="collectiontablerowmatcheswhere"></a>

### collectionTableRowMatchesWhere()

```ts
function collectionTableRowMatchesWhere(row, where): boolean;
```

Defined in: packages/ui/build/collection-table/collection-table-row-query.d.ts:25

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `object` |
| `where` | `Readonly`\<`Record`\<`string`, `unknown`\>\> \| `undefined` |

#### Returns

`boolean`
