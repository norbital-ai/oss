# Structured data

`StructuredData` renders a JSON Schema, its values, an editable draft, or an inline comparison through one component. It uses the existing `Table` for repeated values and `Editor`/`Show` for native leaf datatypes. Workspace custom renderers retain precedence.

```svelte
<script lang="ts">
	import { StructuredData, type JsonSchema, type Value } from '@norbital-ai/ui';
	let value: Value = $state({ name: 'A. Tan', active: false, dependants: [] });
	const schema: JsonSchema = {
		type: 'object',
		additionalProperties: false,
		required: ['name'],
		properties: {
			name: { type: 'string', title: 'Employee name' },
			active: { type: 'boolean' },
			dependants: {
				type: 'array',
				items: {
					type: 'object',
					properties: { name: { type: 'string' }, birth_date: { type: 'string', format: 'date' } }
				}
			}
		}
	};
</script>

<StructuredData
	{schema}
	{value}
	mode="edit"
	onChange={(next) => (value = next)}
	name="employee_input"
/>
<StructuredData {schema} {value} mode="view" />
<StructuredData {schema} mode="schema" />
```

Without an explicit mode, an `onChange` callback selects editing; otherwise the component shows values. Within a `Field editor` snippet, pass `value`, `onChange`, `name`, `id`, `disabled`, and the owning form's validation errors. The form retains submit, dirty state, authorization, and server validation.

## Inputs and modes

| Prop                                            | Meaning                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `schema?: JsonSchema`                           | Schema describing the value. In schema mode, this is the document being shown or authored.                                          |
| `kind?: Kind`                                   | Declared native shape and leaf kinds. Pass it when native precision, periods, custom datatypes, labels, or hidden fields are known. |
| `value?: Value`                                 | Current data. Missing, null, false, zero, and empty values retain their distinct meanings.                                          |
| `before?: Value`                                | Previous data for diff mode.                                                                                                        |
| `mode?: 'view' \| 'edit' \| 'schema' \| 'diff'` | Read values, edit values, inspect/author the schema, or compare values.                                                             |
| `onChange?(next: Value)`                        | Replaces the draft; in schema mode, receives the authored schema document.                                                          |
| `name?`, `id?`                                  | Dotted error-path prefix and control identity.                                                                                      |
| `readonly?`, `disabled?`                        | Inherited controls. Read-only shows values; disabled keeps editors inert.                                                           |
| `errors?: ReadonlyMap<string, string>`          | Validation errors keyed by dotted path, such as `employee_input.dependants.0.birth_date`.                                           |
| `row?`, `beforeRow?`                            | Current/prior native leaf context, including sibling currency fields.                                                               |
| `arrayKeys?`                                    | Explicit list identities by JSON Pointer. A string names one key; a string tuple names a composite key.                             |
| `changesOnly?: boolean`                         | Restricts diff mode to changed fields and rows.                                                                                     |

Objects use compact label/value rows, with nested objects and lists under aligned disclosure headings. Record lists use columns for their fields; other lists use a value column. The embedded model table retains column resizing, reordering, and layout persistence. Row removal appears on hover or focus, with an accessible touch affordance, rather than adding a Remove column. Boolean values use checkboxes.

Schema mode shows primitive types beside fields, with structural rows grouping objects and arrays. Supplying `onChange` edits the schema's property rows through the same component. `jsonSchemaRows` and `jsonSchemaFromRows` preserve schema keywords that those rows do not edit.

## Diffs

Diff mode preserves the normal form and table structure. Replaced values appear together: previous values are red and struck through; current values are green. Added and removed record rows use the same columns. Unchanged values keep their normal rendering.

```svelte
<StructuredData
	{schema}
	before={previous}
	value={current}
	mode="diff"
	arrayKeys={{ '/leave_catalog': 'code', '/rule_set': ['family', 'code'] }}
/>
```

Explicit keys must be present and unique in both versions. With valid identities, reordering alone is not a data change; without them, lists compare by position. Callers project out system metadata before comparison and supply only data the viewer may read. Rendering does not grant access or fetch another version.

## Native datatypes and fallback

`Editor` and `Show` retain the shared `provideKinds` registry and built-in controls for dates, date-times, periods, numbers, enums, files, money, points, and custom datatypes. A schema's `x-norbital.datatype` names a registered custom field. Preserve a declared `Kind` when its semantics are richer than JSON Schema; schema inference does not guess a date, currency, period, or tenant datatype from a string or object.

When no schema or native shape is supplied, `inferJsonSchema` describes the observed data. Every list item contributes to the inferred shape; mixed values remain mixed. Inference does not invent required fields, defaults, enums, or formats. Unknown properties survive edits. Native hidden fields and masked values stay hidden.

Generic JSON and custom-datatype fallbacks use this renderer too. Dense model cells show a compact summary and open the same structured view. An authored custom renderer, relation link, or file control keeps its existing behavior.

Source text remains an explicit editor use case. `Editor rawJson` selects the raw JSON editor and retains invalid text drafts until parsing succeeds; it is an escape hatch for JSON authoring, not a second data renderer.

## Validation boundary

Decode a stored schema once with `isJsonSchema` at the page boundary. Local references resolve against the original document; remote schemas are not fetched. The rendering plan is conservative, and rendering depth is bounded. Unsupported shapes retain their values through the raw editor rather than inventing datatype semantics.

This component does not validate JSON Schema admission. The caller's authoritative validator must enforce required fields, patterns, compositions, dependencies, uniqueness, and numeric/string constraints, then return errors to the owning form. Native editing behavior, schema metadata, and inference do not replace server validation or authorization.
