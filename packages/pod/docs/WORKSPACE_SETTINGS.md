# Workspace settings

Pod owns tenant administration because its source of truth is the tenant database and its decisions
are enforced by the tenant runtime. The built-in Settings surface is part of the tenant shell on every
host; a managed host must not replace it with a parallel system-database administration UI.

## Sections and authority

| Section        | Authority                                                   | Behavior                                                                                         |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Members        | tenant `user` and `team_members` rows                       | Policy-scoped `CollectionTable`; membership changes emit the normal host event                   |
| Teams          | tenant `team` and `team_members` rows                       | SvelteFlow hierarchy; create action, tappable nodes and member assignment                        |
| Invitations    | tenant `invitation` rows and identity commands              | `CollectionTable` over a safe server projection; invitation secrets never enter the replica      |
| Roles & grants | source-declared policies reconciled to tenant `policy` rows | Read-only effective-policy inspection; definitions change in `src/policies`                      |
| Audit log      | tenant `audit_event` rows                                   | Policy-scoped `CollectionTable`; no host audit mirror                                            |
| Channels       | compiled manifest declarations                              | Lists channel key, transport and policy and links to host credential configuration when supplied |

The same collection and identity paths used by the rest of Pod back this UI. The surface does not
bypass policy, hooks, history, audit or sync to make administration convenient.

## Channel split

Channel configuration has two deliberately separate halves:

- tenant source declares the key, transport, policy and standing agent task in
  `src/channels/+<key>.channel.ts`;
- the active host holds the provider credential, socket/webhook and provider-specific connection
  status.

The declared key joins them. Pod owns principals, inbound deduplication, channel conversations,
agent runs and transcripts in the tenant database. A host can expose a credential-management link,
but it must not store or render a second conversation history.

## Host surfaces

Core-hosted plugins such as Workspace Studio or Hosting & Billing are mounted inside the tenant
shell at `/__host/<plugin-key>`, so system facilities do not erase workspace navigation. The mounted
document still authorizes itself. Standalone Pod simply omits host plugins; tenant Settings remains
fully available.
