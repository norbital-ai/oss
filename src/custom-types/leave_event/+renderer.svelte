<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	/**
	 * The leave event **is** the leave request, so this is the whole request form.
	 *
	 * Every other column on `leave_requests` — `kind`, `from_date`, `to_date`, `days`, the two
	 * half-day flags, `reason`, `certificate_file` — is `generatedAlwaysAs` over this value:
	 * read-only projections the database computes so the row can be indexed, filtered and listed.
	 * Painting them beside this editor showed the operator the same eight facts twice, once as raw
	 * JSON and once as fields that could not be typed into. The request is entered here, once, and
	 * the projections follow from it.
	 *
	 * `certificate_file` is a workspace file id and `source_id` is provenance the migration wrote;
	 * neither is ever shown as a uuid. The certificate is uploaded through the platform's own file
	 * editor, and `source_id` is carried through an edit untouched.
	 */
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { DataRenderer, type CollectionField } from '@norbital-ai/ui/data-renderer';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import { numberFrom } from '../../lib/ui/renderer-input.js';
	import { formatCalendarDate } from '../../lib/ui/display-formatters.js';
	import { leaveEventSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type EventKind = Value['kind'];

	/**
	 * `LEGACY_TAKEN` is deliberately absent: only the migration writes that arm, to preserve an old
	 * ledger row it could not match to a request. An existing one still edits below — it just
	 * cannot be chosen for a new event.
	 */
	const KIND_OPTIONS: { value: EventKind; label: string; description: string }[] = [
		{
			value: 'TIME_OFF',
			label: 'Time off',
			description: 'A dated absence — the ordinary leave request'
		},
		{
			value: 'BALANCE_ADJUSTMENT',
			label: 'Balance adjustment',
			description: 'A signed correction to the balance on one date'
		},
		{
			value: 'ENCASHMENT',
			label: 'Encashment',
			description: 'Days paid out rather than taken'
		}
	];

	const CERTIFICATE_FIELD = {
		name: 'certificate_file',
		kind: 'file',
		nullable: true
	} satisfies CollectionField;

	const HALF_DAY_OPTIONS = [
		{ value: 'false', label: 'Full day' },
		{ value: 'true', label: 'Half day' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(leaveEventSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);

	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.kind === 'TIME_OFF')
			return `${formatCalendarDate(current.from_date)} → ${formatCalendarDate(current.to_date)} · ${current.days}d`;
		return `${current.kind.replaceAll('_', ' ').toLowerCase()} · ${formatCalendarDate(current.effective_on)} · ${current.movement_days}d`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	/** Today, so a new event opens on a real date rather than a blank one that cannot validate. */
	function today(): string {
		return new Date().toISOString().slice(0, 10);
	}

	function defaultFor(kind: EventKind): Value {
		const on = today();
		if (kind === 'TIME_OFF')
			return {
				kind: 'TIME_OFF',
				from_date: on,
				to_date: on,
				days: 1,
				half_day_start: false,
				half_day_end: false,
				reason: null,
				certificate_file: null
			};
		return {
			kind: kind === 'ENCASHMENT' ? 'ENCASHMENT' : 'BALANCE_ADJUSTMENT',
			effective_on: on,
			movement_days: 0,
			note: null,
			source_id: null
		};
	}

	/*
	 * Every variant renderer needs this same guard, and every copy closes over its own file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: EventKind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
	}

	/** A blank text field means "not stated", which is what `null` means in the schema. */
	function textOrNull(raw: string): string | null {
		return raw.trim().length === 0 ? null : raw;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Event
			<Combobox
				ariaLabel="Leave event"
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select what this row records"
				onValueChange={(value) => selectKind(value)}
			/>
		</label>

		{#if current?.kind === 'TIME_OFF'}
			<label class="grid gap-1.5 text-sm font-medium">
				From
				<Input
					type="date"
					value={current.from_date}
					{disabled}
					oninput={(event) => emit({ ...current, from_date: event.currentTarget.value })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				To
				<Input
					type="date"
					value={current.to_date}
					{disabled}
					oninput={(event) => emit({ ...current, to_date: event.currentTarget.value })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Days
				<Input
					type="number"
					min="0.5"
					step="0.5"
					value={current.days}
					{disabled}
					oninput={(event) => emit({ ...current, days: numberFrom(event.currentTarget.value, 1) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				First day
				<Combobox
					ariaLabel="First day"
					options={HALF_DAY_OPTIONS}
					value={current.half_day_start ? 'true' : 'false'}
					{disabled}
					searchable={false}
					emptyPlaceholder="Full day"
					onValueChange={(value) => emit({ ...current, half_day_start: value === 'true' })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Last day
				<Combobox
					ariaLabel="Last day"
					options={HALF_DAY_OPTIONS}
					value={current.half_day_end ? 'true' : 'false'}
					{disabled}
					searchable={false}
					emptyPlaceholder="Full day"
					onValueChange={(value) => emit({ ...current, half_day_end: value === 'true' })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Reason
				<Input
					value={current.reason ?? ''}
					{disabled}
					placeholder={t('component.blank_none_stated')}
					oninput={(event) => emit({ ...current, reason: textOrNull(event.currentTarget.value) })}
				/>
			</label>
			<Stack gap="xs" class="text-sm font-medium">
				<span>{t('component.certificate')}</span>
				<DataRenderer
					field={CERTIFICATE_FIELD}
					value={current.certificate_file}
					mode="edit"
					{disabled}
					onValueChange={(next) =>
						emit({
							...current,
							certificate_file: typeof next === 'string' && next !== '' ? next : null
						})}
				/>
			</Stack>
		{:else if current !== null}
			<label class="grid gap-1.5 text-sm font-medium">
				Effective on
				<Input
					type="date"
					value={current.effective_on}
					{disabled}
					oninput={(event) => emit({ ...current, effective_on: event.currentTarget.value })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Movement (days)
				<Input
					type="number"
					step="0.5"
					value={current.movement_days}
					{disabled}
					oninput={(event) =>
						emit({ ...current, movement_days: numberFrom(event.currentTarget.value, 0) })}
				/>
				<span class="text-xs font-normal text-muted-foreground">
					Signed: negative takes days off the balance, positive adds them.
				</span>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Note
				<Input
					value={current.note ?? ''}
					{disabled}
					placeholder={t('component.blank_none_stated')}
					oninput={(event) => emit({ ...current, note: textOrNull(event.currentTarget.value) })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
