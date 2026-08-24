[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/register.server

# std/build/reckon/register.server

## Classes

<a id="reckonengine"></a>

### ReckonEngine

Defined in: packages/std/build/reckon/register.server.d.ts:25

Reckon computation engine — declarative, auditable, pure.

Create an instance via `createReckonEngine()`. Register custom ops for
domain-specific calculations. Validate and run computation definitions.

#### Example

```ts
const engine = createReckonEngine();

const def: ComputationDefinition = {
  id: 'pcb',
  tables: { pcbTable: { kind: 'progressive', rows: [...] } },
  exprs: { pcb: 'round(applyProgressive(income * 12, "pcbTable") / 12, "NEAREST_CENT")' },
  outputs: ['pcb'],
};

const { outputs, manifest } = engine.runComputation<{ income: number }, { pcb: number }>(def, { income: 5000 });
console.log(outputs.pcb); // typed as number
console.log(manifest.nodes[0].opAudit); // { op: 'applyProgressive', audit: { matchedTier: {...} } }
```

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new ReckonEngine(): ReckonEngine;
```

###### Returns

[`ReckonEngine`](/docs/api-reference/std/build/reckon/register.server.md#reckonengine)

#### Methods

<a id="registerfunction"></a>

##### registerFunction()

```ts
registerFunction(
   name,
   signature,
   handler): this;
```

Defined in: packages/std/build/reckon/register.server.d.ts:29

Register a custom op available in all computations. Invalidates the env cache.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | `string` |
| `signature` | `string` |
| `handler` | (...`args`) => `unknown` |

###### Returns

`this`

<a id="replaymanifest"></a>

##### replayManifest()

```ts
replayManifest(manifest, def): object;
```

Defined in: packages/std/build/reckon/register.server.d.ts:43

Replay a manifest to verify integrity against a stored definition.

###### Parameters

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

###### Returns

###### matches

```ts
readonly matches: boolean;
```

Whether the replayed outputs match the manifest's recorded outputs.

###### mismatches?

```ts
readonly optional mismatches?: object;
```

Per-output comparison (only included when there's a mismatch).

###### Index Signature

```ts
[key: string]: object
```

###### outputs

```ts
readonly outputs: object;
```

The outputs produced by replaying.

###### Index Signature

```ts
[key: string]: unknown
```

<a id="runcomputation"></a>

##### runComputation()

```ts
runComputation<TInput, TOutput>(def, input): ReckonResult<TOutput>;
```

Defined in: packages/std/build/reckon/register.server.d.ts:41

Run a computation and return typed outputs + a full replayable manifest.

The compiled environment is cached by definition hash, so repeated runs
with different inputs reuse the parsed/topo-sorted CEL expressions.

###### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TInput` *extends* `object` | `Record`\<`string`, `unknown`\> | The input shape |
| `TOutput` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> | The output shape |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `def` | \{ `components?`: \{ \[`key`: `string`\]: `object`; \}; `dependsOn?`: readonly `string`[]; `exprs`: \{ \[`key`: `string`\]: `string`; \}; `id`: `string`; `outputs`: readonly `string`[]; `tables`: \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \}; \} | - |
| `def.components?` | \{ \[`key`: `string`\]: `object`; \} | Optional mapping from output expr ids to payslip component metadata. |
| `def.dependsOn?` | readonly `string`[] | Other computation definition ids whose outputs feed into this one's inputs. |
| `def.exprs` | \{ \[`key`: `string`\]: `string`; \} | Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. |
| `def.id` | `string` | Unique identifier for this definition. |
| `def.outputs` | readonly `string`[] | Which expr names are exposed as outputs. |
| `def.tables` | \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \} | Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. |
| `input` | `TInput` | - |

###### Returns

[`ReckonResult`](/docs/api-reference/std/build/reckon/definition.md#reckonresult)\<`TOutput`\>

<a id="validatedefinition"></a>

##### validateDefinition()

```ts
validateDefinition(def):
  | {
  definitionHash: string;
  ok: true;
  order: readonly string[];
}
  | {
  errors: readonly object[];
  ok: false;
};
```

Defined in: packages/std/build/reckon/register.server.d.ts:31

Validate a computation definition without executing it.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `def` | \{ `components?`: \{ \[`key`: `string`\]: `object`; \}; `dependsOn?`: readonly `string`[]; `exprs`: \{ \[`key`: `string`\]: `string`; \}; `id`: `string`; `outputs`: readonly `string`[]; `tables`: \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \}; \} | - |
| `def.components?` | \{ \[`key`: `string`\]: `object`; \} | Optional mapping from output expr ids to payslip component metadata. |
| `def.dependsOn?` | readonly `string`[] | Other computation definition ids whose outputs feed into this one's inputs. |
| `def.exprs` | \{ \[`key`: `string`\]: `string`; \} | Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. |
| `def.id` | `string` | Unique identifier for this definition. |
| `def.outputs` | readonly `string`[] | Which expr names are exposed as outputs. |
| `def.tables` | \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \} | Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. |

###### Returns

  \| \{
  `definitionHash`: `string`;
  `ok`: `true`;
  `order`: readonly `string`[];
\}
  \| \{
  `errors`: readonly `object`[];
  `ok`: `false`;
\}

## Functions

<a id="createreckonengine"></a>

### createReckonEngine()

```ts
function createReckonEngine(): ReckonEngine;
```

Defined in: packages/std/build/reckon/register.server.d.ts:48

Create a new Reckon engine instance.

#### Returns

[`ReckonEngine`](/docs/api-reference/std/build/reckon/register.server.md#reckonengine)
