// `@norbital-ai/ui/brand` (final-ui §7.4 "Brand"): the product's own marks for the shell, the host and the website, never
// a workspace's. `AccretionDisc` is the agent's orb and the full-surface loading mark; `attachDotField` draws any
// dot-field geometry; `NorbiusStrip` is Norbius's mark in the shell's chrome. `AccessFrame` is the access pages' one look
// (Bolt's sign-in, a host's workspace picker) over `NorbiusField`, the band at page scale.
export { default as AccessFrame } from './access-frame.svelte';
export { default as AccretionDisc } from './accretion-disc.svelte';
export { accretionDiscGeometry } from './accretion-geometry.js';
export { attachDotField, type DotFieldOptions, type DotGeometry, type DotPoint } from './dot-field.js';
export { FEATURE_COLORS, type FeatureColorKey, type FeatureColorStyles } from './feature-colors.js';
export { default as NorbiusStrip } from './norbius-strip.svelte';
export { default as NorbiusField } from './norbius-field.svelte';
export { NORBIUS_STRIP_STATES, type NorbiusStripState } from './norbius-geometry.js';
