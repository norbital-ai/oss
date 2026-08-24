[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/resource-scheduler/resource-scheduler.types

# ui/build/resource-scheduler/resource-scheduler.types

## Interfaces

<a id="resourceschedulercell"></a>

### ResourceSchedulerCell

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:18

#### Type Parameters

| Type Parameter |
| ------ |
| `TItem` *extends* [`ResourceSchedulerItem`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourcescheduleritem) |

#### Properties

<a id="end"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:21

<a id="items"></a>

##### items

```ts
readonly items: readonly TItem[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:22

<a id="resourceid"></a>

##### resourceId

```ts
readonly resourceId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:19

<a id="start"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:20

***

<a id="resourceschedulerchange"></a>

### ResourceSchedulerChange

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:24

#### Properties

<a id="end-1"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:28

<a id="itemid"></a>

##### itemId

```ts
readonly itemId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:25

<a id="resourceid-1"></a>

##### resourceId

```ts
readonly resourceId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:26

<a id="start-1"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:27

***

<a id="resourceschedulercollision"></a>

### ResourceSchedulerCollision

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:35

#### Properties

<a id="collidingitemids"></a>

##### collidingItemIds

```ts
readonly collidingItemIds: readonly string[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:41

<a id="end-2"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:40

<a id="itemid-1"></a>

##### itemId?

```ts
readonly optional itemId?: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:37

<a id="kind"></a>

##### kind

```ts
readonly kind: "create" | "move" | "resize";
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:36

<a id="resourceid-2"></a>

##### resourceId

```ts
readonly resourceId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:38

<a id="start-2"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:39

***

<a id="resourceschedulercreate"></a>

### ResourceSchedulerCreate

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:30

#### Properties

<a id="end-3"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:33

<a id="resourceid-3"></a>

##### resourceId

```ts
readonly resourceId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:31

<a id="start-3"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:32

***

<a id="resourcescheduleritem"></a>

### ResourceSchedulerItem

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:7

#### Properties

<a id="disabled"></a>

##### disabled?

```ts
readonly optional disabled?: boolean;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:13

<a id="editable"></a>

##### editable?

```ts
readonly optional editable?: boolean;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:14

<a id="end-4"></a>

##### end

```ts
readonly end: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:12

<a id="id"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:8

<a id="label"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:10

<a id="lockedreason"></a>

##### lockedReason?

```ts
readonly optional lockedReason?: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:15

<a id="resourceid-4"></a>

##### resourceId

```ts
readonly resourceId: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:9

<a id="start-4"></a>

##### start

```ts
readonly start: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:11

<a id="tone"></a>

##### tone?

```ts
readonly optional tone?: "default" | "destructive" | "warning" | "muted";
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:16

***

<a id="resourceschedulerprops"></a>

### ResourceSchedulerProps

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:48

#### Type Parameters

| Type Parameter |
| ------ |
| `TResource` *extends* [`ResourceSchedulerResource`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulerresource) |
| `TItem` *extends* [`ResourceSchedulerItem`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourcescheduleritem) |

#### Properties

<a id="anchordate"></a>

##### anchorDate

```ts
anchorDate: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:52

<a id="cellcontent"></a>

##### cellContent?

```ts
optional cellContent?: Snippet<[TResource, ResourceSchedulerCell<TItem>]>;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:65

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:62

<a id="daywidth"></a>

##### dayWidth?

```ts
optional dayWidth?: number;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:57

<a id="disabled-1"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:60

<a id="itemcontent"></a>

##### itemContent?

```ts
optional itemContent?: Snippet<[TItem]>;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:64

<a id="items-1"></a>

##### items

```ts
items: readonly TItem[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:50

<a id="layout"></a>

##### layout?

```ts
optional layout?: "matrix" | "timeline";
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:53

<a id="maxvisiblecellitems"></a>

##### maxVisibleCellItems?

```ts
optional maxVisibleCellItems?: number;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:59

<a id="oncellactivate"></a>

##### onCellActivate?

```ts
optional onCellActivate?: (cell) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:72

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `cell` | [`ResourceSchedulerCell`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulercell)\<`TItem`\> |

###### Returns

`void`

<a id="oncollision"></a>

##### onCollision?

```ts
optional onCollision?: (collision) => boolean | void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:70

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `collision` | [`ResourceSchedulerCollision`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulercollision) |

###### Returns

`boolean` \| `void`

<a id="oncreate"></a>

##### onCreate?

```ts
optional onCreate?: (change) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:67

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `change` | [`ResourceSchedulerCreate`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulercreate) |

###### Returns

`void`

<a id="onitemactivate"></a>

##### onItemActivate?

```ts
optional onItemActivate?: (item) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:71

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `item` | `TItem` |

###### Returns

`void`

<a id="onmove"></a>

##### onMove?

```ts
optional onMove?: (change) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:68

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `change` | [`ResourceSchedulerChange`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulerchange) |

###### Returns

`void`

<a id="onresize"></a>

##### onResize?

```ts
optional onResize?: (change) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:69

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `change` | [`ResourceSchedulerChange`](/docs/api-reference/ui/build/resource-scheduler/resource-scheduler.types.md#resourceschedulerchange) |

###### Returns

`void`

<a id="onselectionchange"></a>

##### onSelectionChange?

```ts
optional onSelectionChange?: (itemIds) => void;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:66

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `itemIds` | `string`[] |

###### Returns

`void`

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:61

<a id="resourcecontent"></a>

##### resourceContent?

```ts
optional resourceContent?: Snippet<[TResource]>;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:63

<a id="resourcelabel"></a>

##### resourceLabel?

```ts
optional resourceLabel?: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:58

<a id="resources"></a>

##### resources

```ts
resources: readonly TResource[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:49

<a id="resourcewidth"></a>

##### resourceWidth?

```ts
optional resourceWidth?: number;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:56

<a id="rowheight"></a>

##### rowHeight?

```ts
optional rowHeight?: number;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:55

<a id="selecteditemids"></a>

##### selectedItemIds?

```ts
optional selectedItemIds?: readonly string[];
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:54

<a id="view"></a>

##### view

```ts
view: "month" | "week";
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:51

***

<a id="resourceschedulerresource"></a>

### ResourceSchedulerResource

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:2

#### Properties

<a id="description"></a>

##### description?

```ts
readonly optional description?: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:5

<a id="id-1"></a>

##### id

```ts
readonly id: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:3

<a id="label-1"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:4

## Type Aliases

<a id="resourceschedulerplacement"></a>

### ResourceSchedulerPlacement

```ts
type ResourceSchedulerPlacement = Omit<ResourceSchedulerCollision, "kind" | "collidingItemIds">;
```

Defined in: packages/ui/build/resource-scheduler/resource-scheduler.types.d.ts:47

The placement a collision check is asked about: the same shape as a collision, minus the two
facts the check itself establishes.
