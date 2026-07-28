# Tree Select Component

A fully-featured, accessible tree selection component with keyboard navigation, search, and smooth animations.

## Design Specifications

### Visual Design & Aesthetics

#### Selected Nodes

- **Background**: `bg-accent` with `text-accent-foreground`
- **Hover State**: Background color persists on hover/focus/active states
- Checkmark indicator for single-select mode (blue circle with check icon)
- Checkbox for multi-select mode with indeterminate state support

#### Active Node Indicator (Focus Ring)

- **Type**: Ring-based visual feedback
- **Style**: 2px ring with 1px offset
- **Color**: Primary color at 60% opacity (`ring-primary/60`)
- **Animation**: Smooth transitions using motion library (150ms, custom cubic-bezier easing)
- **Visibility**: Only shown when:
  - Search input is focused, OR
  - Mouse is inside the tree body

#### Button States

- **Default**: Transparent background, no hover effect
- **Selected**: `bg-accent` background (persists across all states)
- **Focus**: No native focus ring (removed with `focus:outline-none`, `focus-visible:outline-none`, `focus-visible:ring-0`)
- **Hover**: Transparent for non-selected nodes, accent background for selected nodes
- **Disabled**: 50% opacity, not-allowed cursor

#### Tree Structure Connectors

- **Direct children of root**: No connectors, no left padding
- **Nested nodes**:
  - 8px left padding
  - L-shaped connectors for last items in a group
  - T-shaped connectors for middle items
  - Vertical lines connecting siblings
  - 18px indentation per depth level

#### Typography & Spacing

- **Font size**: `text-xs` (12px)
- **Node height**: `h-7` (28px)
- **Icon size**: 3.5x3.5 (14px)
- **Chevron size**: 3x3 (12px)
- **Required indicator**: `*` in rose-500/400 color

### Input Modes

The component tracks two distinct input modes that affect behavior:

#### Keyboard Mode

- Activated by pressing any navigation key or letter
- Hover does NOT update active node (prevents interference during navigation)
- Auto-scroll triggers after each navigation action
- Indicator shows when search input focused or mouse inside tree

#### Mouse Mode

- Activated by moving the mouse
- Hover DOES update active node (shows indicator on hover)
- No auto-scroll on hover
- Click interactions switch to mouse mode

**Mode Persistence**: Keyboard mode remains active during scrolling to prevent hover from changing the active node during round-robin navigation.

## User Controls

### Keyboard Navigation

All keyboard shortcuts work when focus is within the tree or search input.

#### Arrow Keys

- **Arrow Down**: Move to next visible node (wraps to first if at end)
- **Arrow Up**: Move to previous visible node (wraps to last if at start)
- **Arrow Right**:
  - If parent node is collapsed: Expand it
  - If parent node is expanded: Move to first child
  - If no active node: Activate first node
- **Arrow Left**:
  - If parent node is expanded: Collapse it
  - Otherwise: Move to parent node (if not root)
  - If no active node: Activate last node

#### Special Keys

- **Tab**: Navigate down (wraps around)
- **Shift + Tab**: Navigate up (wraps around)
- **Home**: Jump to first node
- **End**: Jump to last node
- **Enter / Space**:
  - In readonly mode: Toggle expand/collapse (parent nodes only)
  - In edit mode: Select/deselect node
- **Letter Keys** (A-Z): Jump to next node starting with that letter (wrapping search)

#### Auto-Scroll Behavior

- **Triggers**: Only on keyboard navigation
- **Method**: Smooth native scroll, centers element in viewport
- **Target**: ScrollArea viewport element (bound via `viewportRef`)
- **Condition**: Only scrolls if element is not already in view

### Mouse Controls

#### Hover

- Updates active node indicator (in mouse mode only)
- Shows indicator ring around hovered node
- Does not affect focus or selection

#### Click

- **On leaf node**: Toggles selection
- **On parent node**: Toggles expand/collapse
- In single-select mode: Clicking selected node deselects it
- Auto-expands parent nodes on selection (single-select mode)

#### Checkbox (Multi-Select)

- Independent of button click
- Supports indeterminate state for parent nodes
- Disabled when component is readonly or disabled

### Search/Filter

When `showSearch` is enabled:

- Real-time filtering of visible nodes
- Highlights matching text with blue background
- Search input focuses on mount (if enabled)
- Indicator visible when search input is focused

## Features

### Selection Modes

#### Single Selection

- Radio button behavior (only one selected at a time)
- Clicking already-selected node deselects it
- Checkmark indicator (✓) on selected nodes
- Auto-expands parent nodes on selection

#### Multiple Selection

- Independent checkbox selection
- Parent nodes show indeterminate state when partially selected
- Required nodes (marked with `*`) enforce sibling selection

### Tree Structure

#### Node Types

1. **Tree Child Node**: Regular leaf nodes
2. **Required Child Node**: Must be selected with all siblings
3. **Tree Parent Node**: Container nodes with children
   - Expand/collapse functionality
   - Indeterminate state (multi-select)

#### Display Features

- **Icons**: Custom icons per node (using Iconify)
- **Actions**: Custom action components/snippets per node
- **Metadata**: Generic metadata support via TypeScript generics
- **Depth indicators**: Visual hierarchy with connectors
- **Disabled state**: Per-node disable capability

### Tabs (Multiple Roots)

