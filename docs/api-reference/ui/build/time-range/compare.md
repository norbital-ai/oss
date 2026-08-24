[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/time-range/compare

# ui/build/time-range/compare

## Functions

<a id="comparetimevalues"></a>

### compareTimeValues()

```ts
function compareTimeValues<T>(left, right): number;
```

Defined in: packages/ui/build/time-range/compare.d.ts:9

Compare values without discarding calendar or zone information.

`TimeValue` is intentionally polymorphic: civil `Time` values compare by clock time, while
`CalendarDateTime` and `ZonedDateTime` compare their complete instant. Flattening all three to
hour/minute/second makes a valid overnight attendance interval look reversed.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `TimeValue` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `left` | `T` \| `undefined` |
| `right` | `T` \| `undefined` |

#### Returns

`number`
