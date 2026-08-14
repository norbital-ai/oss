# Agents

**What this pillar protects:** the Pod owns the agent loop, tool execution, synced conversation
records, and chat surface; a host may lend one-turn AI and explicitly registered tools without
receiving or storing transcripts.

| File                             | Boundary proved                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-chat-e2e.test.ts`         | `agentChatStart` path: persist the user turn, the host admits the loop function, and the conversation persists.                                                                            |
| `agent-spec.test.ts`             | Interactive fallback and channel runs omit sandbox host tools from `hostTools`; the funnel adds them when a sandbox is bound. Channel `hostTools` remains the opt-in for other host tools. |
| `agent-transcript-e2e.test.ts`   | `agentChatStart` path: agent messages remain tenant-owned and policy-scoped.                                                                                                               |
| `agent-transcript-panel.test.ts` | The Pod-owned panel renders persisted conversation state.                                                                                                                                  |
| `host-agent-tool.test.ts`        | Only declared host tools are exposed to the Pod loop, with validated inputs and outputs.                                                                                                   |

Interactive chat and channel inbound use `agentChatStart` and are covered in
`agent-chat-e2e.test.ts`, `agent-transcript-e2e.test.ts`, `agent-live-capabilities-e2e.test.ts`,
and `../standalone/channel-delivery-e2e.test.ts`. Each loop iteration is one admitted function.

Process-level transport coverage for a self-hosted tool remains in
`../standalone/host-agent-tool-e2e.test.ts`; it proves the host-tool binding boundary rather than agent behavior.
