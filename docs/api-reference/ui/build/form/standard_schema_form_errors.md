[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/standard\_schema\_form\_errors

# ui/build/form/standard\_schema\_form\_errors

## Type Aliases

<a id="standardschemaissue"></a>

### StandardSchemaIssue

```ts
type StandardSchemaIssue = Extract<Awaited<ReturnType<ReturnType<typeof Schema.toStandardSchemaV1>["~standard"]["validate"]>>, {
  issues: readonly unknown[];
}>["issues"][number];
```

Defined in: packages/ui/build/form/standard\_schema\_form\_errors.d.ts:9

One issue in a standard-schema validation failure, derived from effect's own adapter.

`Schema.toStandardSchemaV1` is effect's implementation of the standard schema interface, so its
failure result is the authoritative shape of an issue here — derived through `ReturnType` rather
than restated from the spec, which keeps the two in step by construction.

***

<a id="standardschemaof"></a>

### StandardSchemaOf

```ts
type StandardSchemaOf<S> = ReturnType<typeof Schema.toStandardSchemaV1>;
```

Defined in: packages/ui/build/form/standard\_schema\_form\_errors.d.ts:13

Any schema the realm's forms accept: an Effect schema, standard-adapted or raw.

#### Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `Schema.Codec`\<`unknown`, `unknown`\> |

## Functions

<a id="fieldandformerrorsfromstandardissues"></a>

### fieldAndFormErrorsFromStandardIssues()

```ts
function fieldAndFormErrorsFromStandardIssues(issues): FieldAndFormErrors;
```

Defined in: packages/ui/build/form/standard\_schema\_form\_errors.d.ts:19

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `issues` | readonly `Issue`[] |

#### Returns

`FieldAndFormErrors`
