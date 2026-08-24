[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/tabs/tabs.types

# ui/build/tabs/tabs.types

## Type Aliases

<a id="tabconfig"></a>

### TabConfig

```ts
type TabConfig = object;
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:6

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-content"></a> `content` | `Snippet` \| `string` | - | packages/ui/build/tabs/tabs.types.d.ts:9 |
| <a id="property-description"></a> `description?` | `string` | Tooltip and `aria-label` when the visible label is omitted or empty. | packages/ui/build/tabs/tabs.types.d.ts:15 |
| <a id="property-disabled"></a> `disabled?` | `boolean` | - | packages/ui/build/tabs/tabs.types.d.ts:16 |
| <a id="property-icon"></a> `icon?` | `string` | Optional Iconify id or canonical `product:*` reference rendered before the label. | packages/ui/build/tabs/tabs.types.d.ts:13 |
| <a id="property-keepalive"></a> `keepAlive?` | `boolean` | - | packages/ui/build/tabs/tabs.types.d.ts:17 |
| <a id="property-label"></a> `label?` | `string` \| `Snippet` | Visible label or custom trigger when `name` is a string id. | packages/ui/build/tabs/tabs.types.d.ts:11 |
| <a id="property-lazyload"></a> `lazyLoad?` | `boolean` | - | packages/ui/build/tabs/tabs.types.d.ts:18 |
| <a id="property-name"></a> `name` | `string` \| `Snippet` | Tab id and default label when `label` is omitted. Or a snippet trigger (auto id `tab-${index}`). | packages/ui/build/tabs/tabs.types.d.ts:8 |

***

<a id="tablistlayout"></a>

### TabListLayout

```ts
type TabListLayout = "horizontal" | "vertical" | "responsive";
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:5

***

<a id="tablistsemantics"></a>

### TabListSemantics

```ts
type TabListSemantics = "default" | "info" | "warning" | "danger" | "success";
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:4

***

<a id="tablistvariant"></a>

### TabListVariant

```ts
type TabListVariant = "default" | "underline" | "chip";
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:3

***

<a id="tabsprops"></a>

### TabsProps

```ts
type TabsProps = object;
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:20

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-animate"></a> `animate?` | `boolean` | packages/ui/build/tabs/tabs.types.d.ts:33 |
| <a id="property-class"></a> `class?` | `string` | packages/ui/build/tabs/tabs.types.d.ts:24 |
| <a id="property-config"></a> `config` | [`TabConfig`](/docs/api-reference/ui/build/tabs/tabs.types.md#tabconfig)[] | packages/ui/build/tabs/tabs.types.d.ts:21 |
| <a id="property-contentpadding"></a> `contentPadding?` | `boolean` | packages/ui/build/tabs/tabs.types.d.ts:27 |
| <a id="property-header"></a> `header?` | `Snippet`\<\[\{ `list`: `Snippet`; \}\]\> | packages/ui/build/tabs/tabs.types.d.ts:35 |
| <a id="property-keepalive-1"></a> `keepAlive?` | `boolean` | packages/ui/build/tabs/tabs.types.d.ts:31 |
| <a id="property-layout"></a> `layout?` | [`TabListLayout`](/docs/api-reference/ui/build/tabs/tabs.types.md#tablistlayout) | packages/ui/build/tabs/tabs.types.d.ts:30 |
| <a id="property-lazyload-1"></a> `lazyLoad?` | `boolean` | packages/ui/build/tabs/tabs.types.d.ts:32 |
| <a id="property-listclass"></a> `listClass?` | `string` | packages/ui/build/tabs/tabs.types.d.ts:25 |
| <a id="property-listprefix"></a> `listPrefix?` | `Snippet` | packages/ui/build/tabs/tabs.types.d.ts:38 |
| <a id="property-liststyle"></a> `listStyle?` | `string` | packages/ui/build/tabs/tabs.types.d.ts:26 |
| <a id="property-listsuffix"></a> `listSuffix?` | `Snippet` | packages/ui/build/tabs/tabs.types.d.ts:39 |
| <a id="property-onvaluechange"></a> `onValueChange?` | (`value`) => `void` | packages/ui/build/tabs/tabs.types.d.ts:23 |
| <a id="property-semantics"></a> `semantics?` | [`TabListSemantics`](/docs/api-reference/ui/build/tabs/tabs.types.md#tablistsemantics) | packages/ui/build/tabs/tabs.types.d.ts:29 |
| <a id="property-showcontent"></a> `showContent?` | `boolean` | packages/ui/build/tabs/tabs.types.d.ts:34 |
| <a id="property-value"></a> `value?` | `string` | packages/ui/build/tabs/tabs.types.d.ts:22 |
| <a id="property-variant"></a> `variant?` | [`TabListVariant`](/docs/api-reference/ui/build/tabs/tabs.types.md#tablistvariant) | packages/ui/build/tabs/tabs.types.d.ts:28 |

## Variables

<a id="workspace_tab_trigger_text_class"></a>

### WORKSPACE\_TAB\_TRIGGER\_TEXT\_CLASS

```ts
const WORKSPACE_TAB_TRIGGER_TEXT_CLASS: "text-xs font-medium" = "text-xs font-medium";
```

Defined in: packages/ui/build/tabs/tabs.types.d.ts:2
