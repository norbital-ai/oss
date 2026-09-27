# Rule catalogue

`bolt check` runs four fixed packs; every finding is an error. A reviewed
`repository-health:allow <rule> -- <reason>` on the reported line, or in the comment block directly above it,
suppresses that one rule there; a marker without a reason suppresses nothing.

## `boundaries`

| Rule | Detects |
| ---- | ------- |
| CLONE | JSON stringify/parse clone |
| COERCE1 | Number() decodes IO instead of a schema |
| EFF11 | Effect error channel erased to unknown |
| GUARD1 | hand-rolled object duck guard reconstructs a record |
| GUARD2 | runtime typeof discriminant instead of a schema decode |
| PARSE1 | JSON.parse in a ternary branch skips the decode boundary |
| R1 | any in a signature or annotation |
| R3a | cast to Record<string, unknown> |
| R3b | unapproved double cast |
| R3e | single cast to unknown |
| R3f | explicit cast to any |
| R5d | in-operator duck typing |
| R6a | JSON.parse followed by a cast |
| R6b | JSON.parse without visible validation |
| REFLECT1 | Reflect.get reads a coerced object instead of a decoded boundary |
| SCHEMA1 | Zod bypasses the required Effect Schema boundary |
| STD2 | error message is extracted inline instead of getErrorMessage |
| STD3 | unknown catch value is normalized to Error inline |

## `layout`

| Rule | Detects |
| ---- | ------- |
| UI12 | Tailwind arbitrary value built at runtime emits no CSS |
| UI15 | fixed pane height on a primitive instead of Bound size |
| UI19 | raw positioning class bypasses the Imposter primitive |
| UI21 | viewport or arbitrary height class bypasses Bound |
| UI22 | raw overflow-hidden bypasses Bound clipping |
| UI23 | inline style carries layout that belongs on a primitive |
| UI24 | stylesheet layout declaration bypasses the layout primitives |
| UI25 | class string composed in the script is unreachable as tokens |
| UI27 | layout utility bypasses a primitive prop (gap, align, justify, direction, wrap, tracks, dividers) |
| UI5 | raw overflow scroll region bypasses the Scroll primitive |
| UI6 | raw flex/grid container bypasses the layout primitives (Stack, Inline, Cluster, Switcher, Grid, Columns, Split, Cover, Center) |
| UI7 | sibling margin bypasses the parent gap contract |
| UI8 | literal app inset classes bypass the inset tokens |

## `svelte`

| Rule | Detects |
| ---- | ------- |
| UI17 | template exposes uuid/system id to operators |
| UI26 | browser device API reached directly instead of through client.device |
| V1 | $effect is last-resort external sync; prefer $derived or {@attach} |
| V14 | plain let/var in a rune module should be $state |
| V15 | computed binding in a rune module should be $derived |
| V18 | $derived aliases one identifier without deriving a value |
| V20 | $effect delegates to a named function, so its dependencies are invisible |
| V7 | async $effect |

## `reactive`

| Rule | Detects |
| ---- | ------- |
| REACT1 | a timer drives query refresh; the client already owns the subscription |
| REACT2 | generated query is refreshed imperatively instead of re-deriving |
| REACT3 | hand-rolled memo of completed work duplicates the client cache |
| REACT4 | component branches on the runtime environment instead of a lifecycle boundary |
| REACT5 | an $effect hides its dependency set behind untrack or a dependency-only read |
| LIVE1 | a timer or sleep loop polls a read; `live(…, { every })` is the one sanctioned polling form |
| LIVE2 | a raw server-sent event stream outside the client |
