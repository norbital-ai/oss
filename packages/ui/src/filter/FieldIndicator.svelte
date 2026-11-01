<script lang="ts">
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import { useBolt } from '../client/context.js';
	import { msg } from '../text/messages.js';
	import type { Resolved } from './filter.js';
	let {
		resolved = null,
		many = false,
		nested = false
	}: { resolved?: Resolved | null; many?: boolean; nested?: boolean } = $props();
	const bolt = useBolt();
	const info = $derived.by((): { name: GlyphName; label: string } => {
		if (many) return { name: 'links', label: msg(bolt, 'view.type.many', 'Related records') };
		if (resolved?.leaf === 'rel')
			return { name: 'link', label: msg(bolt, 'view.type.record', 'Related record') };
		if (resolved === null) return { name: 'panel', label: msg(bolt, 'view.field', 'Field') };
		const kind = resolved?.leaf === 'field' ? resolved.kind.kind : undefined;
		let field: { name: GlyphName; label: string };
		if (kind === 'date')
			field = { name: 'fieldDate', label: msg(bolt, 'view.type.date', 'Date field') };
		else if (kind === 'period')
			field = { name: 'fieldPeriod', label: msg(bolt, 'view.type.period', 'Date range field') };
		else if (kind === 'instant' || kind === 'time')
			field = { name: 'fieldTime', label: msg(bolt, 'view.type.time', 'Time field') };
		else if (kind === 'bool')
			field = { name: 'fieldBool', label: msg(bolt, 'view.type.bool', 'Yes/no field') };
		else if (kind === 'json' || kind === 'object' || kind === 'list' || kind === 'custom')
			field = { name: 'fieldObject', label: msg(bolt, 'view.type.structured', 'Structured field') };
		else if (kind === 'enum' || kind === 'state' || kind === 'currency')
			field = { name: 'fieldChoice', label: msg(bolt, 'view.type.choice', 'Choice field') };
		else if (
			kind !== undefined &&
			['int', 'number', 'decimal', 'money', 'sum', 'count', 'duration'].includes(kind)
		)
			field = { name: 'fieldNumber', label: msg(bolt, 'view.type.number', 'Number field') };
		else field = { name: 'fieldText', label: msg(bolt, 'view.type.text', 'Text field') };
		return nested
			? {
					name: 'fieldInside',
					label: `${msg(bolt, 'view.type.linked', 'Field in a related record')} · ${field.label}`
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
