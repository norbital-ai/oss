// Single-source composable Svelte-5 headless behavior primitives.
// Used directly by `@norbital-ai/ui` built-in components AND exported for tenants to compose
// custom widgets with identical keyboard navigation, ARIA, overflow, resizing, dismissal,
// focus management, shortcuts, selection, pagination, clipboard, floating, portals, dates and agent hooks.
export {
	create_disclosure,
	type Disclosure,
	type DisclosureOptions
} from './disclosure.svelte.js';
export {
	create_accordion,
	type Accordion,
	type AccordionMode,
	type AccordionOptions
} from './accordion.svelte.js';
export {
	create_selection,
	type Selection,
	type SelectionMode,
	type SelectionOptions
} from './selection.svelte.js';
export {
	create_roving_focus,
	type RovingFocus,
	type RovingFocusOptions,
	type RovingOrientation
} from './roving-focus.svelte.js';
export {
	create_typeahead,
	type Typeahead,
	type TypeaheadItem,
	type TypeaheadOptions
} from './typeahead.svelte.js';
export {
	create_listbox,
	type Listbox,
	type ListboxItem,
	type ListboxOptions
} from './listbox.svelte.js';
export {
	create_tree,
	type FlatTreeRow,
	type Tree,
	type TreeNode,
	type TreeOptions
} from './tree.svelte.js';
export {
	create_overflow,
	type Overflow,
	type OverflowOptions
} from './overflow.svelte.js';
export {
	create_reorder,
	move_item,
	type Reorder,
	type ReorderOptions,
	type ReorderOrientation
} from './reorder.svelte.js';
export {
	create_resize,
	type Resize,
	type ResizeAxis,
	type ResizeOptions
} from './resize.svelte.js';
export {
	create_slider,
	type Slider,
	type SliderOptions
} from './slider.svelte.js';
export {
	create_dismiss,
	type DismissLayer,
	type DismissOptions,
	type DismissReason
} from './dismiss.svelte.js';
export {
	create_focus_trap,
	tabbable_elements,
	type FocusTrap,
	type FocusTrapOptions
} from './focus-trap.svelte.js';
export {
	create_shortcuts,
	matches_shortcut,
	type ShortcutBinding
} from './shortcuts.svelte.js';
export {
	create_stick_to_bottom,
	type StickToBottom,
	type StickToBottomOptions
} from './stick-to-bottom.svelte.js';
export {
	create_pagination,
	page_range,
	type Pagination,
	type PaginationEntry,
	type PaginationOptions
} from './pagination.svelte.js';
export {
	create_clipboard,
	type Clipboard,
	type ClipboardOptions
} from './clipboard.svelte.js';
export {
	create_field,
	type FieldBehavior,
	type FieldBehaviorOptions
} from './field.svelte.js';
export {
	create_floating,
	type Floating,
	type FloatingAlign,
	type FloatingOptions,
	type FloatingSide
} from './floating.svelte.js';
export {
	portal,
	set_portal_target,
	get_portal_target,
	type PortalOptions,
	type PortalTarget
} from './portal.svelte.js';
export {
	create_pin_input,
	type PinCell,
	type PinInputBehavior,
	type PinInputOptions
} from './pin.svelte.js';
export {
	create_date_field,
	create_time_field,
	create_calendar,
	type CalendarBehavior,
	type CalendarMode,
	type CalendarMonth,
	type CalendarOptions,
	type CalendarRange,
	type DateFieldBehavior,
	type DateFieldOptions,
	type DateTimeSegment,
	type SegmentPart,
	type TimeFieldBehavior,
	type TimeFieldOptions
} from './date-time.svelte.js';
export {
	watch,
	watch_pre,
	Debounced,
	use_debounce,
	PersistedState,
	type PersistedStateOptions,
	type WatchOptions
} from './reactive.svelte.js';
export {
	register_control,
	page_controls,
	act_on_control,
	describe_controls,
	type ControlAction,
	type ControlDescriptor,
	type ControlSnapshot
} from './controls.svelte.js';
export {
	virtual_list,
	type Virtual,
	type VirtualOptions
} from '../primitives/virtual/virtual.svelte.js';
