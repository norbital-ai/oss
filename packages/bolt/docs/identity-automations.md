# Identity automation events

Automations can subscribe to `created`, `updated`, and `deleted` events on readable system models, including `sys_user` and `sys_invitation`. Identity administration queues matching runs in the same database statement as its row changes, and that commit wakes the run queue for them.

An invitation creates `sys_invitation` immediately. A new `sys_user` is created when the invitee proves their address and accepts. Subscribe to invitations to provision a profile before acceptance, and to users to link the accepted identity. A policy can grant read access to invitations; identity model writes remain restricted to administrator verbs. Ledgers and API keys cannot be granted to template policies.

The HR template ships `invitation_profile`: staff invitations create or reuse `employment_profile`; external invitations are excluded. Profiles keep an optional invitation reference and a unique user reference. Acceptance links the same profile. Retries and repeated invitations reuse it; ambiguous existing profiles fail visibly rather than assigning an identity to the wrong person.

The command center's People uses the `sys_user` model table. Its Invite dialog accepts either one email/mobile pair or up to 1,000 email addresses or international mobile numbers, one per line. Bulk invitations validate the complete batch before saving. All rows and their automation events commit together. Delivery attempts every invitation; failed delivery IDs are returned for resending without recreating the invitations. Bulk API inputs accept the same source team handle, external flag and party reference as individual invitations.

Merged automation runs may contain several invitation batches. The HR automation reads and writes chunks of 500 to stay within predicate limits.
