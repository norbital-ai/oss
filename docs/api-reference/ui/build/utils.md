[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/utils

# ui/build/utils

## Classes

<a id="rendercomponentconfig"></a>

### RenderComponentConfig

Defined in: packages/ui/build/utils/index.d.ts:39

A helper class to make it easy to identify Svelte components in
`columnDef.cell` and `columnDef.header` properties.

> NOTE: This class should only be used internally by the adapter. If you're
reading this and you don't know what this is for, you probably don't need it.

#### Example

The cast below is illustrative for the JSDoc snippet only — not runtime code.
```svelte
{@const result = content(context as any)}
{#if result instanceof RenderComponentConfig}
  {@const { component: Component, props } = result}
  <Component {...props} />
{/if}
```

#### Type Parameters

| Type Parameter |
| ------ |
| `TComponent` *extends* `Component`\<`Record`\<`string`, `never`\>\> |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new RenderComponentConfig<TComponent>(component, props?): RenderComponentConfig<TComponent>;
```

Defined in: packages/ui/build/utils/index.d.ts:42

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `component` | `TComponent` |
| `props?` | `Record`\<`string`, `never`\> \| `ComponentProps`\<`TComponent`\> |

###### Returns

[`RenderComponentConfig`](/docs/api-reference/ui/build/utils.md#rendercomponentconfig)\<`TComponent`\>

#### Properties

<a id="component"></a>

##### component

```ts
component: TComponent;
```

Defined in: packages/ui/build/utils/index.d.ts:40

<a id="props"></a>

##### props

```ts
props: Record<string, never> | ComponentProps<TComponent>;
```

Defined in: packages/ui/build/utils/index.d.ts:41

***

<a id="rendersnippetconfig"></a>

### RenderSnippetConfig

Defined in: packages/ui/build/utils/index.d.ts:60

A helper class to make it easy to identify Svelte Snippets in `columnDef.cell` and `columnDef.header` properties.

> NOTE: This class should only be used internally by the adapter. If you're
reading this and you don't know what this is for, you probably don't need it.

#### Example

The cast below is illustrative for the JSDoc snippet only — not runtime code.
```svelte
{@const result = content(context as any)}
{#if result instanceof RenderSnippetConfig}
  {@const { snippet, params } = result}
  {@render snippet(params)}
{/if}
```

#### Type Parameters

| Type Parameter |
| ------ |
| `TProps` |

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new RenderSnippetConfig<TProps>(snippet, params): RenderSnippetConfig<TProps>;
```

Defined in: packages/ui/build/utils/index.d.ts:63

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `snippet` | `Snippet`\<\[`TProps`\]\> |
| `params` | `TProps` |

###### Returns

[`RenderSnippetConfig`](/docs/api-reference/ui/build/utils.md#rendersnippetconfig)\<`TProps`\>

#### Properties

<a id="params"></a>

##### params

```ts
params: TProps;
```

Defined in: packages/ui/build/utils/index.d.ts:62

<a id="snippet"></a>

##### snippet

```ts
snippet: Snippet<[TProps]>;
```

Defined in: packages/ui/build/utils/index.d.ts:61

## Type Aliases

<a id="withelementref"></a>

### WithElementRef

```ts
type WithElementRef<T, U> = T & object;
```

Defined in: packages/ui/build/utils/index.d.ts:19

#### Type Declaration

##### ref?

```ts
optional ref?: U | null;
```

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | - |
| `U` *extends* `HTMLElement` | `HTMLElement` |

***

<a id="withoutchild"></a>

### WithoutChild

```ts
type WithoutChild<T> = T extends object ? Omit<T, "child"> : T;
```

Defined in: packages/ui/build/utils/index.d.ts:12

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

<a id="withoutchildren"></a>

### WithoutChildren

```ts
type WithoutChildren<T> = T extends object ? Omit<T, "children"> : T;
```

Defined in: packages/ui/build/utils/index.d.ts:15

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

<a id="withoutchildrenorchild"></a>

### WithoutChildrenOrChild

```ts
type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
```

Defined in: packages/ui/build/utils/index.d.ts:18

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

## Variables

<a id="default_css"></a>

### DEFAULT\_CSS

```ts
const DEFAULT_CSS: object;
```

Defined in: packages/ui/build/utils/index.d.ts:5

#### Type Declaration

<a id="input_element"></a>

##### INPUT\_ELEMENT

```ts
INPUT_ELEMENT: object;
```

###### INPUT\_ELEMENT.PX

```ts
PX: number;
```

###### INPUT\_ELEMENT.REM

```ts
REM: number;
```

###### INPUT\_ELEMENT.TW\_UNIT

```ts
TW_UNIT: number;
```

## Functions

<a id="cn"></a>

### cn()

```ts
function cn(...inputs): string;
```

Defined in: packages/ui/build/utils/index.d.ts:3

#### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`inputs` | `ClassValue`[] |

#### Returns

`string`

***

<a id="formatfilesize"></a>

### formatFileSize()

```ts
function formatFileSize(bytes): string;
```

Defined in: packages/ui/build/utils/index.d.ts:4

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `bytes` | `number` |

#### Returns

`string`

***

<a id="parseservertimestamp"></a>

### parseServerTimestamp()

```ts
function parseServerTimestamp(input): Date | null;
```

Defined in: packages/ui/build/utils/index.d.ts:114

Parses a stored UTC ISO instant for display in the local timezone.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `string` |

#### Returns

`Date` \| `null`

***

<a id="parseutcinstantzoned"></a>

### parseUtcInstantZoned()

```ts
function parseUtcInstantZoned(value): ZonedDateTime;
```

Defined in: packages/ui/build/utils/index.d.ts:116

Parse a stored UTC ISO instant for calendar/time pickers (local timezone).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `string` |

#### Returns

`ZonedDateTime`

***

<a id="rendercomponent"></a>

### renderComponent()

```ts
function renderComponent<T, Props>(component, props): RenderComponentConfig<T>;
```

Defined in: packages/ui/build/utils/index.d.ts:87

A helper function to help create cells from Svelte components through ColumnDef's `cell` and `header` properties.

This is only to be used with Svelte Components - use `renderSnippet` for Svelte Snippets.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `Component`\<`Record`\<`string`, `never`\>, \{ \}, `string`\> |
| `Props` *extends* `Record`\<`string`, `never`\> |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `component` | `T` | A Svelte component |
| `props` | `Props` | The props to pass to `component` |

#### Returns

[`RenderComponentConfig`](/docs/api-reference/ui/build/utils.md#rendercomponentconfig)\<`T`\>

A `RenderComponentConfig` object that helps svelte-table know how to render the header/cell component.

#### Example

```ts
// +page.svelte
const defaultColumns = [
  columnHelper.accessor('name', {
    header: header => renderComponent(SortHeader, { label: 'Name', header }),
  }),
  columnHelper.accessor('state', {
    header: header => renderComponent(SortHeader, { label: 'State', header }),
  }),
]
```

#### See

[https://tanstack.com/table/latest/docs/guide/column-defs](https://tanstack.com/table/latest/docs/guide/column-defs)

***

<a id="rendersnippet"></a>

### renderSnippet()

```ts
function renderSnippet<TProps>(snippet, params): RenderSnippetConfig<TProps>;
```

Defined in: packages/ui/build/utils/index.d.ts:112

A helper function to help create cells from Svelte Snippets through ColumnDef's `cell` and `header` properties.

The snippet must only take one parameter.

This is only to be used with Snippets - use `renderComponent` for Svelte Components.

#### Type Parameters

| Type Parameter |
| ------ |
| `TProps` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `snippet` | `Snippet`\<\[`TProps`\]\> | - |
| `params` | `TProps` | - |

#### Returns

[`RenderSnippetConfig`](/docs/api-reference/ui/build/utils.md#rendersnippetconfig)\<`TProps`\>

- A `RenderSnippetConfig` object that helps svelte-table know how to render the header/cell snippet.

#### Example

```ts
// +page.svelte
const defaultColumns = [
  columnHelper.accessor('name', {
    cell: cell => renderSnippet(nameSnippet, { name: cell.row.name }),
  }),
  columnHelper.accessor('state', {
    cell: cell => renderSnippet(stateSnippet, { state: cell.row.state }),
  }),
]
```

#### See

[https://tanstack.com/table/latest/docs/guide/column-defs](https://tanstack.com/table/latest/docs/guide/column-defs)

## References

<a id="formatdaterangelocal"></a>

### formatDateRangeLocal

Re-exports [formatDateRangeLocal](/docs/api-reference/std/build/date.md#formatdaterangelocal)

***

<a id="formatutcinstantlocal"></a>

### formatUtcInstantLocal

Re-exports [formatUtcInstantLocal](/docs/api-reference/std/build/date.md#formatutcinstantlocal)

***

<a id="scrollalignment"></a>

### ScrollAlignment

Re-exports [ScrollAlignment](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrollalignment)

***

<a id="scrolltoindexoptions"></a>

### ScrollToIndexOptions

Re-exports [ScrollToIndexOptions](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrolltoindexoptions)

***

<a id="scrolltooffsetoptions"></a>

### ScrollToOffsetOptions

Re-exports [ScrollToOffsetOptions](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#scrolltooffsetoptions)

***

<a id="virtualitem"></a>

### VirtualItem

Re-exports [VirtualItem](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualitem)

***

<a id="virtualizer"></a>

### Virtualizer

Re-exports [Virtualizer](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualizer)

***

<a id="virtualizeroptions"></a>

### VirtualizerOptions

Re-exports [VirtualizerOptions](/docs/api-reference/ui/build/utils/virtualizer.svelte.md#virtualizeroptions)
