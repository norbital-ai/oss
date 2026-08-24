[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/combobox

# ui/build/combobox

## Interfaces

<a id="tclientconfig"></a>

### TClientConfig

Defined in: packages/ui/build/combobox/index.d.ts:162

Configuration for client-side filtering.

#### Properties

<a id="error"></a>

##### error?

```ts
optional error?: string | null;
```

Defined in: packages/ui/build/combobox/index.d.ts:166

An optional error message to display.

<a id="isloading"></a>

##### isLoading?

```ts
optional isLoading?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:164

An optional loading state, controlled by the parent.

***

<a id="tcomboboxbaseprops"></a>

### TComboboxBaseProps

Defined in: packages/ui/build/combobox/index.d.ts:78

Base properties shared across all combobox types.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | - |
| `TAdditionalProps` *extends* `Record`\<`string`, `unknown`\> | - |
| `TMultiple` *extends* `boolean` | `false` |

#### Properties

<a id="align"></a>

##### align?

```ts
optional align?: "start" | "end" | "center";
```

Defined in: packages/ui/build/combobox/index.d.ts:133

<a id="allowclear"></a>

##### allowClear?

```ts
optional allowClear?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:98

<a id="allowclicktosetnull"></a>

##### allowClickToSetNull?

```ts
optional allowClickToSetNull?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:100

When true, clicking an already-selected option clears the value (single-select only).

<a id="allowselectall"></a>

##### allowSelectAll?

```ts
optional allowSelectAll?: TMultiple extends true ? boolean : never;
```

Defined in: packages/ui/build/combobox/index.d.ts:86

Adds a keyboard-accessible row for selecting or clearing every loaded option.
Only available for client-side multi-select comboboxes without infinite loading.

<a id="arialabel"></a>

##### ariaLabel?

```ts
optional ariaLabel?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:119

Stable accessible name for the combobox trigger. Defaults to the current selection summary.

<a id="avoidcollisions"></a>

##### avoidCollisions?

```ts
optional avoidCollisions?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:148

When true, the dropdown is clamped to whichever viewport edge it collides with
instead of spilling past it: the preferred `side` is flipped and the alignment is
shifted along the anchor until the dropdown fits.

Handled natively by the underlying floating primitive (`flip` + `shift`), so the
position is re-evaluated on scroll and resize rather than only when the dropdown opens.

Set to `false` to pin the dropdown to `align` exactly and allow it to overflow.

###### Default

```ts
true
```

<a id="class"></a>

##### class?

```ts
optional class?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:129

<a id="collisionpadding"></a>

##### collisionPadding?

```ts
optional collisionPadding?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:156

Virtual padding, in pixels, inset from the viewport edges when detecting collisions.
Larger values keep the dropdown further away from the edge it clamps against.
Has no effect when `avoidCollisions` is `false`.

###### Default

```ts
8
```

<a id="disabled"></a>

##### disabled?

```ts
optional disabled?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:102

<a id="display"></a>

##### display?

```ts
optional display?: Snippet<[TMultiple extends true ? T[] : T]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:87

<a id="dropdownclass"></a>

##### dropdownClass?

```ts
optional dropdownClass?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:132

<a id="emptyplaceholder"></a>

##### emptyPlaceholder?

```ts
optional emptyPlaceholder?: string | Snippet<[]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:88

<a id="footer"></a>

##### footer?

```ts
optional footer?: Snippet<[]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:110

Optional custom footer content rendered at the bottom of the dropdown.

<a id="groupheaderheight"></a>

##### groupHeaderHeight?

```ts
optional groupHeaderHeight?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:123

<a id="header"></a>

##### header?

```ts
optional header?: Snippet<[]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:108

Optional content rendered directly under the search box (option filters, scope pickers).

<a id="hidechevron"></a>

##### hideChevron?

```ts
optional hideChevron?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:101

<a id="infiniteloadingconfig"></a>

##### infiniteLoadingConfig?

```ts
optional infiniteLoadingConfig?: TInfiniteLoadingConfig;
```

Defined in: packages/ui/build/combobox/index.d.ts:126

<a id="inlinecreateform"></a>

##### InlineCreateForm?

```ts
optional InlineCreateForm?: Snippet<[{
  cancel: () => void;
  newValue: string;
  onSuccess: (newOption) => void;
  setSubmitting: (v) => void;
  submitting: boolean;
}]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:89

<a id="invalid"></a>

##### invalid?

```ts
optional invalid?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:103

<a id="itemheight"></a>

##### itemHeight?

```ts
optional itemHeight?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:122

<a id="maxheight"></a>

##### maxHeight?

```ts
optional maxHeight?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:124

<a id="maxwidth"></a>

##### maxWidth?

```ts
optional maxWidth?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:135

<a id="minwidth"></a>

##### minWidth?

```ts
optional minWidth?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:134

<a id="multiple"></a>

##### multiple?

```ts
optional multiple?: TMultiple;
```

Defined in: packages/ui/build/combobox/index.d.ts:81

<a id="onvaluechange"></a>

##### onValueChange?

```ts
optional onValueChange?: (value) => void;
```

Defined in: packages/ui/build/combobox/index.d.ts:157

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `TMultiple` *extends* `true` ? `T`[] \| `null` : `T` \| `null` |

###### Returns

`void`

<a id="open"></a>

##### open?

```ts
optional open?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:116

<a id="options"></a>

##### options

```ts
options: TOption<T, TAdditionalProps>[];
```

Defined in: packages/ui/build/combobox/index.d.ts:79

<a id="overscan"></a>

##### overscan?

```ts
optional overscan?: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:125

<a id="preserveoptionorder"></a>

##### preserveOptionOrder?

```ts
optional preserveOptionOrder?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:115

When true, preserves the original `options` order exactly.
When false (default), the current selection is floated to the top for readability.

<a id="readonly"></a>

##### readonly?

```ts
optional readonly?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:104

<a id="readonlycontent"></a>

##### readonlyContent?

```ts
optional readonlyContent?: Snippet<[]>;
```

Defined in: packages/ui/build/combobox/index.d.ts:105

<a id="samewidth"></a>

##### sameWidth?

```ts
optional sameWidth?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:131

<a id="scrolltoselection"></a>

##### scrollToSelection?

```ts
optional scrollToSelection?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:128

When true, scroll the list to the current selection upon opening.

<a id="searchable"></a>

##### searchable?

```ts
optional searchable?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:120

<a id="searchplaceholder"></a>

##### searchPlaceholder?

```ts
optional searchPlaceholder?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:121

<a id="style"></a>

##### style?

```ts
optional style?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:117

<a id="triggerclass"></a>

##### triggerClass?

```ts
optional triggerClass?: string;
```

Defined in: packages/ui/build/combobox/index.d.ts:130

<a id="truncate"></a>

##### truncate?

```ts
optional truncate?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:106

<a id="value"></a>

##### value?

```ts
optional value?: TMultiple extends true ? T[] | null : T | null;
```

Defined in: packages/ui/build/combobox/index.d.ts:80

***

<a id="tcomboboxclientprops"></a>

### TComboboxClientProps

Defined in: packages/ui/build/combobox/index.d.ts:188

Properties for the client-side filtering combobox.

#### Properties

<a id="clientconfig"></a>

##### clientConfig?

```ts
optional clientConfig?: TClientConfig;
```

Defined in: packages/ui/build/combobox/index.d.ts:192

An optional object for client-side configurations like loading and error states.

<a id="serverconfig"></a>

##### serverConfig?

```ts
optional serverConfig?: undefined;
```

Defined in: packages/ui/build/combobox/index.d.ts:194

Server config is not applicable for client-side filtering.

<a id="type"></a>

##### type?

```ts
optional type?: "client";
```

Defined in: packages/ui/build/combobox/index.d.ts:190

Specifies that filtering is handled client-side.

***

<a id="tinfiniteloadingconfig"></a>

### TInfiniteLoadingConfig

Defined in: packages/ui/build/combobox/index.d.ts:58

Configuration for the infinite loading feature.
When provided, the component will monitor scroll position and request more data as needed.

#### Properties

<a id="handleinfiniteload"></a>

##### handleInfiniteLoad

```ts
handleInfiniteLoad: (info) => void;
```

Defined in: packages/ui/build/combobox/index.d.ts:70

A callback function triggered when the user scrolls near the end of the list.
The parent component is responsible for fetching more data and updating the `options` prop.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `info` | \{ `lastVirtualIndex`: `number`; `loadedCount`: `number`; \} | Details about the current state for fetching. |
| `info.lastVirtualIndex` | `number` | The index of the last rendered virtual item. |
| `info.loadedCount` | `number` | The number of items currently loaded in the component. |

###### Returns

`void`

<a id="hasmore"></a>

##### hasMore

```ts
hasMore: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:62

A boolean indicating if there are more items to fetch.

<a id="total"></a>

##### total

```ts
total: number;
```

Defined in: packages/ui/build/combobox/index.d.ts:60

The total number of items available on the server.

***

<a id="tserverconfig"></a>

### TServerConfig

Defined in: packages/ui/build/combobox/index.d.ts:171

Configuration for server-side filtering.

#### Properties

<a id="error-1"></a>

##### error?

```ts
optional error?: string | null;
```

Defined in: packages/ui/build/combobox/index.d.ts:183

An optional error message to display.

<a id="isloading-1"></a>

##### isLoading?

```ts
optional isLoading?: boolean;
```

Defined in: packages/ui/build/combobox/index.d.ts:181

Set to `true` to display a loading indicator. This should be managed by the parent.

<a id="onsearch"></a>

##### onSearch

```ts
onSearch: (query) => void;
```

Defined in: packages/ui/build/combobox/index.d.ts:177

**Required.** A callback that communicates the search query to the parent.
The parent is responsible for updating the `options` prop.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `query` | `string` | The current search string. |

###### Returns

`void`

## Type Aliases

<a id="tcomboboxcommanditem"></a>

### TComboboxCommandItem

```ts
type TComboboxCommandItem<T, TAdditionalProps> =
  | {
  _groupName: string;
  _type: "group";
  disabled: boolean;
  label: string;
  value: string;
}
  | {
  _allSelected: boolean;
  _selectedCount: number;
  _totalCount: number;
  _type: "select-all";
  label: string;
  value: string;
}
  | {
  _option: TOption<T, TAdditionalProps>;
  _type: "option";
  label: string;
  value: string;
}
  | {
  _type: "create";
  label: string;
  value: string;
};
```

Defined in: packages/ui/build/combobox/index.d.ts:31

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |
| `TAdditionalProps` *extends* `Record`\<`string`, `unknown`\> |

***

<a id="tcomboboxprops"></a>

### TComboboxProps

```ts
type TComboboxProps<T, TAdditionalProps, TMultiple> = TComboboxBaseProps<T, TAdditionalProps, TMultiple> &
  | TComboboxClientProps
  | TComboboxServerProps;
```

Defined in: packages/ui/build/combobox/index.d.ts:215

A discriminated union of combobox properties, providing strong type-safety
based on the filtering `type`.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` | - | The underlying data type of an option's value. |
| `TAdditionalProps` *extends* `Record`\<`string`, `unknown`\> | - | A record of extra props for the option label snippet. |
| `TMultiple` *extends* `boolean` | `false` | A boolean indicating if multi-select is enabled. |

***

<a id="toption"></a>

### TOption

```ts
type TOption<T, AP> = object;
```

Defined in: packages/ui/build/combobox/index.d.ts:8

Represents a single selectable option within the combobox.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The underlying data type of the option's value. |
| `AP` *extends* `Record`\<`string`, `unknown`\> | A record of additional properties for custom label rendering. |

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-additionallabelprops"></a> `additionalLabelProps?` | `AP` | Extra props to be spread into the label snippet for custom rendering. | packages/ui/build/combobox/index.d.ts:10 |
| <a id="property-badge"></a> `badge?` | `string` | Optional compact trailing label shown in the dropdown. | packages/ui/build/combobox/index.d.ts:27 |
| <a id="property-description"></a> `description?` | `string` | An optional longer description for the option. | packages/ui/build/combobox/index.d.ts:23 |
| <a id="property-icon"></a> `icon?` | `string` | Optional leading Iconify icon shown in the dropdown. | packages/ui/build/combobox/index.d.ts:25 |
| <a id="property-label"></a> `label` | `Snippet`\<\[`T`, `AP`, (`e`) => `void`\]\> \| `string` | The display label for the option. Can be a simple string or a Svelte Snippet for complex, custom rendering. | packages/ui/build/combobox/index.d.ts:15 |
| <a id="property-search_term"></a> `search_term?` | `string` | Additional text to be included during client-side filtering. | packages/ui/build/combobox/index.d.ts:29 |
| <a id="property-type"></a> `type?` | `string` | An optional category to group the option under. | packages/ui/build/combobox/index.d.ts:21 |
| <a id="property-value"></a> `value` | `T` | The unique value of the option. | packages/ui/build/combobox/index.d.ts:19 |
