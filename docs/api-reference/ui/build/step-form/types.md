[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/step-form/types

# ui/build/step-form/types

## Type Aliases

<a id="step"></a>

### Step

```ts
type Step<TFinal> = object;
```

Defined in: packages/ui/build/step-form/types.d.ts:4

#### Type Parameters

| Type Parameter |
| ------ |
| `TFinal` *extends* [`ConfirmationProps`](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops) |

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-description"></a> `description` | `string` | packages/ui/build/step-form/types.d.ts:6 |
| <a id="property-schema"></a> `schema` | [`ConfirmationProps`](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops) | packages/ui/build/step-form/types.d.ts:7 |
| <a id="property-title"></a> `title` | `string` \| `Snippet` | packages/ui/build/step-form/types.d.ts:5 |

***

<a id="stepformconfig"></a>

### StepFormConfig

```ts
type StepFormConfig<T> = object;
```

Defined in: packages/ui/build/step-form/types.d.ts:21

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ConfirmationProps`](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops) |

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-onstepvalidationfailed"></a> `onStepValidationFailed?` | () => `void` | packages/ui/build/step-form/types.d.ts:24 |
| <a id="property-steps"></a> `steps` | [`Step`](/docs/api-reference/ui/build/step-form/types.md#step)\<`T`\>[] | packages/ui/build/step-form/types.d.ts:22 |
| <a id="property-submission"></a> `submission` | [`StepFormSubmitContract`](/docs/api-reference/ui/build/step-form/types.md#stepformsubmitcontract)\<[`ConfirmationProps`](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops)\<`T`\>\> | packages/ui/build/step-form/types.d.ts:23 |

***

<a id="stepformsubmitcontract"></a>

### StepFormSubmitContract

```ts
type StepFormSubmitContract<TData> = object;
```

Defined in: packages/ui/build/step-form/types.d.ts:13

#### Type Parameters

| Type Parameter |
| ------ |
| `TData` |

#### Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-clearerrors"></a> `clearErrors` | `public` | () => `void` | packages/ui/build/step-form/types.d.ts:18 |
| <a id="property-errors"></a> `errors` | `readonly` | [`StepFormSubmitErrors`](/docs/api-reference/ui/build/step-form/types.md#stepformsubmiterrors) | packages/ui/build/step-form/types.d.ts:16 |
| <a id="property-getdata"></a> `getData` | `public` | () => `TData` | packages/ui/build/step-form/types.d.ts:17 |
| <a id="property-handlesubmit"></a> `handleSubmit` | `public` | (`event`) => `void` \| `Effect.Effect`\<`void`, `unknown`\> | packages/ui/build/step-form/types.d.ts:14 |
| <a id="property-issubmitting"></a> `isSubmitting` | `readonly` | `boolean` | packages/ui/build/step-form/types.d.ts:15 |
| <a id="property-seterrors"></a> `setErrors` | `public` | (`errors`) => `void` | packages/ui/build/step-form/types.d.ts:19 |

***

<a id="stepformsubmiterrors"></a>

### StepFormSubmitErrors

```ts
type StepFormSubmitErrors = object;
```

Defined in: packages/ui/build/step-form/types.d.ts:9

#### Properties

| Property | Type | Defined in |
| ------ | ------ | ------ |
| <a id="property-fielderrors"></a> `fieldErrors` | `Record`\<`string`, `string`[]\> | packages/ui/build/step-form/types.d.ts:10 |
| <a id="property-formerrors"></a> `formErrors` | `string`[] | packages/ui/build/step-form/types.d.ts:11 |
