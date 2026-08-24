[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/multi-step-combobox/types

# ui/build/multi-step-combobox/types

## Type Aliases

<a id="anystepoption"></a>

### AnyStepOption

```ts
type AnyStepOption<TValueMap> = TOption<TValueMap[keyof TValueMap], {
  compact: boolean;
}>;
```

Defined in: packages/ui/build/multi-step-combobox/types.d.ts:7

#### Type Parameters

| Type Parameter |
| ------ |
| `TValueMap` *extends* `Record`\<`string`, `unknown`\> |

***

<a id="selectiondraft"></a>

### SelectionDraft

```ts
type SelectionDraft<TValueMap> = Partial<TValueMap>;
```

Defined in: packages/ui/build/multi-step-combobox/types.d.ts:37

#### Type Parameters

| Type Parameter |
| ------ |
| `TValueMap` *extends* `Record`\<`string`, `unknown`\> |

***

<a id="stepsconfig"></a>

### StepsConfig

```ts
type StepsConfig<TValueMap> = { [K in keyof TValueMap]: StepDef<TValueMap, K> };
```

Defined in: packages/ui/build/multi-step-combobox/types.d.ts:34

#### Type Parameters

| Type Parameter |
| ------ |
| `TValueMap` *extends* `Record`\<`string`, `unknown`\> |
