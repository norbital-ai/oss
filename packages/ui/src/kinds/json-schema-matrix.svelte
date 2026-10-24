<!--
@component
A JSON Schema as a field matrix: a row per property (nested ones indented under their group or list), its type, whether
it is required, its allowed values and its description. Given `onChange` it edits as the same matrix, one editable row
per property; every keyword a row does not show is carried from the schema it was read from.
-->
<script lang="ts" module>
	import type { Value } from './kind.js';
	/** The schema (a JSON Schema document) and, to edit it, the change callback and the inherited controls. */
	export type JsonSchemaMatrixProps = {
		value: Value;
		onChange?(next: Value): void;
		name?: string;
		id?: string;
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import Badge from '../primitives/badge/badge.svelte';
	import { uiText, type UiTextKey } from '../primitives/utils.js';
	import { humanize } from '../text/messages.js';
	import JsonSchemaForm from './json-schema-form.svelte';
	import type { JsonSchema } from './json-schema.js';
	import { FIELD_TYPES, jsonSchemaFromRows, jsonSchemaRows } from './json-schema-rows.js';

	let { value, onChange, name, id, disabled }: JsonSchemaMatrixProps = $props();
	const t = uiText();
	const TYPE_TEXT = {
		string: 'typeString',
		date: 'typeDate',
		number: 'typeNumber',
		integer: 'typeInteger',
		boolean: 'typeBoolean',
		object: 'typeObject',
		array: 'typeArray'
	} as const satisfies Record<(typeof FIELD_TYPES)[number], UiTextKey>;
	const rows = $derived(jsonSchemaRows(value));
	/** The matrix's own schema: one editable row per property path. */
	const editable = $derived<JsonSchema>({
		type: 'array',
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['path', 'type'],
			properties: {
				path: { type: 'string', title: t('schemaKey'), description: t('schemaKeyHelp') },
				type: { type: 'string', enum: [...FIELD_TYPES], title: t('schemaType') },
				label: { type: 'string', title: t('schemaLabel') },
				required: { type: 'boolean', title: t('required') },
				values: { type: 'string', title: t('schemaValues'), description: t('schemaValuesHelp') },
				help: { type: 'string', title: t('schemaHelp') }
			}
		}
	});
	const steps = (path: string) => path.split(/\.|(?=\[\])/).filter((step) => step !== '');
</script>

{#if onChange}
	<JsonSchemaForm
		schema={editable}
		value={rows}
		onChange={(next) => onChange(jsonSchemaFromRows(next, value))}
		{name}
		{id}
		{disabled}
	/>
{:else if rows.length === 0}
	<p class="text-meta" {id}>{t('schemaNone')}</p>
{:else}
	<div class="min-w-0 overflow-x-auto rounded-md border border-border" {id} data-json-schema-matrix>
		<table class="w-full text-sm">
			<thead class="bg-muted/50 text-left text-muted-foreground">
				<tr>
					<th class="px-3 py-2 font-medium whitespace-nowrap">{t('schemaField')}</th>
					<th class="px-3 py-2 font-medium whitespace-nowrap">{t('schemaType')}</th>
					<th class="min-w-40 px-3 py-2 font-medium whitespace-nowrap">{t('schemaValues')}</th>
					<th class="w-1/2 px-3 py-2 font-medium whitespace-nowrap">{t('schemaHelp')}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.path)}
					{@const path = steps(row.path)}
					{@const key = path.at(-1) ?? row.path}
					<tr class="border-t border-border align-top">
						<td class="py-2 pr-3" style:padding-left={`${0.75 + (path.length - 1) * 1.25}rem`}>
							<span class="font-medium"
								>{row.label || (key === '[]' ? t('schemaItem') : humanize(key))}</span
							>{#if row.required}<span class="ml-0.5 text-destructive" title={t('required')}>*</span
								>{/if}
							<span class="block font-mono text-xs text-muted-foreground">{key}</span>
						</td>
						<td class="px-3 py-2 whitespace-nowrap text-muted-foreground">
							{t(TYPE_TEXT[row.type])}
						</td>
						<td class="px-3 py-2">
							{#if row.values}
								<span class="flex flex-wrap gap-1">
									{#each row.values.split(', ') as option (option)}<Badge variant="outline"
											>{option}</Badge
										>{/each}
								</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-muted-foreground">{row.help}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
