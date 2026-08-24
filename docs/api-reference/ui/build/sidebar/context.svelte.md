[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/sidebar/context.svelte

# ui/build/sidebar/context.svelte

## Variables

<a id="setsidebarcontext"></a>

### setSidebarContext

```ts
const setSidebarContext: (context) => () => SidebarState;
```

Defined in: packages/ui/build/sidebar/context.svelte.d.ts:30

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | () => `SidebarState` |

#### Returns

() => `SidebarState`

***

<a id="usesidebar"></a>

### useSidebar

```ts
const useSidebar: () => () => SidebarState;
```

Defined in: packages/ui/build/sidebar/context.svelte.d.ts:30

#### Returns

() => `SidebarState`

## Functions

<a id="setsidebar"></a>

### setSidebar()

```ts
function setSidebar(props): SidebarState;
```

Defined in: packages/ui/build/sidebar/context.svelte.d.ts:37

Instantiates a new `SidebarState` instance and sets it in the context.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | `SidebarStateProps` | The constructor props for the `SidebarState` class. |

#### Returns

`SidebarState`

The `SidebarState` instance.
