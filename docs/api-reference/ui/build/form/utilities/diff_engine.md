[**Norbital API Reference v0.0.1**](../../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/utilities/diff\_engine

# ui/build/form/utilities/diff\_engine

## Functions

<a id="comparewithidentity"></a>

### compareWithIdentity()

```ts
function compareWithIdentity(initial, current): object[];
```

Defined in: packages/ui/build/form/utilities/diff\_engine.d.ts:29

Compare two objects with identity-aware array handling.
Arrays of objects with 'id' or 'id' keys are compared by identity,
not by position. This prevents false positives when items are reordered
or deleted from the middle of an array.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `initial` | `unknown` | The original object state |
| `current` | `unknown` | The new/modified object state |

#### Returns

`object`[]

RFC 6902 JSON Patch operations

#### Example

```ts
const original = { tasks: [{ id: 1, text: "A" }, { id: 2, text: "B" }] };
const modified = { tasks: [{ id: 1, text: "A modified" }] }; // id 2 deleted

compareWithIdentity(original, modified);
// Returns: [
//   { op: "replace", path: "/tasks/1/text", value: "A modified" },
//   { op: "remove", path: "/tasks/2" }
// ]
```

***

<a id="getchangesforpath"></a>

### getChangesForPath()

```ts
function getChangesForPath(
   operations,
   path,
   baseline?): object[];
```

Defined in: packages/ui/build/form/utilities/diff\_engine.d.ts:39

Get changes for a specific path from a list of operations.
Converts dot-notation path to JSON Pointer format for matching.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `operations` | `object`[] | Array of RFC 6902 operations |
| `path` | `string` | Dot-notation path (e.g., 'user.name', 'items.0.text') |
| `baseline?` | `unknown` | Optional object to resolve identity-aware paths against |

#### Returns

`object`[]

Array of operations affecting this path

***

<a id="haschangesforpath"></a>

### hasChangesForPath()

```ts
function hasChangesForPath(
   operations,
   path,
   baseline?): boolean;
```

Defined in: packages/ui/build/form/utilities/diff\_engine.d.ts:48

Check if a specific path has any changes.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `operations` | `object`[] | Array of RFC 6902 operations |
| `path` | `string` | Dot-notation path (e.g., 'user.name', 'items.0.text') |
| `baseline?` | `unknown` | Optional object to resolve identity-aware paths against |

#### Returns

`boolean`

True if there are any changes at or under this path
