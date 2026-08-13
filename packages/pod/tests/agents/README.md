# Agents

**What this pillar protects:** the Pod owns the agent loop, tool execution, synced conversation
records, and chat surface; a host may lend one-turn AI and explicitly registered tools without
receiving or storing transcripts.

| File                             | Boundary proved                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `agent-chat-e2e.test.ts`         | Leftover in-guest `runAgent` path: a user message runs through Pod's agent loop and persists the conversation. |
| `agent-spec.test.ts`             | An interactive fallback names every host tool; a channel run names none, keeping every workspace tool. |
| `agent-transcript-e2e.test.ts`   | Leftover in-guest path: agent and automation messages remain tenant-owned and policy-scoped.           |
| `agent-transcript-panel.test.ts` | The Pod-owned panel renders persisted conversation state.                                              |
| `host-agent-tool.test.ts`        | Only declared host tools are exposed to the Pod loop, with validated inputs and outputs.               |

Durable interactive chat and channel inbound use `agentChatStart` / `admitAgentTurn` and are covered
in `../standalone/channel-delivery-e2e.test.ts` and `agent-live-capabilities-e2e.test.ts`. The
`agent-chat-e2e` and `agent-transcript-e2e` suites exercise the leftover synchronous remotes, not
`pod start` UI or channel delivery.

Process-level transport coverage for a self-hosted tool remains in
`../standalone/host-agent-tool-e2e.test.ts`; it proves the host-tool binding boundary rather than agent behavior.
