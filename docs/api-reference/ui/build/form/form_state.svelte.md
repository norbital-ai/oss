[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/form\_state.svelte

# ui/build/form/form\_state.svelte

## Classes

<a id="formstate"></a>

### FormState

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:121

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Schema` *extends* [`FormSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#formschema) | - |
| `TReturn` | `unknown` |

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new FormState<Schema, TReturn>(config): FormState<Schema, TReturn>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:207

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`FormStateConfig`](/docs/api-reference/ui/build/form/form_state.svelte.md#formstateconfig)\<`Schema`, `TReturn`\> |

###### Returns

[`FormState`](/docs/api-reference/ui/build/form/form_state.svelte.md#formstate)\<`Schema`, `TReturn`\>

#### Properties

<a id="applydraft"></a>

##### applyDraft

```ts
applyDraft: () => boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:277

Apply draft to working copy if one exists.
Returns true if draft was applied.

###### Returns

`boolean`

<a id="baseline"></a>

##### baseline

```ts
baseline: InferSchema<Schema>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:181

Baseline: The reference point for diff calculation.
Formula: baseline = serverState ?? defaultState
This is what W is compared against to compute Δ.

<a id="cleardraft"></a>

##### clearDraft

```ts
clearDraft: () => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:281

Explicitly clear the draft from storage.

###### Returns

`void`

<a id="clearerrors"></a>

##### clearErrors

```ts
clearErrors: () => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:342

###### Returns

`void`

<a id="clearfielderror"></a>

##### clearFieldError

```ts
clearFieldError: (path) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:343

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |

###### Returns

`void`

<a id="delta"></a>

##### delta

```ts
delta: object[];
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:187

Delta (Δ): RFC 6902 JSON Patch operations from baseline to working copy.
Represents the "distance traveled" from S (or D) to W.
Uses identity-aware comparison for arrays with 'id' or 'id' keys.

###### op

```ts
readonly op: "replace" | "add" | "remove";
```

###### path

```ts
readonly path: string;
```

###### value?

```ts
readonly optional value?: unknown;
```

<a id="destroy"></a>

##### destroy

```ts
destroy: () => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:286

Cleanup draft storage listeners and pending tasks.
Call this when the form component is destroyed.

###### Returns

`void`

<a id="disabled"></a>

##### disabled

```ts
disabled: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:148

Whether the form is disabled (reactive)

<a id="errormessage"></a>

##### errorMessage

```ts
errorMessage: string | null;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:157

Error message from last failed submission

<a id="errors"></a>

##### errors

```ts
errors: object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:161

Validation errors

###### fieldErrors

```ts
fieldErrors: Record<string, string[]>;
```

###### formErrors

```ts
formErrors: string[];
```

<a id="getarrayitemtemplate"></a>

##### getArrayItemTemplate

```ts
getArrayItemTemplate: (arrayPath) => unknown;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:312

Get the item template for an array path (for ListBlock new items).
Returns the first item from defaultState array, or empty object.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `arrayPath` | `string` | Dot-notation path to the array |

###### Returns

`unknown`

<a id="getdata"></a>

##### getData

```ts
getData: () => InferSchema<Schema>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:245

Get the current working copy.

###### Returns

[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>

<a id="getdefaultstate"></a>

##### getDefaultState

```ts
getDefaultState: () => InferSchema<Schema>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:305

Get the current default state (D).

###### Returns

[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>

<a id="getdeltaforpath"></a>

##### getDeltaForPath

```ts
getDeltaForPath: (path) => object[];
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:333

Get delta operations for a specific field path.
Useful for highlighting changed fields in the UI.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |

###### Returns

`object`[]

<a id="getfielderrors"></a>

##### getFieldErrors

```ts
getFieldErrors: (path) => string[];
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:345

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |

###### Returns

`string`[]

<a id="getserverstate"></a>

##### getServerState

```ts
getServerState: () =>
  | InferSchema<Schema>
  | null;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:291

Get the current server state (S).
Derived from the getter - parent controls this value.

###### Returns

  \| [`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>
  \| `null`

<a id="getvalue"></a>

##### getValue

```ts
getValue: <K>(path) => Get<InferSchema<Schema>, K>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:249

Get a field value from working copy by dot-notation path.

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* `string` |

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `K` |

###### Returns

[`Get`](/docs/api-reference/ui/build/form/path.md#get)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>, `K`\>

<a id="handlesubmit"></a>

##### handleSubmit

```ts
handleSubmit: (event) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:363

Handle form submit event.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `Event` |

###### Returns

`void`

<a id="haschangesforpath"></a>

##### hasChangesForPath

```ts
hasChangesForPath: (path) => boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:341

Check if a specific field path has changes in delta.
Useful for conditionally styling dirty fields.

NOTE: Since Δ is computed on normalized data (where arrays with IDs are objects),
we need to handle both positional and identity-based paths.

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |

###### Returns

`boolean`

<a id="hasdraft"></a>

##### hasDraft

```ts
hasDraft: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:201

hasDraft: Whether a persisted draft exists in localStorage.
Only relevant when draftKey is configured.

<a id="hasserverstate"></a>

##### hasServerState

```ts
hasServerState: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:206

hasServerState: Whether we have authoritative server data.
false when creating new entity, true when editing existing.

<a id="hasvalidationerrors"></a>

##### hasValidationErrors

```ts
hasValidationErrors: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:166

Whether client-side validation failed on the last submit attempt

<a id="isdirty"></a>

##### isDirty

```ts
isDirty: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:196

isDirty: Whether the working copy differs from baseline.
True when Δ contains any operations.

<a id="issubmitting"></a>

##### isSubmitting

```ts
isSubmitting: boolean;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:153

Whether a submission is in progress

<a id="lastresult"></a>

##### lastResult

```ts
lastResult: TReturn | undefined;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:155

Result from last successful submission

<a id="loaddraft"></a>

##### loadDraft

```ts
loadDraft: () =>
  | InferSchema<Schema>
  | null;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:272

Load draft data without applying it.
Returns the raw draft for custom merging, or null if no draft.

###### Returns

  \| [`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>
  \| `null`

<a id="pusharrayitem"></a>

##### pushArrayItem

```ts
pushArrayItem: (arrayPath, item?) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:320

Push a new item to an array in workingCopy, using defaultState template.
Triggers onDataChange hook for derived value recalculation.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `arrayPath` | `string` | Dot-notation path to the array |
| `item?` | `unknown` | Optional custom item (defaults to array item template from defaultState) |

###### Returns

`void`

<a id="removearrayitem"></a>

##### removeArrayItem

```ts
removeArrayItem: (arrayPath, index) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:328

Remove an item from an array in workingCopy by index.
Triggers onDataChange hook for derived value recalculation.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `arrayPath` | `string` | Dot-notation path to the array |
| `index` | `number` | Index of item to remove |

###### Returns

`void`

<a id="removehook"></a>

##### removeHook

```ts
removeHook: <K>(hookName) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:223

Remove a hook callback.

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* keyof [`FormStateHooks`](/docs/api-reference/ui/build/form/form_state.svelte.md#formstatehooks)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\> |

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `hookName` | `K` |

###### Returns

`void`

<a id="reset"></a>

##### reset

```ts
reset: () => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:267

Reset working copy to baseline (S or D) and clear draft.
After reset: W = baseline, Δ becomes empty.

###### Returns

`void`

<a id="setdata"></a>

##### setData

```ts
setData: (data, options?) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:234

Update working copy with deep merge support.
Pass `replace: true` to replace entirely instead of merging.
Automatically persists to draft storage and triggers auto-submit.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | `Partial`\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\> | Partial data to merge, or full data if replacing |
| `options?` | \{ `force?`: `boolean`; `replace?`: `boolean`; `triggerHooks?`: `boolean`; \} | - |
| `options.force?` | `boolean` | Bypass disabled check for programmatic updates (e.g., streaming) |
| `options.replace?` | `boolean` | Whether to replace instead of merge |
| `options.triggerHooks?` | `boolean` | Whether to trigger onDataChange hook (default: true) |

###### Returns

`void`

<a id="setdefaultstate"></a>

##### setDefaultState

```ts
setDefaultState: <K>(path, value) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:300

Update default state at a specific path.
Auto-merges to workingCopy if the path has no value (null/undefined).
Used by authored form runtimes to register per-field defaults (defaultValue callbacks).

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* `string` |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `path` | `K` | Dot-notation path to set |
| `value` | [`Get`](/docs/api-reference/ui/build/form/path.md#get)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>, `K`\> | Default value for that path |

###### Returns

`void`

<a id="setdefaultvalueatpath"></a>

##### setDefaultValueAtPath

```ts
setDefaultValueAtPath: (path, value) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:301

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `value` | `unknown` |

###### Returns

`void`

<a id="setfielderror"></a>

##### setFieldError

```ts
setFieldError: (path, messages) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:344

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `string` |
| `messages` | `string` \| `string`[] |

###### Returns

`void`

<a id="sethook"></a>

##### setHook

```ts
setHook: <K>(hookName, callback) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:219

Register a hook callback for lifecycle events.

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* keyof [`FormStateHooks`](/docs/api-reference/ui/build/form/form_state.svelte.md#formstatehooks)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\> |

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `hookName` | `K` |
| `callback` | [`FormStateHooks`](/docs/api-reference/ui/build/form/form_state.svelte.md#formstatehooks)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\>\[`K`\] |

###### Returns

`void`

<a id="setvalue"></a>

##### setValue

```ts
setValue: <K>(path, value, options?) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:255

Set a field value in working copy by dot-notation path.
Automatically persists to draft storage and triggers auto-submit.
Pass triggerHooks: false to skip onDataChange (e.g. when writing derived values).

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* `string` |

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `K` |
| `value` | [`Get`](/docs/api-reference/ui/build/form/path.md#get)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>, `K`\> |
| `options?` | \{ `force?`: `boolean`; `triggerHooks?`: `boolean`; \} |
| `options.force?` | `boolean` |
| `options.triggerHooks?` | `boolean` |

###### Returns

`void`

<a id="setvalueatpath"></a>

##### setValueAtPath

```ts
setValueAtPath: <K>(path, value, options?) => void;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:259

###### Type Parameters

| Type Parameter |
| ------ |
| `K` *extends* `string` |

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `path` | `K` |
| `value` | [`Get`](/docs/api-reference/ui/build/form/path.md#get)\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>, `K`\> |
| `options?` | \{ `force?`: `boolean`; `triggerHooks?`: `boolean`; \} |
| `options.force?` | `boolean` |
| `options.triggerHooks?` | `boolean` |

###### Returns

`void`

<a id="submit"></a>

##### submit

```ts
submit: (options?) => Effect<TReturn | null, unknown>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:357

Submit the form.
Validates W, calls remoteFn if provided, and handles success/error states.

On success:
- S ← W (working copy becomes new server state)
- Clear draft storage
- Δ becomes empty (since S now equals W)

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | \{ `silent?`: `boolean`; \} | { silent?: boolean } - If true, don't show success toast |
| `options.silent?` | `boolean` | - |

###### Returns

`Effect`\<`TReturn` \| `null`, `unknown`\>

<a id="submitsuccessmessage"></a>

##### submitSuccessMessage

```ts
submitSuccessMessage: string | null;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:159

Success message text while the last submission is in the success state (before commit/reset).

<a id="validationerrormessage"></a>

##### validationErrorMessage

```ts
validationErrorMessage: string | null;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:168

First validation error message, when [hasValidationErrors](/docs/api-reference/ui/build/form/form_state.svelte.md#hasvalidationerrors) is true

## Type Aliases

<a id="autosubmitconfig"></a>

### AutoSubmitConfig

```ts
type AutoSubmitConfig = object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:42

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-debouncems"></a> `debounceMs?` | `number` | Debounce delay in milliseconds (default: 500) | packages/ui/build/form/form\_state.svelte.d.ts:46 |
| <a id="property-enabled"></a> `enabled` | `boolean` | Enable auto-submit on data change | packages/ui/build/form/form\_state.svelte.d.ts:44 |
| <a id="property-silent"></a> `silent?` | `boolean` | If true, don't show success toast on auto-submit | packages/ui/build/form/form\_state.svelte.d.ts:48 |

***

<a id="formschema"></a>

### FormSchema

```ts
type FormSchema = object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:27

Structural constraint satisfied by any Standard Schema v1 schema, read through `~standard`.

#### Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-standard"></a> `~standard` | `readonly` | `object` | packages/ui/build/form/form\_state.svelte.d.ts:28 |
| `~standard.validate` | `readonly` | (`data`) => `unknown` | packages/ui/build/form/form\_state.svelte.d.ts:29 |

***

<a id="formstateconfig"></a>

### FormStateConfig

```ts
type FormStateConfig<Schema, TReturn> = object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:53

#### Type Parameters

| Type Parameter |
| ------ |
| `Schema` *extends* [`FormSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#formschema) |
| `TReturn` |

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-autosubmit"></a> `autoSubmit?` | `MaybeGetter`\< \| [`AutoSubmitConfig`](/docs/api-reference/ui/build/form/form_state.svelte.md#autosubmitconfig) \| `undefined`\> | Auto-submit configuration. When enabled, form auto-submits on data change. Can be a getter for reactivity. | packages/ui/build/form/form\_state.svelte.d.ts:106 |
| <a id="property-defaultstate"></a> `defaultState?` | `MaybeGetter`\<[`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\> | Default State (D): Static fallback structure. | packages/ui/build/form/form\_state.svelte.d.ts:59 |
| <a id="property-description"></a> `description?` | `MaybeGetter`\<`string`\> | Optional description for debugging | packages/ui/build/form/form\_state.svelte.d.ts:87 |
| <a id="property-disabled"></a> `disabled?` | `MaybeGetter`\<`boolean`\> | Whether the form is disabled. Can be a getter for reactivity. | packages/ui/build/form/form\_state.svelte.d.ts:91 |
| <a id="property-draftkey"></a> `draftKey?` | `MaybeGetter`\<`string`[]\> | Key parts for draft persistence. If provided, enables automatic draft save/load. The draft storage IS the Working Copy (W) - persisted to localStorage. On hydration: W = draft ?? serverState ?? defaultState Can be a getter for reactivity. **Examples** `draftKey: ['create_form', collectionId]` `draftKey: () => ['unified_form', entityId]` | packages/ui/build/form/form\_state.svelte.d.ts:101 |
| <a id="property-onsuccess"></a> `onSuccess?` | (`result`) => `Effect.Effect`\<`void`, `unknown`\> \| `void` | Called after successful submission | packages/ui/build/form/form\_state.svelte.d.ts:69 |
| <a id="property-remotefn"></a> `remoteFn?` | `RemoteFnGetter`\<`Schema`, `TReturn`\> | Remote function to call on submit. | packages/ui/build/form/form\_state.svelte.d.ts:67 |
| <a id="property-schema"></a> `schema` | `MaybeGetter`\<`Schema`\> | Schema for validation | packages/ui/build/form/form\_state.svelte.d.ts:55 |
| <a id="property-serverstate"></a> `serverState?` | `MaybeGetter`\< \| [`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\> \| `null`\> | Server State (S): Authoritative data from database. | packages/ui/build/form/form\_state.svelte.d.ts:63 |
| <a id="property-submitsuccessbehavior"></a> `submitSuccessBehavior?` | `MaybeGetter`\<[`SubmitSuccessBehavior`](/docs/api-reference/ui/build/form/form_state.svelte.md#submitsuccessbehavior)\> | Post-submit behavior after a successful submission. - none: keep current working copy as-is - commit: treat submitted payload as new baseline and clear dirty state - reset: reset to baseline and clear draft/errors | packages/ui/build/form/form\_state.svelte.d.ts:76 |
| <a id="property-successmessage"></a> `successMessage?` | `MaybeGetter`\<`string` \| `null`\> | Toast message on success. Set to null to disable. | packages/ui/build/form/form\_state.svelte.d.ts:80 |
| <a id="property-transform"></a> `transform?` | `MaybeGetter`\<(`data`) => [`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\>\> | Transform data before validation/submission | packages/ui/build/form/form\_state.svelte.d.ts:78 |
| <a id="property-translate"></a> `translate?` | [`TranslateFn`](/docs/api-reference/ui/build/form/form_state.svelte.md#translatefn) | Catalog-backed translate handle for built-in copy (success toast, validation summary, generic failure). When omitted, English fallbacks are used. | packages/ui/build/form/form\_state.svelte.d.ts:85 |

***

<a id="formstatehooks"></a>

### FormStateHooks

```ts
type FormStateHooks<T> = object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:111

Hook callbacks for FormState lifecycle events

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="property-onaftersubmit"></a> `onAfterSubmit?` | (`data`, `result`) => `void` | Called after successful submission | packages/ui/build/form/form\_state.svelte.d.ts:117 |
| <a id="property-onbeforesubmit"></a> `onBeforeSubmit?` | (`data`) => `void` | Called before form submission | packages/ui/build/form/form\_state.svelte.d.ts:115 |
| <a id="property-ondatachange"></a> `onDataChange?` | (`workingCopy`) => `void` | Called after working copy changes (via setData or setValue) | packages/ui/build/form/form\_state.svelte.d.ts:113 |

***

<a id="formsubmitfn"></a>

### FormSubmitFn

```ts
type FormSubmitFn<Schema, TReturn> = (data) => Effect.Effect<TReturn, unknown>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:40

Plain submit handler (sync or async). Framework-specific remote callables that
share this shape remain compatible at runtime.

#### Type Parameters

| Type Parameter |
| ------ |
| `Schema` *extends* [`FormSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#formschema) |
| `TReturn` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | [`InferSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#inferschema)\<`Schema`\> |

#### Returns

`Effect.Effect`\<`TReturn`, `unknown`\>

***

<a id="inferschema"></a>

### InferSchema

```ts
type InferSchema<S> = S extends object ? T : object;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:33

Extract the output type from a Standard Schema v1-compatible schema.

#### Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* [`FormSchema`](/docs/api-reference/ui/build/form/form_state.svelte.md#formschema) |

***

<a id="submitsuccessbehavior"></a>

### SubmitSuccessBehavior

```ts
type SubmitSuccessBehavior = "none" | "commit" | "reset";
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:50

***

<a id="translatefn"></a>

### TranslateFn

```ts
type TranslateFn = (key, vars?) => string;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:23

Catalog-backed translation handle, threaded in so this state class never renders hardcoded copy.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `vars?` | [`MessageVars`](/docs/api-reference/std/build/i18n/catalog.md#messagevars) |

#### Returns

`string`

## Functions

<a id="maybeasync"></a>

### maybeAsync()

```ts
function maybeAsync<A>(evaluate): Effect<Awaited<A>, UnknownError>;
```

Defined in: packages/ui/build/form/form\_state.svelte.d.ts:120

Run a possibly-synchronous callback and await its result through Effect.

#### Type Parameters

| Type Parameter |
| ------ |
| `A` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `evaluate` | () => `A` |

#### Returns

`Effect`\<`Awaited`\<`A`\>, `UnknownError`\>
