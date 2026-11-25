// Single-source composable Svelte-5 headless behavior primitives.
// Used directly by `@norbital-ai/ui` built-in components AND exported for tenants to compose
// custom widgets with identical keyboard navigation, ARIA, overflow, resizing, dismissal,
// focus management, shortcuts, selection, pagination, clipboard, floating, portals, dates,
// direct manipulation, canvas gestures, live announcements and agent observability hooks.
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
	create_focus_recovery,
	type FocusRecovery,
	type FocusRecoveryOptions,
	type LostFocus
} from './focus-recovery.svelte.js';
export {
	create_typeahead,
	type Typeahead,
	type TypeaheadItem,
	type TypeaheadOptions
} from './typeahead.svelte.js';
export {
	create_listbox,
	type Listbox,
	type ListboxFocusMode,
	type ListboxItem,
	type ListboxOptions
} from './listbox.svelte.js';
export {
	create_async_options,
	type AsyncOptions,
	type AsyncOptionsContext,
	type AsyncOptionsOptions,
	type AsyncOptionsPage,
	type AsyncOptionsStatus
} from './async-options.svelte.js';
export {
	create_menu,
	type Menu,
	type MenuItem,
	type MenuOptions
} from './menu.svelte.js';
export {
	create_tree,
	tree_from_paths,
	tree_checked_states,
	toggle_tree_checked,
	type FlatTreeRow,
	type Tree,
	type TreeCheckStrategy,
	type TreeCheckedState,
	type TreeNode,
	type TreeOptions
} from './tree.svelte.js';
export {
	create_grid_focus,
	create_cell_range,
	create_inline_edit,
	cell_bounds,
	cells_to_text,
	text_to_cells,
	type CellBounds,
	type CellRange,
	type CellRangeBehavior,
	type CellRangeOptions,
	type GridCell,
	type GridFocus,
	type GridFocusOptions,
	type InlineEdit,
	type InlineEditOptions,
	type InlineEditReason
} from './grid.svelte.js';
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
	bind_drag,
	create_auto_scroll,
	create_transfer,
	create_tree_reorder,
	subtree_end,
	DRAG_THRESHOLD,
	type AutoScroll,
	type AutoScrollOptions,
	type BindDragOptions,
	type PointerSample,
	type Transfer,
	type TransferDraft,
	type TransferLists,
	type TransferOptions,
	type TreePlace,
	type TreeReorder,
	type TreeReorderOptions,
	type TreeReorderRow
} from './drag.svelte.js';
export {
	create_resize,
	create_resize_box,
	type Resize,
	type ResizeAxis,
	type ResizeBox,
	type ResizeBoxOptions,
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
	inert_outside,
	lock_scroll,
	type InertHandle
} from './modal.svelte.js';
export {
	announce,
	prepare_announcements,
	set_announcer,
	type AnnounceOptions,
	type AnnouncePriority
} from './announce.svelte.js';
export {
	create_presence,
	bind_findable,
	supports_hidden_until_found,
	type FindableOptions,
	type Presence,
	type PresenceOptions,
	type PresenceState
} from './presence.svelte.js';
export {
	create_hover_intent,
	bridge_between,
	reset_hover_group,
	type HoverIntent,
	type HoverIntentOptions
} from './hover-intent.svelte.js';
export {
	create_focus_trap,
	tabbable_elements,
	type FocusTrap,
	type FocusTrapOptions
} from './focus-trap.svelte.js';
export {
	create_shortcuts,
	matches_shortcut,
	aria_keyshortcuts,
	format_shortcut,
	type MatchShortcutOptions,
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
	type FloatingAnchor,
	type FloatingOptions,
	type FloatingSide,
	type VirtualAnchor,
	type VirtualRect
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
	create_input_history,
	create_undo_stack,
	bind_hold,
	bind_repeat,
	input_hints,
	nearest_in_direction,
	spatial_move,
	type BindHoldOptions,
	type BindRepeatOptions,
	type EnterKeyHint,
	type HoldInput,
	type InputHintKind,
	type InputHints,
	type InputHistory,
	type InputHistoryOptions,
	type SpatialDirection,
	type SpatialRect,
	type UndoStack,
	type UndoStackOptions
} from './micro.svelte.js';
export {
	create_move,
	create_area,
	create_spans,
	is_span_free,
	stack_spans,
	create_lasso,
	create_viewport,
	create_connect,
	create_swipe_actions,
	bind_scroll_picker,
	type AreaBehavior,
	type AreaOptions,
	type AreaValue,
	type ConnectBehavior,
	type ConnectDraft,
	type ConnectOptions,
	type LassoBehavior,
	type LassoOptions,
	type LassoRect,
	type MoveBehavior,
	type MoveOptions,
	type MovePoint,
	type ScrollPickerOptions,
	type Span,
	type SpansBehavior,
	type SpansOptions,
	type SwipeActions,
	type SwipeActionsOptions,
	type SwipeOpen,
	type SwipeSide,
	type ViewportBehavior,
	type ViewportCamera,
	type ViewportOptions
} from './canvas.svelte.js';
export {
	create_switch,
	create_radio_group,
	create_toggle_group,
	create_number_input,
	create_rating,
	create_toolbar,
	type NumberInputOptions,
	type RadioGroupOptions,
	type RatingOptions,
	type SwitchOptions,
	type ToggleGroupOptions,
	type ToolbarOptions
} from './controls-extra.svelte.js';
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
	resolve_control,
	invoke_control,
	act_on_control,
	describe_controls,
	observe_controls,
	notify_control_change,
	create_ui_history,
	with_source,
	current_source,
	type ChangeSource,
	type ControlAction,
	type ControlChange,
	type ControlChoice,
	type ControlDescriptor,
	type ControlInvokeResult,
	type ControlSnapshot,
	type PageControlsOptions,
	type UiHistory,
	type UiHistoryEntry,
	type UiHistoryOptions
} from './controls.svelte.js';
export {
	fuzzy_score,
	match_ranges,
	match_segments,
	type MatchRange,
	type MatchSegment
} from './text-match.js';
export {
	bind_viewport,
	bind_avoid_keyboard,
	pointer_kind_of,
	create_pointer_kind,
	color_scheme_of,
	create_color_scheme,
	color_scheme_script,
	is_focus_from_keyboard,
	current_modality,
	keep_focus,
	bind_drag_preview,
	create_preview,
	settle_draft,
	create_cookie_storage,
	create_overlay_stack,
	type ColorSchemeOptions,
	type ColorSchemePreference,
	type CookieStorageOptions,
	type DragPreviewOptions,
	type InputModality,
	type OverlayEntry,
	type PointerKindState,
	type PointerPrecision,
	type PreviewOptions,
	type PreviewState,
	type ResolvedColorScheme,
	type ViewportState
} from './platform.svelte.js';
export {
	rubber_band,
	create_velocity_tracker,
	nearest_snap_point,
	step_spring,
	create_drawer,
	type DrawerBehavior,
	type DrawerOptions,
	type DrawerSide,
	type SpringState
} from './motion.svelte.js';
export {
	create_token_input,
	create_trigger_menu,
	create_checkbox_group,
	create_file_dropzone,
	create_password_input,
	type CheckboxGroup,
	type CheckboxGroupOptions,
	type FileDropzone,
	type FileDropzoneOptions,
	type PasswordInput,
	type PasswordInputOptions,
	type RejectedFile,
	type TokenInput,
	type TokenInputOptions,
	type TriggerMatch,
	type TriggerMenu,
	type TriggerMenuItem,
	type TriggerMenuOptions
} from './inputs-extra.svelte.js';
export {
	create_panel_group,
	create_carousel,
	create_menubar,
	create_navigation_menu,
	create_hover_card,
	parse_color,
	format_color,
	rgb_to_hsl,
	hsl_to_rgb,
	rgb_to_hsv,
	hsv_to_rgb,
	contrast_ratio,
	mix_colors,
	create_color_picker,
	create_image_cropper,
	create_waterfall,
	create_timeline,
	type CarouselBehavior,
	type CarouselOptions,
	type ColorPickerBehavior,
	type ColorPickerOptions,
	type CropRect,
	type HoverCardBehavior,
	type HoverCardOptions,
	type HslaColor,
	type HsvaColor,
	type ImageCropperBehavior,
	type ImageCropperOptions,
	type MenubarBehavior,
	type MenubarOptions,
	type NavigationMenuBehavior,
	type NavigationMenuOptions,
	type PanelGroup,
	type PanelGroupOptions,
	type PanelSpec,
	type RgbaColor,
	type TimelineBehavior,
	type TimelineOptions,
	type WaterfallBehavior,
	type WaterfallItem,
	type WaterfallOptions
} from './widgets-extra.svelte.js';
export {
	check_pattern,
	check_direction,
	type AriaPattern,
	type PatternViolation
} from './testing.js';
export {
	virtual_list,
	type Virtual,
	type VirtualOptions
} from '../primitives/virtual/virtual.svelte.js';
