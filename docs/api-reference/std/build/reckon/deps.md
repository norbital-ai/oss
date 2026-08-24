[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/reckon/deps

# std/build/reckon/deps

## Classes

<a id="cycleerror"></a>

### CycleError

Defined in: packages/std/build/reckon/deps.d.ts:21

Cycle error thrown when topo-sort detects a cycle.

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new CycleError(nodes): CycleError;
```

Defined in: packages/std/build/reckon/deps.d.ts:23

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `nodes` | `string`[] |

###### Returns

[`CycleError`](/docs/api-reference/std/build/reckon/deps.md#cycleerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

<a id="nodes"></a>

##### nodes

```ts
readonly nodes: string[];
```

Defined in: packages/std/build/reckon/deps.d.ts:22

## Functions

<a id="extractidentifiers"></a>

### extractIdentifiers()

```ts
function extractIdentifiers(ast): Set<string>;
```

Defined in: packages/std/build/reckon/deps.d.ts:6

Extract all free identifiers from a CEL AST.
Returns identifiers that are NOT bound by macros.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `ast` | `ASTNode` |

#### Returns

`Set`\<`string`\>

***

<a id="partitiondependencies"></a>

### partitionDependencies()

```ts
function partitionDependencies(identifiers, exprNames): object;
```

Defined in: packages/std/build/reckon/deps.d.ts:16

Given a set of identifiers, separate them into expr dependencies and other references.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `identifiers` | `Set`\<`string`\> | All free identifiers from an expr's AST |
| `exprNames` | `Set`\<`string`\> | The set of all expr names in the definition |

#### Returns

`object`

`{ exprDeps, others }` where `exprDeps` are identifiers that match
         other expr names (topo-sort dependencies), and `others` are input
         field references or unknown identifiers.

##### exprDeps

```ts
exprDeps: Set<string>;
```

##### others

```ts
others: Set<string>;
```

***

<a id="toposort"></a>

### topoSort()

```ts
function topoSort(exprs): string[];
```

Defined in: packages/std/build/reckon/deps.d.ts:32

Topologically sort expr names by their dependencies.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `exprs` | `Map`\<`string`, `Set`\<`string`\>\> | Map of expr name → set of expr names it depends on |

#### Returns

`string`[]

Evaluation order (dependencies first)

#### Throws

if a cycle is detected
