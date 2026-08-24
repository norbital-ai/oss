[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/form/path

# ui/build/form/path

## Type Aliases

<a id="filternull"></a>

### FilterNull

```ts
type FilterNull<T> = T extends null ? never : T;
```

Defined in: packages/ui/build/form/path.d.ts:2

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

<a id="filterundefined"></a>

### FilterUndefined

```ts
type FilterUndefined<T> = T extends undefined ? never : T;
```

Defined in: packages/ui/build/form/path.d.ts:1

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

<a id="filterundefinedandnull"></a>

### FilterUndefinedAndNull

```ts
type FilterUndefinedAndNull<T> = FilterUndefined<FilterNull<T>>;
```

Defined in: packages/ui/build/form/path.d.ts:3

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

***

<a id="get"></a>

### Get

```ts
type Get<O, P> = GetWithArray<O, Path<P>>;
```

Defined in: packages/ui/build/form/path.d.ts:8

#### Type Parameters

| Type Parameter |
| ------ |
| `O` |
| `P` |

***

<a id="path"></a>

### Path

```ts
type Path<T> = T extends `${infer Key}.${infer Rest}` ? [Key, ...Path<Rest>] : T extends `${infer Key}` ? [Key] : [];
```

Defined in: packages/ui/build/form/path.d.ts:4

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |
