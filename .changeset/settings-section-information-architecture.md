---
'@norbital-ai/pod': minor
---

Name the Settings section for what an admin does in it, not for who implements it.

Pod's own settings entry was `Tenant workspace` under a database icon, which named the storage the
rows sit in rather than the members, invitations, teams and audit trail an admin opens it to manage.
It is now **People** (`lucide:users`), and the surface's own heading follows.

`resolveBillingSettingsHref` replaces the inline `core-billing` lookup the trial banner used. It
resolves `core-organization` and appends `?tab=billing`, because a host that groups its
organization-scoped settings into one tabbed surface needs the tab named for the deep link to still
land on the payment form; the shell already forwards `location.search` into the host frame.

**Migration for hosts:** a host that registered separate `placement: 'settings'` plugins for
billing, organization profile and messaging credentials should register one `core-organization`
plugin that reads `?tab=` and selects among them. A host that keeps a standalone billing plugin
under any other key loses the banner's "Add payment method" action, which degrades to no action
rather than to a broken link.
