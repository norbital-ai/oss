// Field kinds (§3.3.2) in the ui: `Show` renders any value, `Editor` edits any kind, and the §3.6 inputs stand alone.
export { default as TimeInput, type TimeInputProps, type TimeValue } from './time-input.svelte';
export { default as Editor, type EditorProps } from './editor.svelte';
export { default as FileInput, type FileInputProps } from './file-input.svelte';
export { default as MoneyInput, type MoneyInputProps } from './money-input.svelte';
export { default as PhoneInput, type PhoneInputProps } from './phone-input.svelte';
export { formatHandle } from './phone.js';
export { BUILTIN_FIELDS, fieldEntry } from './builtin/index.js';
/** A relation/id picker that searches only rows and labels the viewer may read, displays the chosen record's label, and emits its typed id. */
export { default as Picker, type PickerProps } from './picker.svelte';
export {
	default as NumberTuple,
	splitNumbers,
	type NumberTupleProps,
	type NumberTupleSegment,
	type NumberTupleValue
} from './number-tuple.svelte';
export { default as PointInput, type PointInputProps } from './point-input.svelte';
export { default as Show, type ShowProps } from './show.svelte';
export { default as StateBadge, type StateBadgeProps } from './state-badge.svelte';
export { default as StructuredData, type StructuredDataProps } from './structured-data.svelte';
export { default as TimeRangeInput, type TimeRangeInputProps } from './time-range-input.svelte';
export {
	provideKinds,
	useKinds,
	DEFAULT_BASEMAP,
	photonGeocoder,
	type CollectionExposure,
	type AutomationExposure,
	type CustomFieldEntry,
	type KindView,
	type Geocoder,
	type KindsHost
} from './context.js';
export type { DatePrecision, Precision, TimePrecision } from './precision.js';
export {
	enumText,
	fieldsText,
	format,
	formatValue,
	fieldName,
	pickerRead,
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
	isJsonSchema,
	isJsonSchemaDocument,
	jsonSchemaKind,
	resolveJsonSchema,
	type JsonSchema
} from './json-schema.js';
export { jsonSchemaFromRows, jsonSchemaRows, type JsonSchemaRow } from './json-schema-rows.js';

export {
	inferJsonSchema,
	kindJsonSchema,
	dataChanged,
	dataEqual,
	pairDataRows,
	type ArrayKeys
} from './structured-data.js';
