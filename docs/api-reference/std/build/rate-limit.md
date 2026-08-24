[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / std/build/rate-limit

# std/build/rate-limit

## Variables

<a id="bucketkey"></a>

### bucketKey

```ts
const bucketKey: (scope, identity) => Effect.Effect<string>;
```

Defined in: packages/std/build/rate-limit/index.d.ts:34

What a bucket is named, with the identifying half hashed.

It lives in `std` for the reason the secret cipher does: more than one thing has to rate limit,
and they are not the same thing. Bolt limits a workspace's own commands against a policy the
workspace declares in `src/+ratelimits.ts`, counting in memory inside the runtime with Effect's
own `RateLimiter`. Colony limits the *bootstrap* path — a sign-in code requested before any
tenant exists, so there is no `+ratelimits.ts` to consult and nothing to key on but the address —
counting in its control store.

Those two differ in **where the policy comes from** and in **where the counts are kept** — and
the counting itself belongs to Effect, which both sides use. What must not differ is the key
derivation: an address must never be a key in either store, and there is one answer, not two, to
what a bucket is called.

The hash is not decoration. A limiter keyed on an email address turns every address anyone types
into a key in whatever store holds the counts — a control-plane row, a log line that prints a key,
a dump taken for an unrelated reason — and a list of the addresses that have tried to sign in is
personal data nobody decided to collect. Hashing means the store holds a counter under an opaque
name and the address stays in the request that named it.

It has to be a *cryptographic* hash rather than a fast one that would keep this synchronous.
Email addresses are a low-entropy space; a non-cryptographic digest over one is reversible by
enumeration, which gives back exactly the list this exists to avoid holding.

`scope` is the fixed part and stays legible: the tenant, the command, and which kind of key this
is. That is what makes a bucket findable when something is being diagnosed, and none of it
identifies a person. Only `identity` — the address, the user id — is hashed.

Truncated to 32 hex characters. 128 bits of SHA-256 is far past any collision that matters for a
counter, and a full digest only makes keys longer in every store that holds one.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `scope` | `ReadonlyArray`\<`string`\> |
| `identity` | `string` \| `undefined` |

#### Returns

`Effect.Effect`\<`string`\>
