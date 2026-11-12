# Identity lifecycle and automations

Native identity administration stores invitations, users, source-team affiliation and their history.
Its row changes, captures and history commit together through the identity port. These writes do
not subscribe or start tenant automations. An automation's `on` contains cron triggers only.

An invitation creates `sys_invitation` immediately. Acceptance follows address proof and creates
or links `sys_user`, applying the invitation's source team. Policies may grant scoped identity
outputs for reads; identity writes remain native administrator operations. Ledgers and API keys
cannot be granted to template policies.

Daily retention removes unreferenced invitations 90 days after their expiry, acceptance or
revocation, whichever is latest. Expired invitations within that window can still be resent.

When a workspace needs a business profile for an invitation or accepted member, use an explicit
automation or cron reconciliation under declared policies. Read the required identity output and
write the business model through `ctx.act`; unique matching constraints and a stable act key make
reconciliation repeatable. Refuse ambiguous existing profiles. This is authored business work,
not an implicit identity event hook.

The command center's People uses the `sys_user` model table. Its Invite dialog accepts one person
or a bulk CSV with `email`, `phone`, `team` and `external`, up to 1,000 rows. Bulk invitations
validate the complete batch before saving, and all invitation rows commit together. Delivery
then attempts every invitation; failed IDs are returned for resending without recreating rows.
Bulk API inputs accept the same source team handle, external flag and party reference as
individual invitations.
