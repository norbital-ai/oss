---
'@norbital-ai/pod': minor
'@norbital-ai/platform-utils': patch
---

Allow server-side authoring AI calls to send explicitly selected workspace image assets and receive schema-validated structured output. Image bytes remain binary across the host boundary, image access is checked through `document_asset`, and transactional hook capability restrictions are unchanged.
