[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/secret

# std/build/secret

## Classes

<a id="secretkeyunavailable"></a>

### SecretKeyUnavailable

Defined in: packages/std/build/secret/index.d.ts:95

The refusal that keeps a secret from being stored in the clear.

Raised by `encrypt` when there is no usable key, and by `decrypt` when a stored value cannot even
be attempted. It is not retryable: nothing about the request will make the host's configuration
appear, and a caller retrying only delays the operator finding out.

The tags below still read `Bolt.Secrets.*` after the move into `std`. A tagged error's tag is its
observable identity — asserted in tests, matched by operators reading a failure — and renaming it
would be a behaviour change dressed up as a file move. A caller in another application that wants
its own vocabulary maps this into its own failure at its boundary rather than renaming it here.

#### Extends

- `SecretKeyUnavailable_base`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new SecretKeyUnavailable(...args): SecretKeyUnavailable;
```

Defined in: node\_modules/.pnpm/effect@4.0.0-rc.111/node\_modules/effect/dist/Schema.d.ts:9246

###### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`args` | \[`object`, `MakeOptions`\] |

###### Returns

[`SecretKeyUnavailable`](/docs/api-reference/std/build/secret.md#secretkeyunavailable)

###### Inherited from

```ts
SecretKeyUnavailable_base.constructor
```

#### Properties

<a id="message"></a>

##### message

```ts
readonly message: string;
```

Defined in: packages/std/build/secret/index.d.ts:96

###### Overrides

```ts
SecretKeyUnavailable_base.message
```

<a id="operation"></a>

##### operation

```ts
readonly operation: string;
```

Defined in: packages/std/build/secret/index.d.ts:80

###### Inherited from

```ts
SecretKeyUnavailable_base.operation
```

<a id="outcome"></a>

##### outcome

```ts
readonly outcome: "known";
```

Defined in: packages/std/build/secret/index.d.ts:98

<a id="reason"></a>

##### reason

```ts
readonly reason: string;
```

Defined in: packages/std/build/secret/index.d.ts:81

###### Inherited from

```ts
SecretKeyUnavailable_base.reason
```

<a id="retryable"></a>

##### retryable

```ts
readonly retryable: false = false;
```

Defined in: packages/std/build/secret/index.d.ts:97

***

<a id="secretunreadable"></a>

### SecretUnreadable

Defined in: packages/std/build/secret/index.d.ts:110

A stored value that did not come back out.

Deliberately distinct from "there is no value": a caller that hears `null` will offer to set the
credential up, which is right for an empty row and wrong for one that is present and unreadable.

#### Extends

- `SecretUnreadable_base`

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new SecretUnreadable(...args): SecretUnreadable;
```

Defined in: node\_modules/.pnpm/effect@4.0.0-rc.111/node\_modules/effect/dist/Schema.d.ts:9246

###### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`args` | \[`object`, `MakeOptions`\] |

###### Returns

[`SecretUnreadable`](/docs/api-reference/std/build/secret.md#secretunreadable)

###### Inherited from

```ts
SecretUnreadable_base.constructor
```

#### Properties

<a id="message-1"></a>

##### message

```ts
readonly message: string;
```

Defined in: packages/std/build/secret/index.d.ts:111

###### Overrides

```ts
SecretUnreadable_base.message
```

<a id="name"></a>

##### name

```ts
readonly name: string;
```

Defined in: packages/std/build/secret/index.d.ts:101

###### Inherited from

```ts
SecretUnreadable_base.name
```

<a id="outcome-1"></a>

##### outcome

```ts
readonly outcome: "known";
```

Defined in: packages/std/build/secret/index.d.ts:113

<a id="reason-1"></a>

##### reason

```ts
readonly reason: string;
```

Defined in: packages/std/build/secret/index.d.ts:102

###### Inherited from

```ts
SecretUnreadable_base.reason
```

<a id="retryable-1"></a>

##### retryable

```ts
readonly retryable: false = false;
```

Defined in: packages/std/build/secret/index.d.ts:112

## Type Aliases

<a id="interface"></a>

### Interface

```ts
type Interface = Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>;
```

Defined in: packages/std/build/secret/index.d.ts:115

***

<a id="keysource"></a>

### KeySource

```ts
type KeySource = Readonly<{
  read: (key) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, string>;
}>;
```

Defined in: packages/std/build/secret/index.d.ts:158

How this cipher obtains its key, as a seam rather than an assumption.

`ConfigProvider` is one answer and it is the wrong one in the place that matters most. A tenant
runtime executes inside a `vm` context with no `process` global, deliberately — so a bundle that
reads configuration through the ambient provider inside an isolate reads nothing, silently, and
every `encrypt` refuses with "the key is not set" on a host where the key is very much set. That
is the same fault that made the gateway secret unreachable and every `schema.migrate` answer
"Missing command credential" while the bootstrap reported six of six up.

A host behind an isolate boundary answers through its config facility instead, which is a round
trip it can actually serve. Both routes produce the same `Option`, and the failure channel carries
the reason a route could not answer, so "the host has no key" and "the host could not be asked"
stay distinguishable — they mean different things to an operator, and both are fatal to a write.

## Variables

<a id="bind"></a>

### bind

```ts
const bind: (...parts) => string;
```

Defined in: packages/std/build/secret/index.d.ts:142

The identity a row's ciphertext is bound to, length-prefixed so no combination of parts collides.

`'ab' + 'c'` and `'a' + 'bc'` join to the same string; `2:ab1:c` and `1:a2:bc` do not. Secret and
session names are free-form, so this is reachable input rather than a theoretical concern.

Exported because the bindings themselves are not: which parts identify a row is a fact about the
store that owns it, so each store states its own beside its own schema rather than having this
module accumulate a list of every table in the system.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`parts` | `ReadonlyArray`\<`string`\> |

#### Returns

`string`

***

<a id="configproviderkeysource"></a>

### configProviderKeySource

```ts
const configProviderKeySource: KeySource;
```

Defined in: packages/std/build/secret/index.d.ts:162

The key source a bundle running in a plain process has: Effect's own configuration provider.

***

<a id="layer"></a>

### layer

```ts
const layer: Layer.Layer<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, never, never>;
```

Defined in: packages/std/build/secret/index.d.ts:188

The cipher for a host that is a plain process, which is Colony's own control-plane store.

Kept as the default because that is what it is: the browser-session vault lives host-side, in
Colony's own database, in a process that has an environment. Only the *tenant* runtime lacks one.

***

<a id="layerfrom"></a>

### layerFrom

```ts
const layerFrom: (source) => Layer.Layer<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, never, never>;
```

Defined in: packages/std/build/secret/index.d.ts:176

The cipher over one key source.

The key is read once, at layer construction, and never from `process.env` directly — Bolt
describes a workspace and a host runs it, so ambient environment access is an architecture
violation the dependency audit fails on, and Colony bans `process.env` outside its one env loader
for the same reason.

A source *failure* collapses to the same `Unavailable` an absent key produces. That is the
fail-closed direction: not being able to tell whether a key exists means there is no key to
encrypt with, and every write refuses. The reason is carried through, so the two cases read
differently in the message an operator sees.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | [`KeySource`](/docs/api-reference/std/build/secret.md#keysource) |

#### Returns

`Layer.Layer`\<`Readonly`\<\{
  `decrypt`: (`name`, `binding`, `stored`) => `Effect.Effect`\<`string`,
     \| [`SecretKeyUnavailable`](/docs/api-reference/std/build/secret.md#secretkeyunavailable)
    \| [`SecretUnreadable`](/docs/api-reference/std/build/secret.md#secretunreadable)\>;
  `encrypt`: (`operation`, `binding`, `value`) => `Effect.Effect`\<`string`, [`SecretKeyUnavailable`](/docs/api-reference/std/build/secret.md#secretkeyunavailable)\>;
\}\>, `never`, `never`\>

***

<a id="secret_key_variable"></a>

### SECRET\_KEY\_VARIABLE

```ts
const SECRET_KEY_VARIABLE: "BOLT_SECRETS_KEY" = "BOLT_SECRETS_KEY";
```

Defined in: packages/std/build/secret/index.d.ts:78

The configuration key a host supplies the vault key under. Read through `ConfigProvider`, never through `process.env`.

***

<a id="secretcipher"></a>

### SecretCipher

```ts
const SecretCipher: object;
```

Defined in: packages/std/build/secret/index.d.ts:194

#### Type Declaration

<a id="bind-1"></a>

##### bind

```ts
bind: (...parts) => string;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`parts` | `ReadonlyArray`\<`string`\> |

###### Returns

`string`

<a id="configproviderkeysource-1"></a>

##### configProviderKeySource

```ts
configProviderKeySource: Readonly<{
  read: (key) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, string>;
}>;
```

<a id="layer-1"></a>

##### layer

```ts
layer: Layer.Layer<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, never, never>;
```

<a id="layerfrom-1"></a>

##### layerFrom

```ts
layerFrom: (source) => Layer.Layer<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, never, never>;
```

###### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | [`KeySource`](/docs/api-reference/std/build/secret.md#keysource) |

###### Returns

`Layer.Layer`\<`Readonly`\<\{
  `decrypt`: (`name`, `binding`, `stored`) => `Effect.Effect`\<`string`,
     \| [`SecretKeyUnavailable`](/docs/api-reference/std/build/secret.md#secretkeyunavailable)
    \| [`SecretUnreadable`](/docs/api-reference/std/build/secret.md#secretunreadable)\>;
  `encrypt`: (`operation`, `binding`, `value`) => `Effect.Effect`\<`string`, [`SecretKeyUnavailable`](/docs/api-reference/std/build/secret.md#secretkeyunavailable)\>;
\}\>, `never`, `never`\>

<a id="secret_key_variable-1"></a>

##### SECRET\_KEY\_VARIABLE

```ts
SECRET_KEY_VARIABLE: string;
```

<a id="secretkeyunavailable-1"></a>

##### SecretKeyUnavailable

```ts
SecretKeyUnavailable: typeof SecretKeyUnavailable;
```

<a id="secretunreadable-1"></a>

##### SecretUnreadable

```ts
SecretUnreadable: typeof SecretUnreadable;
```

<a id="service"></a>

##### Service

```ts
Service: Context.Service<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>>;
```

***

<a id="service-1"></a>

### Service

```ts
const Service: Context.Service<Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>, Readonly<{
  decrypt: (name, binding, stored) => Effect.Effect<string,
     | SecretKeyUnavailable
    | SecretUnreadable>;
  encrypt: (operation, binding, value) => Effect.Effect<string, SecretKeyUnavailable>;
}>>;
```

Defined in: packages/std/build/secret/index.d.ts:121
