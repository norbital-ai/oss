---
"@norbital-ai/pod": minor
"@norbital-ai/ui": minor
---

Add app and record-detail banner media with fixed-size fallbacks.

- `@norbital-ai/pod` compiles a static `pod:banner` from `+representation.svelte` `<svelte:head>` metadata and emits it on the generated collection surface, alongside the existing app `pod:thumbnail` / `pod:banner`.
- `@norbital-ai/ui` renders the collection banner as a fixed-height image above the record detail sheet header (`CollectionRecordDetailTabs`), and app cards / omni finder keep same-size media slots when no thumbnail exists (16:9 icon tile on cards, fixed 6x6 tile in the finder).
