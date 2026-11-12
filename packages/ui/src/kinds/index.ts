// Field kinds in the ui: `Show` renders any value, `Editor` edits any kind, and the inputs stand alone.
export { default as TimeInput, type TimeInputProps, type TimeValue } from './time-input.svelte';
export { default as Editor, type EditorProps } from './editor.svelte';
export { default as FileInput, type FileInputProps } from './file-input.svelte';
export { default as MoneyInput, type MoneyInputProps } from './money-input.svelte';
export { default as PhoneInput, type PhoneInputProps } from './phone-input.svelte';
export { format_handle } from './phone.js';
export { BUILTIN_FIELDS, field_entry } from './builtin/index.js';
/** A relation/id picker that searches only rows and labels the viewer may read, displays the chosen record's label, and emits its typed id. */
export { default as Picker, type PickerProps } from './picker.svelte';
export { default as PointInput, type PointInputProps } from './point-input.svelte';
export { default as Show, type ShowProps } from './show.svelte';
export { default as StateBadge, type StateBadgeProps } from './state-badge.svelte';
export { default as StructuredData, type StructuredDataProps } from './structured-data.svelte';
export { default as TimeRangeInput, type TimeRangeInputProps } from './time-range-input.svelte';
export {
	DEFAULT_BASEMAP,
	photon_geocoder,
	type ModelExposure,
	type AutomationExposure,
	type CustomFieldEntry,
	type KindView,
	type Geocoder,
	type KindsHost
} from './context.js';
export type { DatePrecision, Precision, TimePrecision } from './precision.js';
export {
	enum_text,
	fields_text,
	format,
	format_value,
	field_name,
	picker_read,
	value_object,
	type EnumScope,
	type ShowOptions,
	type Fields,
	type FileRef,
	type Json,
	type Value,
	type Kind,
	type KindOf,
	type Point
} from './kind.js';
export { KINDS, presentation, sortable } from './registry.js';
export {
	is_json_schema,
	is_json_schema_document,
	json_schema_kind,
	resolve_json_schema,
	type JsonSchema
} from './json-schema.js';
export { json_schema_from_rows, json_schema_rows, type JsonSchemaRow } from './json-schema-rows.js';

export {
	infer_json_schema,
	kind_json_schema,
	data_changed,
	data_equal,
	pair_data_rows,
	type ArrayKeys
} from './structured-data.js';
