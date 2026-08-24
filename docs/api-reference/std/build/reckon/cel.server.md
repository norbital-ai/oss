[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/cel.server

# std/build/reckon/cel.server

## Type Aliases

<a id="customop"></a>

### CustomOp

```ts
type CustomOp = object;
```

Defined in: packages/std/build/reckon/cel.server.d.ts:23

Custom op registered via the engine's public extension API.

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-handler"></a> `handler` | (...`args`) => `unknown` | packages/std/build/reckon/cel.server.d.ts:25 |
| <a id="property-signature"></a> `signature` | `string` | packages/std/build/reckon/cel.server.d.ts:24 |

***

<a id="reckonenvironment"></a>

### ReckonEnvironment

```ts
type ReckonEnvironment = object;
```

Defined in: packages/std/build/reckon/cel.server.d.ts:9

A compiled CEL environment bound to a specific computation definition.

#### Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-allrefs"></a> `allRefs` | `readonly` | `Map`\<`string`, `Set`\<`string`\>\> | packages/std/build/reckon/cel.server.d.ts:16 |
| <a id="property-auditref"></a> `auditRef` | `readonly` | [`AuditRef`](/docs/api-reference/std/build/reckon/ops.md#auditref) | packages/std/build/reckon/cel.server.d.ts:19 |
| <a id="property-compiled"></a> `compiled` | `readonly` | `Map`\<`string`, `ParseResult`\> | packages/std/build/reckon/cel.server.d.ts:18 |
| <a id="property-definitionhash"></a> `definitionHash` | `readonly` | `string` | packages/std/build/reckon/cel.server.d.ts:17 |
| <a id="property-exprdeps"></a> `exprDeps` | `readonly` | `Map`\<`string`, `Set`\<`string`\>\> | packages/std/build/reckon/cel.server.d.ts:15 |
| <a id="property-exprorder"></a> `exprOrder` | `readonly` | `string`[] | packages/std/build/reckon/cel.server.d.ts:14 |
| <a id="property-exprs"></a> `exprs` | `readonly` | `Record`\<`string`, `string`\> | packages/std/build/reckon/cel.server.d.ts:12 |
| <a id="property-id"></a> `id` | `readonly` | `string` | packages/std/build/reckon/cel.server.d.ts:10 |
| <a id="property-outputs"></a> `outputs` | `readonly` | `ReadonlyArray`\<`string`\> | packages/std/build/reckon/cel.server.d.ts:11 |
| <a id="property-scoperef"></a> `scopeRef` | `readonly` | `ScopeRef` | packages/std/build/reckon/cel.server.d.ts:20 |
| <a id="property-tables"></a> `tables` | `readonly` | `Record`\<`string`, [`InlinedTable`](/docs/api-reference/std/build/reckon/definition.md#inlinedtable)\> | packages/std/build/reckon/cel.server.d.ts:13 |

## Functions

<a id="createenvironment"></a>

### createEnvironment()

```ts
function createEnvironment(def, customOps?): ReckonEnvironment;
```

Defined in: packages/std/build/reckon/cel.server.d.ts:35

Create a Reckon environment for a computation definition.

Parses all exprs, extracts dependencies via AST walk, topo-sorts, and
registers all ops (scalar + table-aware + fold) with audit/scope side channels.

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
| `customOps?` | [`CustomOp`](/docs/api-reference/std/build/reckon/cel.server.md#customop)[] | - |

#### Returns

[`ReckonEnvironment`](/docs/api-reference/std/build/reckon/cel.server.md#reckonenvironment)

#### Throws

on parse errors or dependency cycles

***

<a id="validatedefinition"></a>

### validateDefinition()

```ts
function validateDefinition(def, customOps?):
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

Defined in: packages/std/build/reckon/cel.server.d.ts:44

Validate a computation definition without executing it.

Checks:
1. All exprs parse as valid CEL
2. No dependency cycles
3. All declared outputs exist as exprs

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
| `customOps?` | [`CustomOp`](/docs/api-reference/std/build/reckon/cel.server.md#customop)[] | - |

#### Returns

  \| \{
  `definitionHash`: `string`;
  `ok`: `true`;
  `order`: readonly `string`[];
\}
  \| \{
  `errors`: readonly `object`[];
  `ok`: `false`;
\}
