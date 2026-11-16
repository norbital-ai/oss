---
name: capabilities
agent: true
authoring: true
description: What a workspace can do on its own, to compose a solution to a person's problem.
---

1. Start from the problem: what the person does by hand, how often, from what input. Then compose the mechanisms below. Configuring an existing mechanism beats writing new code.
2. Models: transforms validate and derive on every write; effects react after commit; constraints and locks guard state.
3. Automations: jobs run queued, on a cron or from an effect; calls answer at once and serve pages and agents as tools. Each runs with its own policies.
4. Inference: ctx.ai infers structured output against a JSON schema with CEL rules, to parse documents, classify, extract or draft. Use validated configuration for supported variation; keep invariant rules and execution logic in source. New behavior outside that language needs a tested source change.
5. Messaging: envoys converse on a paired account; ctx.send sends through it; a scheduled message is a cron automation; replies continue in the same conversation.
6. Syncs and integrations: syncs exchange rows with remote systems and with files (import, export, templates); connections are runtime records the person creates and pairs.
7. Policies and approvals: grants decide who may do what; a verdict can route a write for approval.
8. Agent work: scripts compute over reads and files; the browser works the web; an automation marked for agents becomes your own tool; a workspace skill records a repeated procedure and the brief records standing rules.
9. Onboarding and configuration: set up envoys, connections and runtime catalogues through native records and the integration page. Never collect a credential in chat.
10. When a step repeats, build a tool for it; when a procedure repeats, write a skill. Prefer the least complex composition.
