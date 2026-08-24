[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/ops

# std/build/reckon/ops

## Type Aliases

<a id="auditentry"></a>

### AuditEntry

```ts
type AuditEntry = object;
```

Defined in: packages/std/build/reckon/ops.d.ts:3

A single audit entry pushed by an op during evaluation.

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-audit"></a> `audit` | `unknown` | packages/std/build/reckon/ops.d.ts:5 |
| <a id="property-op"></a> `op` | `string` | packages/std/build/reckon/ops.d.ts:4 |

***

<a id="auditref"></a>

### AuditRef

```ts
type AuditRef = object;
```

Defined in: packages/std/build/reckon/ops.d.ts:8

Mutable audit sink — ops push entries here as a side effect.

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-sink"></a> `sink` | [`AuditEntry`](/docs/api-reference/std/build/reckon/ops.md#auditentry)[] | packages/std/build/reckon/ops.d.ts:9 |

***

<a id="opregistration"></a>

### OpRegistration

```ts
type OpRegistration = object;
```

Defined in: packages/std/build/reckon/ops.d.ts:12

Spec for registering an op on the CEL environment; `signature` is the CEL function signature string.

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-handler"></a> `handler` | (...`args`) => `unknown` | packages/std/build/reckon/ops.d.ts:14 |
| <a id="property-signature"></a> `signature` | `string` | packages/std/build/reckon/ops.d.ts:13 |

## Functions

<a id="createfoldop"></a>

### createFoldOp()

```ts
function createFoldOp(
   parseExpr,
   scopeRef,
   audit): OpRegistration;
```

Defined in: packages/std/build/reckon/ops.d.ts:22

Create the fold op. Needs env (for sub-expr eval), scope ref, and audit ref.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `parseExpr` | (`expr`) => (`context`) => `unknown` |
| `scopeRef` | \{ `scope`: `Record`\<`string`, `unknown`\> \| `null`; \} |
| `scopeRef.scope` | `Record`\<`string`, `unknown`\> \| `null` |
| `audit` | [`AuditRef`](/docs/api-reference/std/build/reckon/ops.md#auditref) |

#### Returns

[`OpRegistration`](/docs/api-reference/std/build/reckon/ops.md#opregistration)

***

<a id="createscalarops"></a>

### createScalarOps()

```ts
function createScalarOps(audit): OpRegistration[];
```

Defined in: packages/std/build/reckon/ops.d.ts:18

Create all scalar (non-table) op registrations with an audit sink.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `audit` | [`AuditRef`](/docs/api-reference/std/build/reckon/ops.md#auditref) |

#### Returns

[`OpRegistration`](/docs/api-reference/std/build/reckon/ops.md#opregistration)[]

***

<a id="createtableops"></a>

### createTableOps()

```ts
function createTableOps(tables, audit): OpRegistration[];
```

Defined in: packages/std/build/reckon/ops.d.ts:20

Create table-dependent op registrations with an audit sink.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `tables` | `TableMap` |
| `audit` | [`AuditRef`](/docs/api-reference/std/build/reckon/ops.md#auditref) |

#### Returns

[`OpRegistration`](/docs/api-reference/std/build/reckon/ops.md#opregistration)[]
