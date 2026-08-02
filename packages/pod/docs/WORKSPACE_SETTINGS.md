# Workspace settings

Pod owns tenant administration because its source of truth is the tenant database and its decisions
are enforced by the tenant runtime. The built-in Settings surface is part of the tenant shell on every
host; a managed host must not replace it with a parallel system-database administration UI.

## Sections and authority

| Section   | Authority                                     | Behavior                                                                                    |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| People    | tenant `user`, `team_members` and invitations | Members and Invitations tabs; safe table projections never replicate invitation credentials |
| Teams     | tenant `team` and `team_members` rows         | SvelteFlow hierarchy; create action, tappable nodes, member and declared-policy assignment  |
| Audit log | tenant `audit_event` rows                     | Policy-scoped `CollectionTable`; no host audit mirror                                       |

Policies and channels are not runtime settings. They are compile-time workspace declarations in
`src/policies` and `src/channels`, exposed read-only through a host authoring surface's compiled
Manifest. Settings may assign a declared policy to a tenant-owned team, but it never edits the
policy or its grants.

The same collection and identity paths used by the rest of Pod back this UI. The surface does not
bypass policy, hooks, history, audit or sync to make administration convenient.

## Channel split

Channel configuration has two deliberately separate halves:

- tenant source declares the key, transport, policy and standing agent task in
  `src/channels/+<key>.channel.ts`;
- the active host holds the provider credential, socket/webhook and provider-specific connection
  status.

The declared key joins them. Pod owns principals, inbound deduplication, channel conversations,
agent runs and transcripts in the tenant database. A host may expose its own credential-management
surface as a separate plugin, but Settings does not redirect into it and the host must not store or
render a second conversation history.

## Host surfaces

Core-hosted plugins such as Workspace Studio or Hosting & Billing are mounted inside the tenant
shell at `/__host/<plugin-key>`, so system facilities do not erase workspace navigation. The mounted
document still authorizes itself. Standalone Pod simply omits host plugins; tenant Settings remains
fully available.
