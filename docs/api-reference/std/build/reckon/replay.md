[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/replay

# std/build/reckon/replay

## Type Aliases

<a id="replayresult"></a>

### ReplayResult

```ts
type ReplayResult = Schema.Schema.Type<typeof ReplayResultSchema>;
```

Defined in: packages/std/build/reckon/replay.d.ts:20

## Variables

<a id="replayresultschema"></a>

### ReplayResultSchema

```ts
const ReplayResultSchema: Schema.Struct<{
  matches: Schema.Boolean;
  mismatches: Schema.optional<Schema.$Record<Schema.String, Schema.Struct<{
     actual: Schema.Unknown;
     expected: Schema.Unknown;
  }>>>;
  outputs: Schema.$Record<Schema.String, Schema.Unknown>;
}>;
```

Defined in: packages/std/build/reckon/replay.d.ts:9

Result of replaying a manifest.

The mismatch half is schema-owned so a caller replaying from the stored result of another host
decodes it with the same shape the verifier produced.

## Functions

<a id="replaymanifest"></a>

### replayManifest()

```ts
function replayManifest(manifest, def): object;
```

Defined in: packages/std/build/reckon/replay.d.ts:41

Replay a computation manifest to verify integrity.

Re-runs the computation using the manifest's `inputSnapshot` and the
provided definition, then compares the outputs to the manifest's recorded
outputs. This is the core audit verification — if `matches` is `true`,
the recorded result is provably correct for the recorded inputs and definition.

The caller must provide the `ComputationDefinition` that corresponds to the
manifest's `definitionHash`. In production, definitions are stored as DB
records keyed by hash, so the caller looks up the def by hash then replays.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `manifest` | \{ `computationId`: `string`; `definitionHash`: `string`; `inputSnapshot`: \{ \[`key`: `string`\]: `unknown`; \}; `nodes`: readonly `object`[]; `outputs`: \{ \[`key`: `string`\]: `object`; \}; \} | - |
| `manifest.computationId` | `string` | The computation definition id. |
| `manifest.definitionHash` | `string` | SHA-256 hash of the canonicalized definition (exprs + inlined tables). |
| `manifest.inputSnapshot` | \{ \[`key`: `string`\]: `unknown`; \} | Snapshot of input values — enables replay without live source records. |
| `manifest.nodes` | readonly `object`[] | One node per named expr, in evaluation order. |
| `manifest.outputs` | \{ \[`key`: `string`\]: `object`; \} | The declared outputs with their values and source node ids. |
| `def` | \{ `components?`: \{ \[`key`: `string`\]: `object`; \}; `dependsOn?`: readonly `string`[]; `exprs`: \{ \[`key`: `string`\]: `string`; \}; `id`: `string`; `outputs`: readonly `string`[]; `tables`: \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \}; \} | - |
| `def.components?` | \{ \[`key`: `string`\]: `object`; \} | Optional mapping from output expr ids to payslip component metadata. |
| `def.dependsOn?` | readonly `string`[] | Other computation definition ids whose outputs feed into this one's inputs. |
| `def.exprs` | \{ \[`key`: `string`\]: `string`; \} | Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. |
| `def.id` | `string` | Unique identifier for this definition. |
| `def.outputs` | readonly `string`[] | Which expr names are exposed as outputs. |
| `def.tables` | \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \} | Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. |

#### Returns

##### matches

```ts
readonly matches: boolean;
```

Whether the replayed outputs match the manifest's recorded outputs.

##### mismatches?

```ts
readonly optional mismatches?: object;
```

Per-output comparison (only included when there's a mismatch).

###### Index Signature

```ts
[key: string]: object
```

##### outputs

```ts
readonly outputs: object;
```

The outputs produced by replaying.

###### Index Signature

```ts
[key: string]: unknown
```

#### Example

```ts
const result = replayManifest(manifest, storedDefinition);
if (!result.matches) {
  console.error('Audit failure:', result.mismatches);
}
```
