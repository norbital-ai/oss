[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/definition

# std/build/reckon/definition

## Type Aliases

<a id="computationdefinition"></a>

### ComputationDefinition

```ts
type ComputationDefinition = Schema.Schema.Type<typeof ComputationDefinitionSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:106

***

<a id="computationmanifest"></a>

### ComputationManifest

```ts
type ComputationManifest = Schema.Schema.Type<typeof ComputationManifestSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:161

***

<a id="computationmanifestnode"></a>

### ComputationManifestNode

```ts
type ComputationManifestNode = Schema.Schema.Type<typeof ComputationManifestNodeSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:128

***

<a id="inlinedtable"></a>

### InlinedTable

```ts
type InlinedTable = Schema.Schema.Type<typeof InlinedTableSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:37

***

<a id="reckonresult"></a>

### ReckonResult

```ts
type ReckonResult<TOutput> = object;
```

Defined in: packages/std/build/reckon/definition.d.ts:171

Result of running a computation — typed outputs + full manifest.

`TOutput` is a caller-chosen generic: the engine has no input or output schema by design, so the
declared outputs keep their caller-provided type and the manifest is the schema-owned part.
The engine only ever yields a plain string-keyed object of unknown values, so the bound to
`Record<string, unknown>` states that contract; the caller's key claims are still theirs to
uphold.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TOutput` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> |

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-manifest"></a> `manifest` | [`ComputationManifest`](/docs/api-reference/std/build/reckon/definition.md#computationmanifest) | Full structured manifest for audit and replay. | packages/std/build/reckon/definition.d.ts:175 |
| <a id="property-outputs"></a> `outputs` | `TOutput` | The declared outputs, typed by the caller via `<TOutput>`. | packages/std/build/reckon/definition.d.ts:173 |

***

<a id="roundingmethod"></a>

### RoundingMethod

```ts
type RoundingMethod = Schema.Schema.Type<typeof RoundingMethodSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:109

***

<a id="validationerror"></a>

### ValidationError

```ts
type ValidationError = Schema.Schema.Type<typeof ValidationErrorSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:182

***

<a id="validationresult"></a>

### ValidationResult

```ts
type ValidationResult = Schema.Schema.Type<typeof ValidationResultSchema>;
```

Defined in: packages/std/build/reckon/definition.d.ts:195

## Variables

<a id="computationdefinitionschema"></a>

### ComputationDefinitionSchema

```ts
const ComputationDefinitionSchema: Schema.Struct<{
  components: Schema.optional<Schema.$Record<Schema.String, Schema.Struct<{
     category: Schema.Literals<readonly ["earning", "deduction", "employer_cost", "info"]>;
     code: Schema.String;
     name: Schema.String;
  }>>>;
  dependsOn: Schema.optional<Schema.$Array<Schema.String>>;
  exprs: Schema.$Record<Schema.String, Schema.String>;
  id: Schema.String;
  outputs: Schema.$Array<Schema.String>;
  tables: Schema.$Record<Schema.String, Schema.Union<readonly [Schema.Struct<{
     kind: Schema.Literal<"flat">;
     rows: Schema.$Array<Schema.$Record<Schema.String, Schema.Unknown>>;
   }>, Schema.Struct<{
     kind: Schema.Literal<"tier">;
     rows: Schema.$Array<Schema.StructWithRest<Schema.Struct<...>, readonly ...>>;
   }>, Schema.Struct<{
     kind: Schema.Literal<"progressive">;
     rows: Schema.$Array<Schema.Struct<{
        base: ...;
        max: ...;
        rate: ...;
     }>>;
   }>, Schema.Struct<{
     dimensions: Schema.$Array<Schema.Struct<{
        kind: ...;
        name: ...;
     }>>;
     kind: Schema.Literal<"matrix">;
     rows: Schema.$Array<Schema.$Record<Schema.String, Schema.Unknown>>;
  }>]>>;
}>;
```

Defined in: packages/std/build/reckon/definition.d.ts:66

A declarative computation graph.

No input schema is declared — the caller passes any object and optionally
types it via the generic `<TInput>` on `runComputation`. The engine
resolves expr dependencies by walking CEL ASTs, topo-sorts, and evaluates.

#### Example

```ts
const def: ComputationDefinition = {
  id: 'my-pcb-2026',
  tables: {
    pcbTable: {
      kind: 'progressive',
      rows: [
        { max: 5000, rate: 0.0, base: 0 },
        { max: 20000, rate: 0.01, base: 0 },
      ],
    },
  },
  exprs: {
    annualized: 'taxableEarnings * 12',
    pcb: 'round(applyProgressive(annualized, "pcbTable") / 12, "NEAREST_CENT")',
  },
  outputs: ['pcb'],
};
```

***

<a id="computationmanifestnodeschema"></a>

### ComputationManifestNodeSchema

```ts
const ComputationManifestNodeSchema: Schema.Struct<{
  expr: Schema.String;
  id: Schema.String;
  inputs: Schema.$Record<Schema.String, Schema.Unknown>;
  iterations: Schema.optional<Schema.$Array<Schema.Struct<{
     input: Schema.Unknown;
     output: Schema.Unknown;
  }>>>;
  opAudit: Schema.optional<Schema.Unknown>;
  output: Schema.Unknown;
}>;
```

Defined in: packages/std/build/reckon/definition.d.ts:111

A single node in the computation manifest — one per named expr.

***

<a id="computationmanifestschema"></a>

### ComputationManifestSchema

```ts
const ComputationManifestSchema: Schema.Struct<{
  computationId: Schema.String;
  definitionHash: Schema.String;
  inputSnapshot: Schema.$Record<Schema.String, Schema.Unknown>;
  nodes: Schema.$Array<Schema.Struct<{
     expr: Schema.String;
     id: Schema.String;
     inputs: Schema.$Record<Schema.String, Schema.Unknown>;
     iterations: Schema.optional<Schema.$Array<Schema.Struct<{
        input: Schema.Unknown;
        output: Schema.Unknown;
     }>>>;
     opAudit: Schema.optional<Schema.Unknown>;
     output: Schema.Unknown;
  }>>;
  outputs: Schema.$Record<Schema.String, Schema.Struct<{
     nodeId: Schema.String;
     value: Schema.Unknown;
  }>>;
}>;
```

Defined in: packages/std/build/reckon/definition.d.ts:130

Structured, replayable record of a computation run.

***

<a id="inlinedtableschema"></a>

### InlinedTableSchema

```ts
const InlinedTableSchema: Schema.Union<readonly [Schema.Struct<{
  kind: Schema.Literal<"flat">;
  rows: Schema.$Array<Schema.$Record<Schema.String, Schema.Unknown>>;
}>, Schema.Struct<{
  kind: Schema.Literal<"tier">;
  rows: Schema.$Array<Schema.StructWithRest<Schema.Struct<{
     max: Schema.Number;
  }>, readonly [Schema.$Record<Schema.String, Schema.Number>]>>;
}>, Schema.Struct<{
  kind: Schema.Literal<"progressive">;
  rows: Schema.$Array<Schema.Struct<{
     base: Schema.optional<Schema.Number>;
     max: Schema.Number;
     rate: Schema.Number;
  }>>;
}>, Schema.Struct<{
  dimensions: Schema.$Array<Schema.Struct<{
     kind: Schema.Literals<readonly [..., ...]>;
     name: Schema.String;
  }>>;
  kind: Schema.Literal<"matrix">;
  rows: Schema.$Array<Schema.$Record<Schema.String, Schema.Unknown>>;
}>]>;
```

Defined in: packages/std/build/reckon/definition.d.ts:14

Rate tables inlined directly into the computation definition.
The definition hash covers exprs + tables, so old results always
reference the exact table that was used.

***

<a id="roundingmethodschema"></a>

### RoundingMethodSchema

```ts
const RoundingMethodSchema: Schema.Literals<readonly ["NONE", "NEAREST_CENT", "NEAREST_5_CENTS", "TRUNCATE_CENT", "UP_5_CENTS"]>;
```

Defined in: packages/std/build/reckon/definition.d.ts:108

Rounding modes for the `round` op.

***

<a id="validationerrorschema"></a>

### ValidationErrorSchema

```ts
const ValidationErrorSchema: Schema.Struct<{
  expr: Schema.optional<Schema.String>;
  message: Schema.String;
}>;
```

Defined in: packages/std/build/reckon/definition.d.ts:178

Validation error for a computation definition.

***

<a id="validationresultschema"></a>

### ValidationResultSchema

```ts
const ValidationResultSchema: Schema.Union<readonly [Schema.Struct<{
  definitionHash: Schema.String;
  ok: Schema.Literal<true>;
  order: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
  errors: Schema.$Array<Schema.Struct<{
     expr: Schema.optional<Schema.String>;
     message: Schema.String;
  }>>;
  ok: Schema.Literal<false>;
}>]>;
```

Defined in: packages/std/build/reckon/definition.d.ts:184

Result of validating a computation definition.
