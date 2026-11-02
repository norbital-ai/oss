<script lang="ts" module>
	import { getContext, setContext, type Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	const FIELD_PRESENTATION = Symbol.for('norbital.ui.field.presentation');
	/** The enclosing field owns the error hint for this control, including structured editors. */
	export const useFieldPresentation = () =>
		getContext<{ readonly id: string } | undefined>(FIELD_PRESENTATION);
</script>

<script lang="ts">
	import DescriptionHint from './description-hint.svelte';
	import { cn, uiText } from '../primitives/utils.js';

	let {
		id,
		label,
		help,
		error,
		readonly = false,
		required = false,
		dirty = false,
		dense = false,
		class: className,
		children,
		...rest
	}: Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'children'> & {
		id: string;
		label: string;
		help?: string;
		error?: string;
		readonly?: boolean;
		required?: boolean;
		/** The draft differs from what the form opened with (the row, else the defaults). */
		dirty?: boolean;
		dense?: boolean;
		children: Snippet;
	} = $props();
	const t = uiText();
	const description = $derived(error ?? help);
	setContext(FIELD_PRESENTATION, {
		get id() {
			return id;
		}
	});
</script>

<div
	{...rest}
	class={cn('grid min-w-0 content-start', readonly ? 'gap-1' : 'gap-2', className)}
	data-readonly={readonly || undefined}
	data-invalid={error ? true : undefined}
	data-field-dirty={dirty || undefined}
	role={readonly ? 'group' : undefined}
	aria-labelledby={readonly ? `${id}-label` : undefined}
	{@attach (node) => {
		if (readonly) return;
		const control = node.querySelector(`#${CSS.escape(id)}`);
		if (required) control?.setAttribute('aria-required', 'true');
		else control?.removeAttribute('aria-required');
		if (error) {
			control?.setAttribute('aria-invalid', 'true');
			control?.setAttribute('aria-errormessage', `${id}-error`);
		} else {
			control?.removeAttribute('aria-invalid');
			control?.removeAttribute('aria-errormessage');
		}
	}}
>
	<div class="flex min-w-0 items-center gap-1">
		<svelte:element
			this={readonly ? 'span' : 'label'}
			id={`${id}-label`}
			for={readonly ? undefined : id}
			class={cn(
				'min-w-0',
				dense
					? 'sr-only'
					: `text-xs font-medium ${error ? 'text-destructive' : 'text-muted-foreground'}`
			)}
		>
			{label}{#if !readonly && required}<span class="text-destructive" aria-label={t('required')}
					>*</span
				>{/if}
		</svelte:element>
		{#if !readonly && dirty}<span
				class="size-1.5 shrink-0 rounded-full bg-amber-500"
				title={t('unsaved')}
				aria-label={t('unsaved')}
				data-field-dirty-mark
			></span>{/if}
		{#if description && !dense}<DescriptionHint
				text={description}
				class={error ? 'text-destructive' : undefined}
			/>{/if}
	</div>
	{@render children()}
	{#if error}<p id={`${id}-error`} class="sr-only" role="alert">{error}</p>{/if}
</div>
