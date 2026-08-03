---
'@norbital-ai/platform-utils': patch
---

Scope the seed executor's user-id-by-email cache to one tenant.

A `user` payload's relationship links cannot use the id in the payload: `insertSeedRows` upserts
users on `email` and deliberately leaves `norbital_id` alone, so a person the tenant already has —
the founder, written by provisioning before any seed runs — keeps the id they were provisioned
with. The executor therefore reads the id back out of the database by address before writing the
`team_members` rows.

That read was memoised in a module-level `Map` keyed on the address alone. One process seeds every
tenant in a full environment reset, so the first tenant to write an address decided its id for all
of them. Two templates seed `zuyao.liu@norbital.ai` under different ids, and whichever ran second
inserted a `team_members` row pointing at a `user` row that exists only in the other tenant's
database — `team_members_user_id_user_norbital_id_fkey`, and the reset exited 1.

The cache is now created per `seedTemplateDataFromPlan` call, which is one tenant, matching
`seedTableMetadataCache` beside it. The memoisation itself is unchanged, so a tenant that already
holds an address still links to the id it already has rather than the payload's.
