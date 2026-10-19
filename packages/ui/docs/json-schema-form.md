# JSON Schema input forms

`JsonSchemaForm` adds schema-driven controls to the JSON datatype editor. It shares `Editor`'s existing matrix of controls and the shell's `provideKinds` registry; it does not maintain a second datatype catalogue.

```svelte
<script lang="ts">
	import { Editor, JsonSchemaForm, type JsonSchema, type Json } from '@norbital-ai/ui';
	let value: Json = $state({});
	const schema: JsonSchema = {
		type: 'object',
		additionalProperties: false,
		required: ['name', 'pay'],
		properties: {
			name: { type: 'string', title: 'Employee name' },
			pay: {
				type: 'string',
				'x-norbital': { datatype: 'money', section: 'Payroll', advanced: false }
			},
			tax_reference: {
				type: 'string',
				'x-norbital': { datatype: 'tax_reference', section: 'Payroll' }
			},
			frequency: { type: 'string', enum: ['monthly', 'weekly'] }
		}
	};
</script>

<JsonSchemaForm {schema} {value} onChange={(next) => (value = next)} name="employee_input" />
<!-- Equivalent entry point in the existing JSON editor: -->
<Editor
	kind={{ kind: 'json' }}
	jsonSchema={schema}
	{value}
	onChange={(next) => (value = next)}
	name="employee_input"
/>
```

Within a `Field editor` snippet pass its `value`, `onChange`, `name`, `id`, and `disabled`; pass validator errors as a `ReadonlyMap<string,string>` keyed by dotted path (e.g. `employee_input.dependants.0.birth_date`). The component edits a value; the enclosing form owns submit, dirty state, authorization and server validation.

## Existing representation architecture

`RecordShell` loads the collection's registered `+representation.svelte` on first use; an authored body takes precedence, and an absent representation uses the generated record view. A representation that nests the same collection's shell gets that generated view rather than loading itself again.

`Table` sends ordinary cells through `Value` with `dense`; structured values become a single JSON preview. Expanded values delegate to `Show`, which recursively formats structured kinds. `Matrix` uses `Value` for row labels, compact shape-formatted item labels, and a `cell` snippet for authored content. `Editor` is the input datatype dispatcher. `Editor` and `Show` share `fieldEntry`, resolving the shell's tenant registry before the built-in money, file, point and phone entries; entries carry a storage shape and an optional renderer.

`Section` supplies the existing progressive disclosure: a heading, optional hint and closed summary, remembered open state, and a hidden body that stays mounted. `JsonSchemaForm` uses those sections and existing control tokens, following the established compact form layout.

## Renderer flow

The renderer resolves local `$ref` JSON Pointers against the original schema, maps supported assertions to existing `Kind` controls, and plans object sections with `jsonSchemaGroups`. Objects and arrays recurse through `JsonSchemaForm`; leaf inputs dispatch through `Editor` and the shared registry. Unsupported schema shapes or unknown datatype names reach the existing raw JSON editor with the current value intact. This path does not register new datatypes or fetch schemas.

## Datatypes and layout

`x-norbital.datatype` names a built-in (`money`, `file`, `point`, `phone`) or a workspace custom field declared under `src/data/custom_field/<name>/`. The generated shell already provides `{shape, renderer}`. Existing custom renderers receive the same edit view and callbacks as regular fields. Unknown datatypes retain a JSON editor and the current value. A declaration's storage shape and JSON Schema must agree; UI metadata does not change server admission.

The layout is automatic and compact. An object is one column of label | control rows (the label and its `description` beside the control, stacked when the container is narrow); a nested object is an indented group of its own rows. An array whose items are objects of leaf properties edits as one table — a column per property, a row per item, add and remove per row; any other array is a numbered list of its items. Fields keep declaration order; numeric `x-norbital.order` sorts them first (default `0`, ties retain declaration order). Fields without `x-norbital.section` form one untitled group; a named section becomes a titled `Section`, and `advanced: true` sections follow the rest, collapsed until opened. Error-bearing sections open and cannot conceal their errors. Collapsed fields remain mounted. A cleared optional field is removed from the value rather than written as null unless its `type` admits `null`; nullable schemas can explicitly clear to null. Defaults are offered explicitly, and array item defaults apply when the user adds an item. Opening a form never silently mutates data.

Strings, numbers, integers, booleans, dates, date-times, times, enums (including non-string values), nested objects, homogeneous arrays and local `$ref` JSON Pointers are supported. Enum selections preserve JSON types. Array add/remove obey `minItems` and `maxItems`. Unknown properties survive every structured edit and remain accessible in a collapsed raw editor; dynamic property maps use that editor too.

## Boundaries

`required` marks labels and helps plan disclosure; it does not block submission. `readOnly` makes the schema subtree inert. This is a renderer, not a JSON Schema validator. The caller must validate the complete value using its authoritative schema validator, including patterns, dependencies, uniqueness and all numeric/string constraints, and feed errors back into the form. Payroll admission/evidence rules remain in the HR template.

Remote/unresolved/cyclic references, ambiguous reference intersections, heterogeneous tuples, schema compositions and conditional schemas use the existing JSON editor rather than an invented control. The exception is a conditional (top-level `if`/`then`/`else`, or in `allOf`) whose arms only add `required` keys: it changes no control, so the base object renders and the caller's validator enforces the condition. Recursive rendering is capped at 24 levels. No network schema fetch occurs. No schema keeps the existing raw JSON editor unchanged. Existing Bolt `kind.shape` support stays available independently.

A schema stored as data (a JSON column) enters a page through `isJsonSchema`, which checks the keywords this renderer reads once; inside, the schema stays typed. To edit a schema itself, map it to rows of a fixed meta-schema (an array of flat field objects) and render that through the same component; the HR template's input-schema editor does this.
