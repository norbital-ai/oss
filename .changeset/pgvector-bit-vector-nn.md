---
'@norbital-ai/pod': minor
'@norbital-ai/platform-utils': patch
---

Add pgvector support: bootstrap the `vector` extension, a single `vector()` column builder, HNSW/IVFFlat indexes, and server-only `findNearest` / `withinDistance` (cosine, L2, IP). One embedding path for PDQ-as-binary-vector, Gemini omni embeddings, and a future per-record system column.
