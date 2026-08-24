[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/product-icon/product-icons

# ui/build/product-icon/product-icons

## Type Aliases

<a id="producticonname"></a>

### ProductIconName

```ts
type ProductIconName = typeof PRODUCT_ICON_NAMES[number];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:5

***

<a id="producticonprimitive"></a>

### ProductIconPrimitive

```ts
type ProductIconPrimitive = typeof ProductIconPrimitiveSchema.Type;
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:35

***

<a id="producticonreference"></a>

### ProductIconReference

```ts
type ProductIconReference = `product:${ProductIconName}`;
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:8

***

<a id="productlayericonname"></a>

### ProductLayerIconName

```ts
type ProductLayerIconName = typeof PRODUCT_LAYER_ICON_NAMES[number];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:6

***

<a id="productsubmoduleiconname"></a>

### ProductSubmoduleIconName

```ts
type ProductSubmoduleIconName = typeof PRODUCT_SUBMODULE_ICON_NAMES[number];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:7

## Variables

<a id="product_icon_names"></a>

### PRODUCT\_ICON\_NAMES

```ts
const PRODUCT_ICON_NAMES: readonly ["bolt", "colony", "model", "security", "logic", "interface", "models", "relations", "policies", "approvals", "audit", "hooks", "pipelines", "integrations", "automations", "remotes", "apps", "agent", "collections", "studio", "environment", "organization", "documentation", "quick-start", "concepts", "api", "deployment", "examples"];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:4

***

<a id="product_layer_icon_geometry"></a>

### PRODUCT\_LAYER\_ICON\_GEOMETRY

```ts
const PRODUCT_LAYER_ICON_GEOMETRY: object;
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:37

Canonical layer geometry shared by SVG icons and procedural product illustrations.

#### Type Declaration

<a id="interface"></a>

##### interface

```ts
readonly interface: readonly [{
  height: 14;
  kind: "rect";
  rx: 2;
  width: 10;
  x: 2;
  y: 5;
}, {
  cx: 18;
  cy: 12;
  kind: "circle";
  r: 3;
}, {
  accent: true;
  d: "M12 12h3";
  kind: "path";
}];
```

<a id="logic"></a>

##### logic

```ts
readonly logic: readonly [{
  d: "M16 3h5v5M4 20l6-6M14 10l7-7M4 4l5 5M15 15l6 6M21 16v5h-5";
  kind: "path";
}, {
  accent: true;
  d: "m10 14 4-4";
  kind: "path";
}];
```

<a id="model"></a>

##### model

```ts
readonly model: readonly [{
  cx: 12;
  cy: 5;
  kind: "ellipse";
  rx: 9;
  ry: 3;
}, {
  d: "M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5";
  kind: "path";
}, {
  d: "M3 12c0 1.7 4 3 9 3s9-1.3 9-3";
  kind: "path";
}, {
  accent: true;
  d: "M3 5v4";
  kind: "path";
}];
```

<a id="security"></a>

##### security

```ts
readonly security: readonly [{
  d: "M12 3 19 6v5c0 4.5-2.7 7.6-7 10-4.3-2.4-7-5.5-7-10V6l7-3Z";
  kind: "path";
}, {
  accent: true;
  d: "m9.5 12 1.7 1.7 3.5-3.7";
  kind: "path";
}];
```

***

<a id="product_layer_icon_names"></a>

### PRODUCT\_LAYER\_ICON\_NAMES

```ts
const PRODUCT_LAYER_ICON_NAMES: readonly ["model", "security", "logic", "interface"];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:2

***

<a id="product_submodule_icon_names"></a>

### PRODUCT\_SUBMODULE\_ICON\_NAMES

```ts
const PRODUCT_SUBMODULE_ICON_NAMES: readonly ["models", "relations", "policies", "approvals", "audit", "hooks", "pipelines", "integrations", "automations", "remotes", "apps", "agent"];
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:3

## Functions

<a id="producticonnamefromreference"></a>

### productIconNameFromReference()

```ts
function productIconNameFromReference(reference):
  | "model"
  | "security"
  | "approvals"
  | "automations"
  | "bolt"
  | "colony"
  | "logic"
  | "interface"
  | "models"
  | "relations"
  | "policies"
  | "audit"
  | "hooks"
  | "pipelines"
  | "integrations"
  | "remotes"
  | "apps"
  | "agent"
  | "collections"
  | "studio"
  | "environment"
  | "organization"
  | "documentation"
  | "quick-start"
  | "concepts"
  | "api"
  | "deployment"
  | "examples"
  | null;
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:90

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `reference` | `string` \| `null` \| `undefined` |

#### Returns

  \| `"model"`
  \| `"security"`
  \| `"approvals"`
  \| `"automations"`
  \| `"bolt"`
  \| `"colony"`
  \| `"logic"`
  \| `"interface"`
  \| `"models"`
  \| `"relations"`
  \| `"policies"`
  \| `"audit"`
  \| `"hooks"`
  \| `"pipelines"`
  \| `"integrations"`
  \| `"remotes"`
  \| `"apps"`
  \| `"agent"`
  \| `"collections"`
  \| `"studio"`
  \| `"environment"`
  \| `"organization"`
  \| `"documentation"`
  \| `"quick-start"`
  \| `"concepts"`
  \| `"api"`
  \| `"deployment"`
  \| `"examples"`
  \| `null`

***

<a id="producticonreference-1"></a>

### productIconReference()

```ts
function productIconReference(name):
  | "product:organization"
  | "product:agent"
  | "product:apps"
  | "product:approvals"
  | "product:automations"
  | "product:studio"
  | "product:models"
  | "product:policies"
  | "product:model"
  | "product:security"
  | "product:bolt"
  | "product:colony"
  | "product:logic"
  | "product:interface"
  | "product:relations"
  | "product:audit"
  | "product:hooks"
  | "product:pipelines"
  | "product:integrations"
  | "product:remotes"
  | "product:collections"
  | "product:environment"
  | "product:documentation"
  | "product:quick-start"
  | "product:concepts"
  | "product:api"
  | "product:deployment"
  | "product:examples";
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:91

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | \| `"model"` \| `"security"` \| `"approvals"` \| `"automations"` \| `"bolt"` \| `"colony"` \| `"logic"` \| `"interface"` \| `"models"` \| `"relations"` \| `"policies"` \| `"audit"` \| `"hooks"` \| `"pipelines"` \| `"integrations"` \| `"remotes"` \| `"apps"` \| `"agent"` \| `"collections"` \| `"studio"` \| `"environment"` \| `"organization"` \| `"documentation"` \| `"quick-start"` \| `"concepts"` \| `"api"` \| `"deployment"` \| `"examples"` |

#### Returns

  \| `"product:organization"`
  \| `"product:agent"`
  \| `"product:apps"`
  \| `"product:approvals"`
  \| `"product:automations"`
  \| `"product:studio"`
  \| `"product:models"`
  \| `"product:policies"`
  \| `"product:model"`
  \| `"product:security"`
  \| `"product:bolt"`
  \| `"product:colony"`
  \| `"product:logic"`
  \| `"product:interface"`
  \| `"product:relations"`
  \| `"product:audit"`
  \| `"product:hooks"`
  \| `"product:pipelines"`
  \| `"product:integrations"`
  \| `"product:remotes"`
  \| `"product:collections"`
  \| `"product:environment"`
  \| `"product:documentation"`
  \| `"product:quick-start"`
  \| `"product:concepts"`
  \| `"product:api"`
  \| `"product:deployment"`
  \| `"product:examples"`

***

<a id="productlayericongeometry"></a>

### productLayerIconGeometry()

```ts
function productLayerIconGeometry(name):
  | readonly (
  | {
  accent?: true;
  d: string;
  kind: "path";
}
  | {
  accent?: true;
  cx: number;
  cy: number;
  kind: "ellipse";
  rx: number;
  ry: number;
}
  | {
  accent?: true;
  cx: number;
  cy: number;
  kind: "circle";
  r: number;
}
  | {
  accent?: true;
  height: number;
  kind: "rect";
  rx: number;
  width: number;
  x: number;
  y: number;
})[]
  | null;
```

Defined in: packages/ui/build/product-icon/product-icons.d.ts:89

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `name` | \| `"model"` \| `"security"` \| `"approvals"` \| `"automations"` \| `"bolt"` \| `"colony"` \| `"logic"` \| `"interface"` \| `"models"` \| `"relations"` \| `"policies"` \| `"audit"` \| `"hooks"` \| `"pipelines"` \| `"integrations"` \| `"remotes"` \| `"apps"` \| `"agent"` \| `"collections"` \| `"studio"` \| `"environment"` \| `"organization"` \| `"documentation"` \| `"quick-start"` \| `"concepts"` \| `"api"` \| `"deployment"` \| `"examples"` |

#### Returns

  \| readonly (
  \| \{
  `accent?`: `true`;
  `d`: `string`;
  `kind`: `"path"`;
\}
  \| \{
  `accent?`: `true`;
  `cx`: `number`;
  `cy`: `number`;
  `kind`: `"ellipse"`;
  `rx`: `number`;
  `ry`: `number`;
\}
  \| \{
  `accent?`: `true`;
  `cx`: `number`;
  `cy`: `number`;
  `kind`: `"circle"`;
  `r`: `number`;
\}
  \| \{
  `accent?`: `true`;
  `height`: `number`;
  `kind`: `"rect"`;
  `rx`: `number`;
  `width`: `number`;
  `x`: `number`;
  `y`: `number`;
\})[]
  \| `null`
