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
	// an actor id names a member: their name when this caller may read it, else no one (never the id)
	const who = (id: unknown): Promise<string | null> => typeof id !== 'string' ? Promise.resolve(null)
		: Promise.resolve(bolt.get<{ readonly [f: string]: unknown } | null>('sys_user', id)).then((u) => typeof (u?.['name'] ?? u?.['email']) === 'string' ? String(u?.['name'] ?? u?.['email']) : null, () => null);
	// no one known: the line without its "by {who}" (`Created {when}`; `{who} 于 {when} 创建` → `于 {when} 创建`)
	const line = (l: { key: 'createdAt' | 'updatedAt'; at: string | null }, name: string | null) =>
		(name === null ? t(l.key).replace(/\s+\S+\s+\{who\}|\{who\}\s*/, '') : t(l.key).replace('{who}', name)).replace('{when}', l.at!);
	const lines = $derived([
		{ key: 'createdAt' as const, at: when(row['created_at']), by: row['created_by'] },
		...(row['updated_at'] !== undefined && row['updated_at'] !== row['created_at'] ? [{ key: 'updatedAt' as const, at: when(row['updated_at']), by: row['updated_by'] }] : []),
	].filter((l) => l.at !== null));
</script>

{#if lines.length > 0}
	<div class={['text-meta flex flex-col gap-0.5 border-t pt-3', className]} data-record-info>
		{#each lines as l (l.key)}
			<div>
				{#await who(l.by)}{line(l, '…')}{:then name}{line(l, name)}{/await}
			</div>
		{/each}
	</div>
{/if}
