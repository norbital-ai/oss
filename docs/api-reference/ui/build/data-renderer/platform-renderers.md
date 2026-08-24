[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/data-renderer/platform-renderers

# ui/build/data-renderer/platform-renderers

## Variables

<a id="platformcustomtyperenderers"></a>

### platformCustomTypeRenderers

```ts
const platformCustomTypeRenderers: Readonly<Record<string, () => Promise<Component<DataRendererProps>>>>;
```

Defined in: packages/ui/build/data-renderer/platform-renderers.d.ts:13

The platform-owned datatypes' renderer loaders, keyed by catalog kind.

This is the counterpart of the `customTypeRendererLoaders` a workspace generates for its own
`src/datatypes/<name>/+renderer.svelte` files — same shape, same consumption point, one
acquisition difference: the platform's loaders are injected (`renderClientRuntime` spreads
them into the same map) rather than discovered. The `@norbital-ai/bolt` compiler builds the
final map keyed by the name every `custom()` column declares. Platform definitions do not get a
second kind alias; `money` and `instant_range` resolve exactly as tenant datatype names do.
