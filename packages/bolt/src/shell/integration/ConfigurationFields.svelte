<!-- @component Renders an integration definition's typed `configuration` fields via `@norbital-ai/ui` `Editor`. -->
<script lang="ts">
	import type { Fields, Value } from '@norbital-ai/store/kind';
	import { DescriptionHint, Editor, value_object, type FieldEditor, type UiContext } from '@norbital-ai/ui';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { humanise_word } from '../i18n.ts';

	let {
		ctx,
		integration,
		fields,
		field,
		t,
		translate = (key: string) => key
	}: {
		ctx: UiContext;
		integration: string;
		fields: Fields;
		field: FieldEditor;
		/** Framework translator (e.g. for `optional`). */
		t: (key: string) => string;
		/** Workspace translator for `integrations.<name>.configuration.{fields,help}.<field>`. */
		translate?: (key: string) => string;
	} = $props();

	const obj = (v: Value | undefined): { readonly [k: string]: Value } => (value_object(v) ? v : {});
	const configText = (name: string, part: 'fields' | 'help') => {
		const key = `integrations.${integration}.configuration.${part}.${name}`;
		const text = translate(key);
		return text === key ? undefined : text;
	};
	const labelOf = (name: string) => configText(name, 'fields') ?? humanise_word(name);
</script>

<Stack gap="sm" id={field.id}>
	{#each Object.entries(fields) as [name, kind] (name)}
		{@const help = configText(name, 'help')}
		<Stack gap="xs" class="text-sm">
			<Inline gap="xs" align="center" class="min-w-0">
				<label class="text-label" for={`${field.id}-${name}`}>
					{labelOf(name)}{#if kind.optional === true}{' '}<span class="text-meta">({t('optional')})</span>{/if}
				</label>
				{#if help}<DescriptionHint text={help} />{/if}
			</Inline>
			<Editor
				{ctx}
				id={`${field.id}-${name}`}
				{name}
				{kind}
				value={obj(field.value)[name] ?? null}
				on_change={(next) => field.on_change({ ...obj(field.value), [name]: next })}
			/>
		</Stack>
	{/each}
</Stack>
