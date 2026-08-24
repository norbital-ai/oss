[**Norbital API Reference v0.0.1**](../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/feature-colors

# ui/build/feature-colors

## Type Aliases

<a id="featurecolorkey"></a>

### FeatureColorKey

```ts
type FeatureColorKey = typeof FeatureColorKeySchema.Type;
```

Defined in: packages/ui/build/feature-colors/index.d.ts:3

***

<a id="featurecolorstyles"></a>

### FeatureColorStyles

```ts
type FeatureColorStyles = typeof FeatureColorStylesSchema.Type;
```

Defined in: packages/ui/build/feature-colors/index.d.ts:11

## Variables

<a id="feature_color_styles"></a>

### FEATURE\_COLOR\_STYLES

```ts
const FEATURE_COLOR_STYLES: Record<FeatureColorKey, FeatureColorStyles>;
```

Defined in: packages/ui/build/feature-colors/index.d.ts:12

***

<a id="featurecolorkeyschema"></a>

### FeatureColorKeySchema

```ts
const FeatureColorKeySchema: Schema.Literals<readonly ["accessControl", "agents", "applications", "approvals", "automations", "workspaceStudio", "builtIn", "customApps", "moduleStudio", "permissions", "dataBrowser", "tasks"]>;
```

Defined in: packages/ui/build/feature-colors/index.d.ts:2

***

<a id="featurecolorstylesschema"></a>

### FeatureColorStylesSchema

```ts
const FeatureColorStylesSchema: Schema.Struct<{
  accentClass: Schema.String;
  icon: Schema.String;
  iconClass: Schema.String;
  iconWrapperClass: Schema.String;
  navIcon: Schema.String;
}>;
```

Defined in: packages/ui/build/feature-colors/index.d.ts:4
