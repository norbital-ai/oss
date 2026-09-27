<!--
@component
A stored row's provenance (staging's record info): who created it and when, and who last changed it and when.
-->
<script lang="ts">
	import { uiText } from '../primitives/utils.js';
	import { useKinds } from '../kinds/context.js';
	import { useBolt } from '../views/bolt.js';

	let { row, class: className }: { row: { readonly [f: string]: unknown }; class?: string } = $props();
	const t = uiText();
	const bolt = useBolt();
	const host = useKinds();
	const when = (v: unknown) => {
		const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
		return d === null || Number.isNaN(d.getTime()) ? null
			: new Intl.DateTimeFormat(host.locale, { dateStyle: 'medium', timeStyle: 'short', ...(host.zone === undefined ? {} : { timeZone: host.zone }) }).format(d);
	};
	// an actor id names a member; their name when this caller may read it, else the id
	const who = (id: unknown) => typeof id !== 'string' ? Promise.resolve('—')
		: Promise.resolve(bolt.get<{ readonly [f: string]: unknown } | null>('sys_user', id)).then((u) => String(u?.['name'] ?? u?.['email'] ?? id), () => id);
	const lines = $derived([
		{ key: 'createdAt' as const, at: when(row['created_at']), by: row['created_by'] },
		...(row['updated_at'] !== undefined && row['updated_at'] !== row['created_at'] ? [{ key: 'updatedAt' as const, at: when(row['updated_at']), by: row['updated_by'] }] : []),
	].filter((l) => l.at !== null));
</script>

{#if lines.length > 0}
	<div class={['text-meta flex flex-col gap-0.5 border-t pt-3', className]} data-record-info>
		{#each lines as l (l.key)}
			<div>
				{#await who(l.by)}{t(l.key).replace('{when}', l.at!).replace('{who}', '…')}{:then name}{t(l.key).replace('{when}', l.at!).replace('{who}', name)}{/await}
			</div>
		{/each}
	</div>
{/if}
