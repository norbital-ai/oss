[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/submission\_handled\_externally\_error

# ui/build/form/submission\_handled\_externally\_error

## Classes

<a id="submissionhandledexternallyerror"></a>

### SubmissionHandledExternallyError

Defined in: packages/ui/build/form/submission\_handled\_externally\_error.d.ts:5

Thrown when submit failure was handled outside FormState (e.g. approval dialog).
FormState suppresses the default error toast and returns to idle without rethrowing.

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new SubmissionHandledExternallyError(message?): SubmissionHandledExternallyError;
```

Defined in: packages/ui/build/form/submission\_handled\_externally\_error.d.ts:7

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `message?` | `string` |

###### Returns

[`SubmissionHandledExternallyError`](/docs/api-reference/ui/build/form/submission_handled_externally_error.md#submissionhandledexternallyerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

<a id="name"></a>

##### name

```ts
readonly name: "SubmissionHandledExternallyError" = "SubmissionHandledExternallyError";
```

Defined in: packages/ui/build/form/submission\_handled\_externally\_error.d.ts:6

###### Overrides

```ts
Error.name
```
