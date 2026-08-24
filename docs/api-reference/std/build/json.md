[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/json

# std/build/json

## Type Aliases

<a id="jsonpatchoperation"></a>

### JsonPatchOperation

```ts
type JsonPatchOperation = Schema.Schema.Type<typeof JsonPatchOperationSchema>;
```

Defined in: packages/std/build/json/index.d.ts:13

## Variables

<a id="jsonpatchoperationschema"></a>

### JsonPatchOperationSchema

```ts
const JsonPatchOperationSchema: Schema.Struct<{
  op: Schema.Literals<readonly ["add", "remove", "replace"]>;
  path: Schema.String;
  value: Schema.optional<Schema.Unknown>;
}>;
```

Defined in: packages/std/build/json/index.d.ts:8

One mutation in a JSON Patch document, as `deepDiff` and the form engine's delta carry it.

The wire shape has one schema owner so both producers and consumers agree on the op names — a
`move` or `copy` op drifts out of the form engine's vocabulary and back in as a misapplied diff.

## Functions

<a id="deepdiff"></a>

### deepDiff()

```ts
function deepDiff(
   a,
   b,
   basePath?): object[];
```

Defined in: packages/std/build/json/index.d.ts:22

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `a` | `unknown` |
| `b` | `unknown` |
| `basePath?` | `string` |

#### Returns

`object`[]

***

<a id="safeparse"></a>

### safeParse()

```ts
function safeParse(json): unknown;
```

Defined in: packages/std/build/json/index.d.ts:21

Parse a JSON string, returning `null` on failure.

Returns `unknown` — callers must decode the result with an Effect Schema
before treating it as a concrete type. This is the
unvalidated boundary parse; structured validation belongs at the call site.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `json` | `string` |

#### Returns

`unknown`
