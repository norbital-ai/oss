[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/file-value/file-value.types

# ui/build/file-value/file-value.types

## Type Aliases

<a id="filemetadata"></a>

### FileMetadata

```ts
type FileMetadata = typeof FileMetadataSchema.Type;
```

Defined in: packages/ui/build/file-value/file-value.types.d.ts:6

***

<a id="filevalue"></a>

### FileValue

```ts
type FileValue = typeof FileValueSchema.Type;
```

Defined in: packages/ui/build/file-value/file-value.types.d.ts:20

## Variables

<a id="filemetadataschema"></a>

### FileMetadataSchema

```ts
const FileMetadataSchema: Schema.Struct<{
  structure_hint: Schema.String;
  summary: Schema.String;
}>;
```

Defined in: packages/ui/build/file-value/file-value.types.d.ts:2

***

<a id="filevalueschema"></a>

### FileValueSchema

```ts
const FileValueSchema: Schema.Struct<{
  id: Schema.String;
  indexed_error: Schema.optional<Schema.NullOr<Schema.String>>;
  indexed_status: Schema.optional<Schema.Literals<readonly ["pending", "indexing", "ready", "failed", "not_indexable"]>>;
  metadata: Schema.optional<Schema.Struct<{
     structure_hint: Schema.String;
     summary: Schema.String;
  }>>;
  name: Schema.String;
  size: Schema.Number;
  type: Schema.String;
  url: Schema.String;
}>;
```

Defined in: packages/ui/build/file-value/file-value.types.d.ts:7
