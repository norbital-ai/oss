<script lang="ts">
	import { Effect, Schema } from 'effect';
	import type { CollectionField, CollectionRecordHistoryEntry } from '@norbital-ai/std/collection';
	import Icon from '@iconify/svelte';
	import { formatDataValue, formatStructuredValue, type Translate } from '#lib/data-renderer';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Label } from '#lib/label';
	import { Inline, Scroll } from '#lib/layout';
	import { Tooltip } from '#lib/tooltip';
	import { formatUtcInstantLocal } from '#lib/utils';
	import { isEqual } from 'es-toolkit/predicate';

	/** One revision of a single field, as the history tooltip renders it. */
	const collectionFieldHistoryEntrySchema = Schema.Struct({
		value: Schema.Unknown,
		validFrom: Schema.String,
		validTo: Schema.NullOr(Schema.String),
		version: Schema.Number
	});
	type CollectionFieldHistoryEntry = typeof collectionFieldHistoryEntrySchema.Type;

	function collectionFieldHistory(
		history: readonly CollectionRecordHistoryEntry[],
		fieldName: string
	): readonly CollectionFieldHistoryEntry[] {
		const changes: CollectionFieldHistoryEntry[] = [];
		for (const snapshot of [...history].sort((left, right) => left.version - right.version)) {
			const value = snapshot.values[fieldName];
			const previous = changes.at(-1);
			if (!previous || !isEqual(previous.value, value)) {
				changes.push({
					value,
					validFrom: snapshot.validFrom,
					validTo: snapshot.validTo,
					version: snapshot.version
				});
				continue;
			}
			changes[changes.length - 1] = { ...previous, validTo: snapshot.validTo };
		}
		return changes.reverse();
	}

	interface Props {
		field: CollectionField;
		fieldId: string;
		label: string;
		value: unknown;
		dirty: boolean;
		available: boolean;
		history: readonly CollectionRecordHistoryEntry[];
		loading: boolean;
		error: Error | undefined;
		load: () => void;
		locale?: string;
	}

	let {
		field,
		fieldId,
		label,
		value,
		dirty,
		available,
		history,
		loading,
		error,
		load,
		locale
	}: Props = $props();

	const { t } = useI18n<UiKeys>();
	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);

	const fieldHistory = $derived(collectionFieldHistory(history, field.name));

	/**
	 * Day-month-year, matching the convention the templates use (`05 Aug 2026, 14:32`).
	 * `formatUtcInstantLocal` resolves the stored UTC instant in the viewer's timezone; it
	 * throws on anything that is not a UTC ISO instant, so never feed it a calendar day.
	 */
	function formatRevisionInstant(instant: string): string {
		return Effect.runSync(
			Effect.try(() =>
				formatUtcInstantLocal(instant, {
					locale: localeEffective,
					day: '2-digit',
					month: 'short',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit'
				})
			).pipe(
				Effect.match({
					onFailure: () => instant,
					onSuccess: (formatted) => formatted
				})
			)
		);
	}

	/** One revision reads as one line, so structured values collapse to a single-line summary. */
	function revisionText(entryValue: unknown): string {
		return entryValue != null && typeof entryValue === 'object'
			? formatStructuredValue(entryValue)
			: formatDataValue(field, entryValue, localeEffective, t as Translate);
	}
</script>

{#if available}
	<Inline gap="xs" class="min-w-0">
		<Label for={fieldId} class="text-sm leading-none font-medium">{label}</Label>
		<Tooltip
			delayDuration={200}
			side="bottom"
			align="start"
			sideOffset={6}
			contentClass="flex max-h-80 w-72 max-w-[calc(100vw-2rem)] flex-col rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-md"
			arrowClasses="text-popover"
			onOpenChange={(open) => {
				if (open) load();
			}}
		>
			{#snippet trigger({ props })}
				<button
					{...props}
					type="button"
					aria-label={t('form.fieldHistoryLabel', { label })}
					class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Icon icon="lucide:history" class="size-3" aria-hidden="true" />
				</button>
			{/snippet}
			{#snippet content()}
				<p class="shrink-0 px-2.5 pt-2 pb-1.5 text-left text-xs font-semibold text-foreground">
					{t('form.historyTitle', { label })}
				</p>
				{#if dirty}
					<Inline
						align="baseline"
						justify="between"
						gap="sm"
						class="shrink-0 bg-brand/5 px-2.5 py-1 text-left"
					>
						<span class="min-w-0 truncate text-xs text-foreground" title={revisionText(value)}>
							{revisionText(value)}
						</span>
						<span class="shrink-0 text-tiny text-brand">{t('form.unsaved')}</span>
					</Inline>
				{/if}
				<Scroll
					axis="y"
					name={t('form.fieldHistoryRegion')}
					grow
					class="px-2.5 pt-0.5 pb-2 text-left"
				>
					{#if loading}
						<Inline gap="xs" class="py-1 text-meta" role="status">
							<Icon icon="lucide:loader-circle" class="size-3 animate-spin" />
							{t('common.loading')}
						</Inline>
					{:else if error}
						<p class="py-1 text-xs text-destructive" role="alert">
							{t('form.historyLoadFailed')}
						</p>
					{:else if fieldHistory.length === 0}
						<p class="py-1 text-meta">{t('form.noSavedChanges')}</p>
					{:else}
						<ol aria-label={t('form.savedHistoryLabel', { label })}>
							{#each fieldHistory as entry, index (`${entry.version}:${entry.validFrom}`)}
								{@const text = revisionText(entry.value)}
								<li class="flex items-baseline justify-between gap-2 py-1">
									<span
										class="min-w-0 flex-1 truncate text-xs text-foreground"
										class:font-medium={index === 0}
										title={text}
									>
										{text}
									</span>
									<time
										class="shrink-0 text-tiny tabular-nums text-muted-foreground"
										datetime={entry.validFrom}
									>
										{formatRevisionInstant(entry.validFrom)}
									</time>
								</li>
							{/each}
						</ol>
					{/if}
				</Scroll>
			{/snippet}
		</Tooltip>
	</Inline>
{:else}
	<Label for={fieldId}>{label}</Label>
{/if}
