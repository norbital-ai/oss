// The primitive layer (§3.6 "Primitive"): single components, and compound ones as namespaces (`Dialog.Root`, `Dialog.Content`).
/** Collapsible sections: `Accordion.Root` holds `Accordion.Item`s, each a `Trigger` and its `Content`. */
export * as Accordion from './accordion/index.js';
/** A message box in a tone: `Alert.Root` with `Alert.Title` and `Alert.Description`. */
export * as Alert from './alert/index.js';
/** A modal dialog: `Dialog.Root`, its `Trigger`, and `Content` with a header, title, description and footer. */
export * as Dialog from './dialog/index.js';
/** Floating content anchored to a trigger: `Popover.Root`, `Popover.Trigger`, `Popover.Content`. */
export * as Popover from './popover/index.js';
export { Drawer, Sheet, type DrawerProps, type SheetProps } from './sheet/index.js';
export { Badge, type BadgeVariant } from './badge/index.js';
export { Button, type ButtonProps } from './button/index.js';
export { Checkbox } from './checkbox/index.js';
export { Combobox, type ComboboxOption, type ComboboxProps } from './combobox/index.js';
export { IconWrapper as Icon } from './icon/index.js';
export { Input } from './input/index.js';
export { Label } from './label/index.js';
export { Progress } from './progress/index.js';
export { Qr } from './qr/index.js';
export { Spinner } from './spinner/index.js';
export { TAB_LEVEL, Tabs, type TabItem, type TabsProps } from './tabs/index.js';
export { Textarea } from './textarea/index.js';
export { Tooltip } from './tooltip/index.js';
export { virtualList, type Virtual, type VirtualOptions } from './virtual/index.js';
export { cn, formatFileSize, setUiText, uiText, useControls, type Controls, type UiTextKey } from './utils.js';
