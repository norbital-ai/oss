[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/runtime.server

# std/build/reckon/runtime.server

## Functions

<a id="runcomputation"></a>

### runComputation()

```ts
function runComputation<TInput, TOutput>(
   def,
   input,
env?): ReckonResult<TOutput>;
```

Defined in: packages/std/build/reckon/runtime.server.d.ts:22

Execute a computation against an input and produce typed outputs + a full manifest.

If no environment is provided, one is created from the definition (and should
be cached by the caller for repeated runs with different inputs). Each expr is
evaluated in topo-sorted order. Results accumulate into the scope so dependent
exprs can reference them. The audit sink is cleared before each expr and read
after to capture structured op audit.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `TInput` *extends* `object` | `Record`\<`string`, `unknown`\> | The input shape (defaults to `Record<string, unknown>`) |
| `TOutput` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> | The output shape (defaults to `Record<string, unknown>`) |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `def` | \{ `components?`: \{ \[`key`: `string`\]: `object`; \}; `dependsOn?`: readonly `string`[]; `exprs`: \{ \[`key`: `string`\]: `string`; \}; `id`: `string`; `outputs`: readonly `string`[]; `tables`: \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \}; \} | - |
| `def.components?` | \{ \[`key`: `string`\]: `object`; \} | Optional mapping from output expr ids to payslip component metadata. |
| `def.dependsOn?` | readonly `string`[] | Other computation definition ids whose outputs feed into this one's inputs. |
| `def.exprs?` | \{ \[`key`: `string`\]: `string`; \} | Named CEL expressions. Each expr can reference inputs, other exprs, and registered ops. |
| `def.id?` | `string` | Unique identifier for this definition. |
| `def.outputs?` | readonly `string`[] | Which expr names are exposed as outputs. |
| `def.tables?` | \{ \[`key`: `string`\]: \| \{ `kind`: `"flat"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"tier"`; `rows`: readonly `object`[]; \} \| \{ `kind`: `"progressive"`; `rows`: readonly `object`[]; \} \| \{ `dimensions`: readonly `object`[]; `kind`: `"matrix"`; `rows`: readonly `object`[]; \}; \} | Inlined rate/classification tables, keyed by name. Referenced in exprs via string literals. |
| `input?` | `TInput` | - |
| `env?` | [`ReckonEnvironment`](/docs/api-reference/std/build/reckon/cel.server.md#reckonenvironment) | - |

#### Returns

[`ReckonResult`](/docs/api-reference/std/build/reckon/definition.md#reckonresult)\<`TOutput`\>

#### Example

```ts
const { outputs, manifest } = runComputation<PayrollInput, PayrollOutput>(def, input);
// outputs.netPay: number  (typed by PayrollOutput)
// manifest.nodes: [{ id: 'pcb', expr: '...', inputs: {...}, output: 416.67, opAudit: {...} }]
```
