---
'@norbital-ai/pod': minor
---

Let a self-hosted pod's owner keep their own skills, by reading the filesystem the run is already on.

A workspace skill is committed under `src/skills/` and belongs to everyone in the tenant, which is
right for the things a tenant agrees on and wrong for everything else. Somebody who works out the
exact phrasing that gets a report out the way they want it has nowhere to put that: committing it
imposes their preference on colleagues who did not ask for it, and not committing it means retyping
it into every conversation. The gap was never a missing feature so much as a missing place.

Under `pod dev` and `pod start` the place already existed. One process runs on one working directory
for one principal, so the filesystem a run is executing on is already that person's own box, and
`.agents/skills/<name>/SKILL.md` is already the convention this repository uses for skills an agent
should find locally. A personal skill is therefore simply a skill present in that directory,
discovered by reading it at run time, committed nowhere and shared with nobody.

Read the scope carefully, because it is narrower than "personal skills work". This is a self-hosted
feature. Under a host that runs one tenant runtime per organization — Core does — there is no
per-person filesystem for discovery to find. `personalSkills()` reads `.agents/skills/` beneath
`NORBITAL_POD_SANDBOX_DIR` or the working directory, and Core sets neither to anything writable: its
guest starts on `/app`, an immutable checkpoint bundle mounted read-only, so discovery correctly
finds nothing and every run gets exactly the host and workspace skills it got before. Pointing that
variable somewhere writable would not fix it either, which is the part worth understanding. One
process environment variable cannot name a different directory per person, and the process is shared
by the whole organization, so the result would be organization-wide skills wearing the word
"personal". Nor is there a writer: `sandbox_write_file` edits the build sandbox, which is a different
guest from the one that would read this. What is missing is not a path but an acting principal on the
binding frame that reaches the host, and that gap is written up in `docs/AGENT_ARCHITECTURE.md`.

The design rationale holds regardless of which of those a deployment is. There is no user id anywhere
in the discovery path, and there should not be: it asks the filesystem what is on it. A self-hosted
run has one principal, so the files are theirs by construction. A channel agent has no single person
behind it at all — a Telegram or WhatsApp group is permissioned by profile precisely because asking
which participant owns the channel's skills is a question with no answer. Filtering by acting user
would be redundant in the first case and incoherent in the second.

Two kinds of skill, then, rather than three sources: system injected, which is what Pod compiles into
its own package and merges into every run; and file-based discovered, which is workspace and personal
differing only in which filesystem holds them and whether it is committed. All three read as one flat
namespace, resolved host, then workspace, then personal. Host still wins outright — a personal skill
shadowing `norbital-platform` would replace the only correct account of how approvals behave exactly
as a workspace one would — and workspace beats personal because a shared answer should not be
quietly substituted for one filesystem's runs. The losing copy is dropped rather than merged.

Discovery reuses the frontmatter parser and the name rule the other two kinds are already held to, so
a skill someone wrote for a workspace is a skill they can drop into a directory unchanged. Failure is
soft in a way the compiled path does not need to be: there is no build to report a diagnostic to and
nobody watching one, so a malformed document, an unreadable file or a directory that is not a skill
at all costs that one skill and warns, rather than taking `list_skills` down for the run and losing
the platform skills over a typo in a personal one. Nothing is cached, so a file written mid-session
is usable in the next turn; the read is one directory of small markdown files, behind a model
inference that costs orders of magnitude more.
