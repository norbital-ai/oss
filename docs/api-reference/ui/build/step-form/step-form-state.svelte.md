[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/step-form/step-form-state.svelte

# ui/build/step-form/step-form-state.svelte

## Classes

<a id="stepformstate"></a>

### StepFormState

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:3

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* [`ConfirmationProps`](/docs/api-reference/ui/build/ai-elements/confirmation.md#confirmationprops) |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new StepFormState<T>(config): StepFormState<T>;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:9

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`StepFormConfig`](/docs/api-reference/ui/build/step-form/types.md#stepformconfig)\<`T`\> |

###### Returns

[`StepFormState`](/docs/api-reference/ui/build/step-form/step-form-state.svelte.md#stepformstate)\<`T`\>

#### Properties

<a id="currentstep"></a>

##### currentStep

```ts
currentStep: number;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:4

<a id="progress"></a>

##### progress

```ts
progress: number;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:8

<a id="steps"></a>

##### steps

```ts
readonly steps: Step<T>[];
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:5

<a id="submission"></a>

##### submission

```ts
readonly submission: StepFormSubmitContract<InferSchema<T>>;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:6

#### Methods

<a id="next"></a>

##### next()

```ts
next(): void;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:11

###### Returns

`void`

<a id="previous"></a>

##### previous()

```ts
previous(): void;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:12

###### Returns

`void`

<a id="validatecurrentstep"></a>

##### validateCurrentStep()

```ts
validateCurrentStep(): boolean;
```

Defined in: packages/ui/build/step-form/step-form-state.svelte.d.ts:10

###### Returns

`boolean`
