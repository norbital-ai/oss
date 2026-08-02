---
'@norbital-ai/pod': patch
---

Export Drizzle's SQL expression builder from the workspace authoring surface so models can declare
read-only generated relational projections. This lets provenance variants retain their canonical
JSON audit record while exposing indexed foreign-key paths for nested queries.
