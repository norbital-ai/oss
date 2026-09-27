// The layout layer (§3.6 `./layout`): the layoutPack primitives and AppShell. Inset and scroll-port context stay internal.
export { default as AppShell, type AppShellProps, type AppShellVariant } from './app-shell.svelte';
export { getAppIdentitySlot, setAppIdentitySlot, type AppIdentity, type AppIdentitySlot } from './app-identity.svelte.js';
export { default as Bound, type BoundProps, type BoundSize } from './bound.svelte';
export { default as Center, type CenterMeasure, type CenterProps } from './center.svelte';
export { default as Cluster, type ClusterProps } from './cluster.svelte';
export { default as Column, type ColumnProps, type ColumnSpan } from './column.svelte';
export { default as Columns, type ColumnCount, type ColumnsProps } from './columns.svelte';
export { default as Cover, type CoverProps } from './cover.svelte';
export { default as Frame, type FrameProps, type FrameRatio } from './frame.svelte';
export { default as Grid, type GridMinimum, type GridProps } from './grid.svelte';
export { default as Imposter, type ImposterPlacement, type ImposterProps } from './imposter.svelte';
export { default as Inline, type InlineProps } from './inline.svelte';
export { default as Scroll, type ScrollProps } from './scroll.svelte';
export { default as Split, type SplitCollapse, type SplitProps, type SplitRatio } from './split.svelte';
export { default as Stack, type StackProps } from './stack.svelte';
export { insetReader, ownInset, provisionalInset, resetInset } from './inset.svelte.js';
export { INSET_MX_CLASS, SCROLL_AXIS_CLASSES, type LayoutGap, type LayoutPad } from './layout.shared.js';
// ponytail: legacy bolt client modules (studio) still read these through `./layout`; drop with them
export { INSET_CLASS, INSET_X_CLASS } from './layout.shared.js';
