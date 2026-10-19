# Schema and public type inference

Bolt's authored `+<name>.model.ts`, collection, relationship and policy declarations are the authority for its public row, input and projection types. No table schema is authored alongside them. The names Bolt generates from the declarations type rows, inputs, selections and outcomes, including what a table schema cannot express: policy-dependent masking, collection exposure, owned relationship inputs, actor-provided defaults, approval projections and the distinct decimal literal and write values.

Runtime decoders come from the same declarations, once per boundary:

- Field values: `@norbital-ai/std/kind` is the one field-kind table. `inputSchema(spec)` decodes every input and stored value of a kind (callable inputs, writes, read literals, integration configuration, feed rows, AI output kinds). Its encoding is the wire's (`@norbital-ai/std/wire`): a decimal is `{ $dec }`, dates and instants are ISO strings.
- Page cursors: `CursorValue` from the guest-safe `@norbital-ai/bolt/protocol/cursor` entry decodes an issued cursor to the nominal `Cursor` type for shared page-data codecs. The query engine validates its query hash and key count when paging.
- System rows: `src/engine/system/rows.ts` builds each system table's row type and Schema from its model declaration in `src/system`, so neither is a hand copy.
- The manifest: `EngineManifestSchema` (`src/engine/manifest.ts`) decodes `bolt check`'s evaluated manifest and every artifact read. `tests/types/manifest.types.test.ts` proves each part is its declaration's type.
- Wire contracts: every body and frame is a Schema in `src/protocol/schema.ts`, and its type is that Schema's. An integration instance's browser status is the `InstanceStatus` Schema, decoded at the trust boundary by `decodeStatus` (`src/protocol/instance-status.ts`). Credentials and provider state are separate host-only values, never fields added to public row inference.

The semantic corpus in `tests/types/data.ts`, `access.ts`, `runtime.ts` and the compiler-generated name fixtures verifies the type side: defaults and nullability, brands, projected fields, relationships, masking and feed targets' local fields.
