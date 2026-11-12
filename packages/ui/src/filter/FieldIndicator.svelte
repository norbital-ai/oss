<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import { bolt_of } from '../client/context.js';
	import { msg } from '../text/messages.js';
	import type { Resolved } from './catalog.js';
	let {
		ctx,
		resolved = null,
		many = false,
		nested = false
	}: { ctx: UiContext; resolved?: Resolved | null; many?: boolean; nested?: boolean } = $props();
	const bolt = $derived(bolt_of(ctx));
	const info = $derived.by((): { name: GlyphName; label: string } => {
		if (many) return { name: 'links', label: msg(bolt, 'view.type.many') };
		if (resolved?.leaf === 'rel')
			return { name: 'link', label: msg(bolt, 'view.type.record') };
		if (resolved === null) return { name: 'panel', label: msg(bolt, 'view.field') };
		const kind = resolved?.leaf === 'field' ? resolved.kind.kind : undefined;
		let field: { name: GlyphName; label: string };
		if (kind === 'date')
			field = { name: 'fieldDate', label: msg(bolt, 'view.type.date') };
		else if (kind === 'period')
			field = { name: 'fieldPeriod', label: msg(bolt, 'view.type.period') };
		else if (kind === 'instant' || kind === 'time')
			field = { name: 'fieldTime', label: msg(bolt, 'view.type.time') };
		else if (kind === 'bool')
			field = { name: 'fieldBool', label: msg(bolt, 'view.type.bool') };
		else if (kind === 'json' || kind === 'object' || kind === 'custom')
			field = { name: 'fieldObject', label: msg(bolt, 'view.type.structured') };
		else if (kind === 'enum' || kind === 'state' || kind === 'currency')
			field = { name: 'fieldChoice', label: msg(bolt, 'view.type.choice') };
		else if (
			kind !== undefined &&
			['int', 'number', 'decimal', 'money', 'sum', 'count'].includes(kind)
		)
			field = { name: 'fieldNumber', label: msg(bolt, 'view.type.number') };
		else field = { name: 'fieldText', label: msg(bolt, 'view.type.text') };
		return nested
			? {
					name: 'fieldInside',
					label: `${msg(bolt, 'view.type.linked')} · ${field.label}`
				}
			: field;
	});
</script>

<span
	class="text-muted-foreground inline-flex shrink-0 items-center"
	title={info.label}
	role="img"
	aria-label={info.label}
	data-field-type={info.name}
>
	<Glyph name={info.name} class="size-3" />
</span>
