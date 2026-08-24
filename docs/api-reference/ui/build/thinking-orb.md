[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/thinking-orb

# ui/build/thinking-orb

## Type Aliases

<a id="thinkingorbstate"></a>

### ThinkingOrbState

```ts
type ThinkingOrbState = typeof ThinkingOrbStateSchema.Type;
```

Defined in: packages/ui/build/thinking-orb/index.d.ts:13

## Variables

<a id="thinkingorbstateschema"></a>

### ThinkingOrbStateSchema

```ts
const ThinkingOrbStateSchema: Schema.Literals<readonly ["ready", "working", "error"]>;
```

Defined in: packages/ui/build/thinking-orb/index.d.ts:12

What the orb says, in the three states a reader can actually act on: nothing is happening,
something is, or something broke.

The union lives beside the component rather than in the Bolt agent runtime because the orb is
now a shared primitive — the marketing site renders one to stand for AI without importing a
transcript projector. Bolt re-exports it as `AgentOrbState` from `agent-orb-state.ts`, which
keeps the runtime's own vocabulary intact.
