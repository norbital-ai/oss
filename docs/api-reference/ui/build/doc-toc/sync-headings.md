[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/doc-toc/sync-headings

# ui/build/doc-toc/sync-headings

## Variables

<a id="default_doc_toc_headings"></a>

### DEFAULT\_DOC\_TOC\_HEADINGS

```ts
const DEFAULT_DOC_TOC_HEADINGS: "h1[id], h2[id], h3[id]" = "h1[id], h2[id], h3[id]";
```

Defined in: packages/ui/build/doc-toc/sync-headings.d.ts:2

***

<a id="feature_doc_toc_headings"></a>

### FEATURE\_DOC\_TOC\_HEADINGS

```ts
const FEATURE_DOC_TOC_HEADINGS: "h2[id], h3[id]" = "h2[id], h3[id]";
```

Defined in: packages/ui/build/doc-toc/sync-headings.d.ts:3

## Functions

<a id="syncdoctocheadings"></a>

### syncDocTocHeadings()

```ts
function syncDocTocHeadings(article, selector?): object[];
```

Defined in: packages/ui/build/doc-toc/sync-headings.d.ts:4

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `article` | `HTMLElement` \| `null` |
| `selector?` | `string` |

#### Returns

`object`[]
