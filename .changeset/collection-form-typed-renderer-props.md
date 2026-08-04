---
'@norbital-ai/ui': minor
---

Type `CollectionForm` `Field` so each usage infers `rendererProps` from the chosen `renderer`. Required renderer props (for example `RelationshipRenderer`'s `target`) are enforced, and nested callbacks such as `options.label` infer their record parameter without `satisfies CollectionRelationOptions`. Removes the open index signature on `CollectionFormRendererOptions` that previously collapsed that inference.
