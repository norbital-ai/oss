# Workspace settings

Pod owns tenant administration because its source of truth is the tenant database and its decisions
are enforced by the tenant runtime. The built-in Settings surface is part of the tenant shell on every
host; a managed host must not replace it with a parallel system-database administration UI.

## Sections and authority

| Tab         | Authority                             | Behavior                                                                                   |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Members     | tenant `user` and `team_members`      | Runtime roles and membership; rendered with the shared `CollectionTable`                   |
| Invitations | tenant invitation service             | Safe projection in the same page; invitation credentials never replicate                   |
| Teams       | tenant `team` and `team_members` rows | SvelteFlow hierarchy; create action, tappable nodes, member and declared-policy assignment |
| Audit log   | tenant `audit_event` rows             | Policy-scoped `CollectionTable`; no host audit mirror                                      |

Workspace env values are not a Settings tab. The tenant declares names in `src/+env.ts`; an
operator pastes values in **Settings → Integrations**, the same tab as channel credentials. See
[Environment](./ENVIRONMENT.md).

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

Conversation scope is owned by Pod, not the host plugin:

- administrators can read all web and channel transcripts, but other users' conversations are
  read-only;
- members can read their own web conversations and authenticated channel DMs;
- members can read authenticated group transcripts when an active team they belong to holds that
  channel profile's policy;
- public channel transcripts have no member owner and remain administrator-only;
- all channel transcripts are read-only in the Agent UI because replies continue on the transport.

## Host surfaces

Core-hosted plugins are mounted inside the tenant shell without entering the Pod bundle. Host
facilities sit beneath Pod's Settings folder as separate children. Core currently contributes
Transport credentials, Profile and Billing; it does not add a second settings menu inside any of
those pages. Authoring tools such as Workspace Studio remain standalone navigation entries. These surfaces are mounted inside the tenant
shell at `/__host/<plugin-key>`, so system facilities do not erase workspace navigation. The mounted
document still authorizes itself. Standalone Pod simply omits host plugins; tenant Settings remains
fully available.