When tree has multiple root nodes:

- Tabs for switching between root sections
- Icons differentiate tab types (database vs document)
- Active tab indicator
- Tab-specific filtering and navigation

### Performance Optimizations

#### Rendering

- **Flat rendering**: No recursive child rendering (prevents duplication)
- Uses `visibleNodes` array computed by TreeState
- Keyed rendering with node IDs
- Efficient O(1) lookups via `nodeIndexMap`

#### Reactivity

- **No $effects**: Direct callback pattern for better control
- Explicit `updateIndicator()` calls after state changes
- `requestAnimationFrame` for DOM updates
- Derived state for computed values (O(1) access)

#### State Management

- Minimal reactive state (only what changes)
- Centralized TreeState class
- SvelteMap for efficient node lookups
- No unnecessary tracking variables

## Implementation Details

### Key Components

```typescript
// Props
interface TreeSelectProps<TMetadata> {
	rootItems: BaseTreeItem<TMetadata>[];
	value?: SelectionState<TMetadata>;
	onChange?: (state: SelectionState<TMetadata>) => void;
	disabled?: boolean;
	readonly?: boolean;
	showSearch?: boolean;
	containerClass?: string;
	multiple?: boolean;
}
```

### State Structure

```typescript
// Core reactive state
let treeContainerElement: HTMLDivElement | null = $state(null);
let inputElement: HTMLInputElement | null = $state(null);
let indicatorEl: HTMLElement | null = $state(null);
let scrollViewportRef: HTMLElement | null = $state(null);
let inputMode = $state<'keyboard' | 'mouse'>('keyboard');
let isIndicatorVisible = $state(false);
let mouseInsideTree = $state(false);
let previousRect = $state<IndicatorRect | null>(null);

// Derived state (computed)
const hasMultipleRoots = $derived(treeState.rootNodes.length > 1);
const visibleNodesArray = $derived(treeState.visibleNodes);
const nodeIndexMap = $derived.by(() => /* O(1) lookup map */);
const shouldShowIndicator = $derived(/* visibility logic */);
```

### Animation System

- **Library**: Motion (motion-one)
- **Duration**: 150ms for indicator, 300ms for scroll
- **Easing**: Custom cubic-bezier `[0.22, 1, 0.36, 1]` for indicator
- **Targets**:
  - Indicator position (left, top, width, height)
  - Scroll position (smooth native scroll)

### Scroll Implementation

```typescript
// Bound directly to ScrollArea.Viewport
<ScrollArea bind:viewportRef={scrollViewportRef}>
  {/* Tree content */}
</ScrollArea>

// Programmatic scroll
scrollViewportRef.scrollTo({
  top: targetScroll,
  behavior: 'smooth'
});
```

## Accessibility

- **ARIA Roles**: `tree`, `treeitem`, `group`
- **ARIA Attributes**:
  - `aria-multiselectable` for multi-select mode
  - `aria-readonly` for readonly checkboxes
  - `aria-label` for search input and tree navigation
  - `aria-hidden` for decorative icons
- **Keyboard Navigation**: Full keyboard support (ARIA tree pattern)
- **Focus Management**: Proper focus indicators and tab order
- **Screen Readers**: Semantic HTML and ARIA labels

## Code Quality

### Simplifications Made

- ✅ No unnecessary state tracking variables
- ✅ No single-use wrapper functions
- ✅ No reactive $effects (replaced with direct callbacks)
- ✅ Inline simple expressions instead of helper functions
- ✅ ~80-90 lines of code removed
- ✅ Cleaner mental model with explicit control flow

### Best Practices

- **Type Safety**: Full TypeScript with generics support
- **Immutability**: Readonly node properties
- **Separation of Concerns**: TreeState class for business logic
- **Explicit Over Implicit**: Direct function calls over reactive effects
- **Performance**: Minimal re-renders, efficient lookups

## Browser Support

- Modern browsers with ES2022+ support
- Svelte 5 runes syntax
- Native smooth scrolling
- CSS custom properties (variables)

## Dependencies

- `@norbital-ai/ui/button` - Button component
- `@norbital-ai/ui/checkbox` - Checkbox component
- `@norbital-ai/ui/input` - Search input
- `@norbital-ai/ui/scroll-area` - Scrollable container
- `@norbital-ai/ui/tabs` - Tab navigation
- `@iconify/svelte` - Icon rendering
- `motion` - Animation library

## Usage Example

```svelte
<script lang="ts">
	import { TreeSelect } from '@norbital-ai/ui/tree-select';

	let value = $state<SelectionState<MyMetadata>>();

	const rootItems: BaseTreeItem<MyMetadata>[] = [
		{
			id: 'root1',
			title: 'Documents',
			icon: 'lucide:folder',
			items: [
				{
					id: 'doc1',
					title: 'Resume.pdf',
					icon: 'lucide:file',
					metadata: { size: 1024 }
				}
			]
		}
	];
</script>

<TreeSelect
	{rootItems}
	bind:value
	showSearch
	multiple
	onChange={(state) => {
		//... do stuff
	}}
/>
```

## Future Enhancements

Potential improvements for consideration:

- Drag-and-drop reordering
- Virtual scrolling for large trees
- Lazy loading of children
- Customizable keyboard shortcuts
- Export/import selection state
- Undo/redo selection changes
