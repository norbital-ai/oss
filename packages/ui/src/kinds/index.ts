// Field kinds (§3.3.2) in the ui: `Show` renders any value, `Editor` edits any kind, and the §3.6 inputs stand alone.
export { default as DateInput, type DateInputProps } from './date-input.svelte';
export { default as Editor, type EditorProps } from './editor.svelte';
export { default as FileInput, type FileInputProps } from './file-input.svelte';
export { default as MoneyInput, type MoneyInputProps } from './money-input.svelte';
export { default as MonthInput, type MonthInputProps } from './month-input.svelte';
export { default as PeriodInput, type PeriodInputProps } from './period-input.svelte';
export { default as PhoneInput, type PhoneInputProps } from './phone-input.svelte';
export { formatHandle } from './phone.js';
export { BUILTIN_FIELDS, fieldEntry } from './builtin/index.js';
import type { ComponentConstructorOptions, SvelteComponent } from 'svelte';
import type { CollectionKey } from '../views/bolt.js';
import PickerView, { type PickerProps } from './picker.svelte';
/** `Picker` typed by its target: `value` and `onChange` carry that collection's ids. */
export const Picker = PickerView as unknown as {
	new <const C extends CollectionKey>(options: ComponentConstructorOptions<PickerProps<C>>): SvelteComponent<PickerProps<C>>;
	<const C extends CollectionKey>(internal: unknown, props: PickerProps<C>): {};
};
export type { PickerProps };
export { default as NumberTuple, splitNumbers, type NumberTupleProps, type NumberTupleSegment, type NumberTupleValue } from './number-tuple.svelte';
export { default as PointInput, type PointInputProps } from './point-input.svelte';
export { default as SchemaEditor, type SchemaEditorProps } from './schema-editor.svelte';
export { default as Show, type ShowProps } from './show.svelte';
export { default as StateBadge, type StateBadgeProps } from './state-badge.svelte';
export { default as TimeRangeInput, type TimeRange, type TimeRangeInputProps } from './time-range-input.svelte';
export {
	provideKinds, useKinds, DEFAULT_BASEMAP, DEFAULT_GEOCODER,
	type CollectionExposure, type CustomFieldEntry, type CustomFieldView, type Geocoder, type KindsHost
} from './context.js';
export type { DatePrecision, Precision, TimePrecision } from './precision.js';
export { enumText, fieldsText, format, fieldName, pickerRead, type EnumScope, type ShowOptions, type Fields, type FileRef, type Json, type Kind, type KindOf, type Point } from './kind.js';
