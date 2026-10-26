// The primitive layer (§3.6 "Primitive"): single components, and compound ones as namespaces (`Dialog.Root`, `Dialog.Content`).
/** Collapsible sections: `Accordion.Root` holds `Accordion.Item`s, each a `Trigger` and its `Content`. */
export * as Accordion from './accordion/index.js';
/** A message box in a tone: `Alert.Root` with `Alert.Title` and `Alert.Description`. */
export * as Alert from './alert/index.js';
/** A modal dialog: `Dialog.Root`, its `Trigger`, and `Content` with a header, title, description and footer. */
export * as Dialog from './dialog/index.js';
/** An in-app confirmation (never `window.confirm`, which WebViews suppress): an Effect answering whether it was confirmed. */
export { confirmAction, type ConfirmOptions } from './dialog/confirm.js';
/** Floating content anchored to a trigger: `Popover.Root`, `Popover.Trigger`, `Popover.Content`. */
export * as Popover from './popover/index.js';
export { default as Drawer, type DrawerProps } from './sheet/drawer.svelte';
export { default as Sheet, type SheetProps } from './sheet/sheet.svelte';
export { default as Badge, type BadgeVariant } from './badge/badge.svelte';
export { Button, type ButtonProps } from './button/index.js';
export { default as Checkbox } from './checkbox/checkbox.svelte';
export {
	default as Combobox,
	type ComboboxOption,
	type ComboboxProps
} from './combobox/combobox.svelte';
export { default as Icon } from './icon/icon-wrapper.svelte';
export { default as Image, type ImageProps } from './image/image.svelte';
export { default as Input } from './input/input.svelte';
export { default as Label } from './label/label.svelte';
export { default as Progress } from './progress/progress.svelte';
export { default as Qr } from './qr/qr.svelte';
export { default as Spinner } from './spinner/spinner.svelte';
export { TAB_LEVEL, Tabs, type TabItem, type TabsProps } from './tabs/index.js';
export { default as Textarea } from './textarea/textarea.svelte';
/**
 * Public tooltip API is the single Provider-backed wrapper only.
 * Do not import bits-ui Tooltip (or Root/Provider/Trigger) at call sites.
 */
export { default as Tooltip } from './tooltip/tooltip.svelte';
export { virtualList, type Virtual, type VirtualOptions } from './virtual/virtual.svelte.js';
export {
	cn,
	formatFileSize,
	setUiText,
	uiText,
	useControls,
	type Controls,
	type UiTextKey
} from './utils.js';
