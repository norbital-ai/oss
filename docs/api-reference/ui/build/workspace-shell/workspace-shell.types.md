[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/workspace-shell/workspace-shell.types

# ui/build/workspace-shell/workspace-shell.types

## Interfaces

<a id="workspacenavigationitem"></a>

### WorkspaceNavigationItem

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:27

#### Properties

<a id="active"></a>

##### active

```ts
readonly active: boolean;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:32

<a id="badge"></a>

##### badge?

```ts
readonly optional badge?: string;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:33

<a id="children"></a>

##### children?

```ts
readonly optional children?: readonly WorkspaceNavigationItem[];
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:37

<a id="description"></a>

##### description?

```ts
readonly optional description?: string | null;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:35

<a id="featurecolor"></a>

##### featureColor?

```ts
readonly optional featureColor?:
  | "accessControl"
  | "agents"
  | "applications"
  | "approvals"
  | "automations"
  | "workspaceStudio"
  | "builtIn"
  | "customApps"
  | "moduleStudio"
  | "permissions"
  | "dataBrowser"
  | "tasks";
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:34

<a id="href"></a>

##### href

```ts
readonly href: string;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:31

<a id="icon"></a>

##### icon

```ts
readonly icon: string | null;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:30

<a id="key"></a>

##### key

```ts
readonly key: string;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:28

<a id="label"></a>

##### label

```ts
readonly label: string;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:29

<a id="thumbnail"></a>

##### thumbnail?

```ts
readonly optional thumbnail?: string | null;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:36

## Type Aliases

<a id="workspaceimpersonation"></a>

### WorkspaceImpersonation

```ts
type WorkspaceImpersonation = typeof WorkspaceImpersonationSchema.Type;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:60

***

<a id="workspaceimpersonationteam"></a>

### WorkspaceImpersonationTeam

```ts
type WorkspaceImpersonationTeam = typeof WorkspaceImpersonationTeamSchema.Type;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:44

***

<a id="workspacenavigationmodel"></a>

### WorkspaceNavigationModel

```ts
type WorkspaceNavigationModel = typeof WorkspaceNavigationModelSchema.Type;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:93

***

<a id="workspaceorganizationoption"></a>

### WorkspaceOrganizationOption

```ts
type WorkspaceOrganizationOption = typeof WorkspaceOrganizationOptionSchema.Type;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:18

***

<a id="workspaceusersummary"></a>

### WorkspaceUserSummary

```ts
type WorkspaceUserSummary = typeof WorkspaceUserSummarySchema.Type;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:26

## Variables

<a id="workspace_sidebar_item_text_class"></a>

### WORKSPACE\_SIDEBAR\_ITEM\_TEXT\_CLASS

```ts
const WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS: "text-xs font-normal sm:text-micro" = "text-xs font-normal sm:text-micro";
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:10

***

<a id="workspace_sidebar_section_text_class"></a>

### WORKSPACE\_SIDEBAR\_SECTION\_TEXT\_CLASS

```ts
const WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS: "text-overline" = "text-overline";
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:9

A sidebar section heading is the `text-overline` role and nothing more, so the constant
is now the role class rather than a fourth private assembly of size, weight, transform
and tracking. It stays a named export because the workspace sidebar applies it in three
places that are not `Sidebar.GroupLabel`.

***

<a id="workspace_sidebar_trailing_slot_class"></a>

### WORKSPACE\_SIDEBAR\_TRAILING\_SLOT\_CLASS

```ts
const WORKSPACE_SIDEBAR_TRAILING_SLOT_CLASS: "pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center" = "pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center";
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:12

Shared right-edge slot for expand chevrons and host-plugin badges.

## Functions

<a id="toggleworkspacenavigationbranch"></a>

### toggleWorkspaceNavigationBranch()

```ts
function toggleWorkspaceNavigationBranch(params): boolean;
```

Defined in: packages/ui/build/workspace-shell/workspace-shell.types.d.ts:67

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `params` | `WorkspaceNavigationBranchParams` |

#### Returns

`boolean`
