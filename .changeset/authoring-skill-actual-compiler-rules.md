---
'@norbital-ai/pod': patch
---

Correct the authoring skill's account of the authored filesystem, and ship the regenerated bundle.

The tree omitted four roles the compiler fully supports and every template already uses —
`src/policies/+*.policy.ts`, `src/channels/+*.channel.ts`, `src/+agent.ts` and `src/+env.ts` — and
stated that "unknown, duplicate, misplaced, or legacy role files are compiler errors", which reads
far broader than what is enforced: every check keys on a leading `+`, and `src/lib/**` is documented
free-form helper code.

That imprecision had a cost. A create surface renamed to a non-`+` file is the rejected call-site
create API wearing a different filename, and nothing fails the build — which is exactly how one
shipped. The rules are now stated as what the compiler actually checks, with that consequence
spelled out.
