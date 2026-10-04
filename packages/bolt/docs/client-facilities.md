# Optional client facilities and app sessions

Hosts may supply `window.boltHostFacilities` or `mountShell`'s `facilities`. Native geolocation takes precedence; otherwise Bolt uses browser geolocation. Native permission denial never changes providers. Availability supplies no server authority.

Native `geolocation.background` optionally supplies `status(): Promise<{ enabled: boolean; always: boolean }>` and `openSettings(): Promise<void>`. A foreground fix does not prove background authorization. These methods cannot grant permission or guarantee execution after OS termination.

`src/app/<app>/+session.svelte` runs for signed-in callers whose boot navigation grants that app, including workspace home and other shell screens. It shares `$bolt`, remains mounted across SPA navigation, and is disposed with the signed-in client/shell. Visitors and callers without that app do not mount it. Use Svelte cleanup for watchers/listeners. This client lifecycle grants no server policy and cannot survive native process termination.
