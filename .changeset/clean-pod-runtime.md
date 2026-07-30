---
'@norbital-ai/platform-utils': minor
'@norbital-ai/pod': minor
---

Make Pod a self-contained tenant runtime with one AI chat binding, Pod-owned agents and synced
transcripts, transactional notification delivery, durable event automations, subscription-filtered
sync, standalone database notifications, exact compiler-generated collection/tool unions, explicit
Core versus self-hosted targets, and strict facility-gated startup. Tenant source no longer
duplicates host capabilities. The manifest now has one strict schema, compiler discovery uses one
source inventory, audit and sync writes are atomic with mutations, temporal history uses a
migration-safe typed table per collection backed by PostgreSQL's `temporal_tables` extension, and
file/agent records carry first-class requestor ownership. Schema migrations can proceed while
approvals are active because rollback reads the current typed history shape.

This is a clean break: raw tenant network access, host application plugins, the split inference
surface, and obsolete system collections are removed.
