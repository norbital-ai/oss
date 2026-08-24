[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/layout/scroll-affordance.svelte

# ui/build/layout/scroll-affordance.svelte

## Functions

<a id="scrollaffordance"></a>

### scrollAffordance()

```ts
function scrollAffordance(options?): (node) => () => void;
```

Defined in: packages/ui/build/layout/scroll-affordance.svelte.d.ts:14

Publish scroll position as attributes on a scrollport.

```svelte
<div class="overflow-y-auto" {@attach scrollAffordance()}>…</div>
```

`<Scroll>` applies it already; reach for it directly only on a scrollport that cannot
be one, such as a component's internal rail.

`fade: false` drops the edge attribute for a region whose content must stay opaque to
its own edge. Its scrollbar still follows the global hover-only rule.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `fade?`: `boolean`; \} |
| `options.fade?` | `boolean` |

#### Returns

(`node`) => () => `void`
