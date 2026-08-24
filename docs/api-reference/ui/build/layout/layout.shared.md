[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/layout.shared

# ui/build/layout/layout.shared

## Type Aliases

<a id="columnparentcontext"></a>

### ColumnParentContext

```ts
type ColumnParentContext =
  | {
  kind: "grid";
}
  | {
  count: () => number;
  kind: "columns";
};
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:14

***

<a id="layoutattributes"></a>

### LayoutAttributes

```ts
type LayoutAttributes = Omit<HTMLAttributes<HTMLDivElement>, "children">;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:2

***

<a id="layoutelement"></a>

### LayoutElement

```ts
type LayoutElement =
  | "div"
  | "span"
  | "section"
  | "article"
  | "main"
  | "aside"
  | "header"
  | "footer"
  | "nav"
  | "form"
  | "fieldset"
  | "figure"
  | "figcaption"
  | "dl"
  | "ol"
  | "ul"
  | "li";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:11

The elements a layout primitive may render as.

The list is a whitelist of flow and inline *containers*, which is what keeps `as` from becoming a
way to render a layout primitive as a heading, a button, or anything else that carries behaviour
or typography of its own. Semantic sectioning elements belong here — the point of `as` is to let a
region be a `<section>` or an `<article>` without giving up the primitive's layout.

***

<a id="layoutgap"></a>

### LayoutGap

```ts
type LayoutGap = "none" | "xs" | "sm" | "md" | "lg" | "xl";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:12

***

<a id="layoutpad"></a>

### LayoutPad

```ts
type LayoutPad = Exclude<LayoutGap, "xl">;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:13

***

<a id="scrollaxis"></a>

### ScrollAxis

```ts
type ScrollAxis = "x" | "y" | "both";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:26

## Variables

<a id="column_parent_context"></a>

### COLUMN\_PARENT\_CONTEXT

```ts
const COLUMN_PARENT_CONTEXT: unique symbol;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:20

***

<a id="gap_classes"></a>

### GAP\_CLASSES

```ts
const GAP_CLASSES: Record<LayoutGap, string>;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:25

The gap scale. Every stacking primitive spends it; it is exported for the same reason
`INSET_MX_CLASS` is — a box that cannot be a primitive still owes the same rhythm.

***

<a id="inset_class"></a>

### INSET\_CLASS

```ts
const INSET_CLASS: "px-4 py-2 sm:px-6" = "px-4 py-2 sm:px-6";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:44

The one app inset: content regions. The only legal consumer is the single inset owner.

***

<a id="inset_mx_class"></a>

### INSET\_MX\_CLASS

```ts
const INSET_MX_CLASS: "mx-4 sm:mx-6" = "mx-4 sm:mx-6";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:48

Chrome that draws its own background and so cannot pad itself (tab list).

***

<a id="inset_x_class"></a>

### INSET\_X\_CLASS

```ts
const INSET_X_CLASS: "px-4 sm:px-6" = "px-4 sm:px-6";
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:46

Full-bleed chrome with its own vertical rhythm (`PageHeader`).

***

<a id="pad_classes"></a>

### PAD\_CLASSES

```ts
const PAD_CLASSES: Record<LayoutPad, string>;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:42

***

<a id="scroll_axis_classes"></a>

### SCROLL\_AXIS\_CLASSES

```ts
const SCROLL_AXIS_CLASSES: Record<ScrollAxis, string>;
```

Defined in: packages/ui/build/layout/layout.shared.d.ts:41

The scrollport classes, per axis — the one definition of what "this region scrolls" means.

Per-axis `overscroll-contain`: an x-only reel must not trap the parent's vertical scroll, and
the axis that does not scroll is *clipped* rather than left visible, so a wide child cannot
paint outside the region.

`Scroll` is how a region declares itself a scrollport, and is what almost every caller wants.
This token exists for the boxes `Scroll` cannot be: it fills its parent unconditionally, so a
pane bounded by its own `max-height` (a popover, a collapsible) or by a fixed height (a chip
reel) cannot be one — and neither can an element a third-party component or a ProseMirror
editor owns. Those honour the same contract by naming it, the way `INSET_MX_CLASS` lets chrome
that cannot pad itself still keep the app inset.
