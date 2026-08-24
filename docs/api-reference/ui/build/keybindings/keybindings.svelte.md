[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/keybindings/keybindings.svelte

# ui/build/keybindings/keybindings.svelte

## Type Aliases

<a id="key"></a>

### Key

```ts
type Key =
  | "backspace"
  | "tab"
  | "enter"
  | "shift(left)"
  | "shift(right)"
  | "ctrl(left)"
  | "ctrl(right)"
  | "alt(left)"
  | "alt(right)"
  | "pause/break"
  | "caps lock"
  | "escape"
  | "space"
  | "page up"
  | "page down"
  | "end"
  | "home"
  | "left arrow"
  | "up arrow"
  | "right arrow"
  | "down arrow"
  | "print screen"
  | "insert"
  | "delete"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "left window key"
  | "right window key"
  | "select key (Context Menu)"
  | "numpad 0"
  | "numpad 1"
  | "numpad 2"
  | "numpad 3"
  | "numpad 4"
  | "numpad 5"
  | "numpad 6"
  | "numpad 7"
  | "numpad 8"
  | "numpad 9"
  | "multiply"
  | "add"
  | "subtract"
  | "decimal point"
  | "divide"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12"
  | "num lock"
  | "scroll lock"
  | "audio volume mute"
  | "audio volume down"
  | "audio volume up"
  | "media player"
  | "launch application 1"
  | "launch application 2"
  | "semi-colon"
  | "equal sign"
  | "comma"
  | "dash"
  | "period"
  | "forward slash"
  | "Backquote/Grave accent"
  | "open bracket"
  | "back slash"
  | "close bracket"
  | "single quote";
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:25

***

<a id="options"></a>

### Options

```ts
type Options = object;
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:1

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-alt"></a> `alt?` | `boolean` | Should the `Alt` key be pressed | packages/ui/build/keybindings/keybindings.svelte.d.ts:11 |
| <a id="property-callback"></a> `callback` | (`e`) => `void` | Function to be called when the shortcut is pressed | packages/ui/build/keybindings/keybindings.svelte.d.ts:5 |
| <a id="property-ctrl"></a> `ctrl?` | `boolean` | Should the `Ctrl` / `Command` key be pressed | packages/ui/build/keybindings/keybindings.svelte.d.ts:9 |
| <a id="property-event"></a> `event?` | `"keydown"` \| `"keyup"` \| `"keypress"` | Event to use to detect the shortcut **Default** `'keydown'` | packages/ui/build/keybindings/keybindings.svelte.d.ts:3 |
| <a id="property-exactmatch"></a> `exactMatch?` | `boolean` | Control whether only the exact specified keys should be pressed (no additional modifiers) **Default** `true` | packages/ui/build/keybindings/keybindings.svelte.d.ts:19 |
| <a id="property-key"></a> `key` | [`Key`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#key) | Which key should be pressed | packages/ui/build/keybindings/keybindings.svelte.d.ts:13 |
| <a id="property-preventdefault"></a> `preventDefault?` | `boolean` | Control whether or not the shortcut prevents default behavior **Default** `true` | packages/ui/build/keybindings/keybindings.svelte.d.ts:15 |
| <a id="property-shift"></a> `shift?` | `boolean` | Should the `Shift` key be pressed | packages/ui/build/keybindings/keybindings.svelte.d.ts:7 |
| <a id="property-stoppropagation"></a> `stopPropagation?` | `boolean` | Control whether or not the shortcut stops propagation **Default** `false` | packages/ui/build/keybindings/keybindings.svelte.d.ts:17 |

***

<a id="shortcutmodifier"></a>

### ShortcutModifier

```ts
type ShortcutModifier = "⌘" | "Ctrl";
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:26

## Variables

<a id="shortcut"></a>

### shortcut

```ts
const shortcut: (node, options) => object;
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:21

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `node` | `HTMLElement` |
| `options` | \| [`Options`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#options)[] \| [`Options`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#options) |

#### Returns

`object`

##### destroy()

```ts
destroy(): void;
```

###### Returns

`void`

##### update()

```ts
update(newOptions): void;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `newOptions` | \| [`Options`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#options) \| [`Options`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#options)[] |

###### Returns

`void`

## Functions

<a id="detectshortcutmodifier"></a>

### detectShortcutModifier()

```ts
function detectShortcutModifier(): ShortcutModifier;
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:27

#### Returns

[`ShortcutModifier`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#shortcutmodifier)

***

<a id="formatshortcut"></a>

### formatShortcut()

```ts
function formatShortcut(modifier, key): string;
```

Defined in: packages/ui/build/keybindings/keybindings.svelte.d.ts:28

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `modifier` | [`ShortcutModifier`](/docs/api-reference/ui/build/keybindings/keybindings.svelte.md#shortcutmodifier) |
| `key` | `string` |

#### Returns

`string`
