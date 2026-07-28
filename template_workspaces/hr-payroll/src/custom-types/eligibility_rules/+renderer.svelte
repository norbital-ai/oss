<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Stack } from '@norbital-ai/ui/layout';
	import {
		eligibilityRulesSchema,
		type EligibilityRule,
		type EligibilityRules
	} from './+definition.js';
	import type { RendererProps } from './$types.js';

	type Rule = EligibilityRule;
	type RuleField = Rule['field'];
	type EmploymentType = Extract<Rule, { field: 'EMPLOYMENT_TYPE' }>['in'][number];
	type Classification = Extract<Rule, { field: 'WORK_CLASSIFICATION' }>['in'][number];
	type Gender = Extract<Rule, { field: 'GENDER' }>['in'][number];

	const FIELD_OPTIONS: { value: RuleField; label: string }[] = [
		{ value: 'EMPLOYMENT_TYPE', label: 'Employment type' },
		{ value: 'WORK_CLASSIFICATION', label: 'Work classification' },
		{ value: 'SERVICE_MONTHS', label: 'Service months' },
		{ value: 'GENDER', label: 'Gender' },
		{ value: 'DEPARTMENT', label: 'Department' },
		{ value: 'PAYROLL_GROUP', label: 'Payroll group' }
	];
	const EMPLOYMENT_TYPES: EmploymentType[] = [
		'PERMANENT',
		'CONTRACT',
		'PROBATION',
		'INTERN',
		'CONSULTANT'
	];
	const CLASSIFICATIONS: Classification[] = ['EA_COVERED', 'NON_EA', 'MANAGERIAL'];
	const GENDERS: Gender[] = ['MALE', 'FEMALE'];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(eligibilityRulesSchema.safeParse(props.value));
	const rules = $derived<EligibilityRules>(parsed.success ? parsed.data : []);
	const summary = $derived(
		rules.length === 0
			? 'Everyone'
			: rules
					.map((rule) =>
						rule.field === 'SERVICE_MONTHS'
							? `SERVICE_MONTHS ${rule.from}–${rule.to ?? '∞'}`
							: `${rule.field} in [${rule.in.join(', ')}]`
					)
					.join(' AND ')
	);

	function emit(next: EligibilityRules): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultRule(field: RuleField): Rule {
		switch (field) {
			case 'EMPLOYMENT_TYPE':
				return { field: 'EMPLOYMENT_TYPE', in: ['PERMANENT'] };
			case 'WORK_CLASSIFICATION':
				return { field: 'WORK_CLASSIFICATION', in: ['EA_COVERED'] };
			case 'SERVICE_MONTHS':
				return { field: 'SERVICE_MONTHS', from: 0, to: null };
			case 'GENDER':
				return { field: 'GENDER', in: ['FEMALE'] };
			case 'DEPARTMENT':
				return { field: 'DEPARTMENT', in: [] };
			case 'PAYROLL_GROUP':
				return { field: 'PAYROLL_GROUP', in: [] };
		}
	}

	function addRule(field: RuleField | null): void {
		if (field === null) return;
		emit([...rules, defaultRule(field)]);
	}

	function replaceAt(index: number, rule: Rule): void {
		emit(rules.map((entry, position) => (position === index ? rule : entry)));
	}

	function removeAt(index: number): void {
		emit(rules.filter((_, position) => position !== index));
	}

	/** Returns `null` when the toggle would empty the list — every `in` needs ≥ 1 member. */
	function toggled<T extends string>(list: readonly T[], option: T): T[] | null {
		const next = list.includes(option)
			? list.filter((entry) => entry !== option)
			: [...list, option];
		return next.length === 0 ? null : next;
	}

	function splitList(raw: string): string[] {
		return raw
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}

	function nullableNumberFrom(raw: string): number | null {
		if (raw.trim().length === 0) return null;
		const next = Number(raw);
		return Number.isFinite(next) ? next : null;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack class="rounded-md border border-border bg-muted/20 p-3" gap="sm">
		{#if rules.length === 0}
			<p class="text-sm text-muted-foreground">No rules — everyone is eligible.</p>
		{/if}

		{#each rules as rule, index (index)}
			<div class="grid gap-2 rounded-md border border-border bg-background p-2">
				<div class="flex items-center justify-between gap-2">
					<span class="text-sm font-medium">{rule.field.replaceAll('_', ' ').toLowerCase()}</span>
					<Button variant="ghost" size="sm" {disabled} onclick={() => removeAt(index)}>
						Remove
					</Button>
				</div>

				{#if rule.field === 'EMPLOYMENT_TYPE'}
					<div class="flex flex-wrap gap-3">
						{#each EMPLOYMENT_TYPES as option (option)}
							<label class="flex items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									class="size-4"
									checked={rule.in.includes(option)}
									{disabled}
									onchange={() => {
										const next = toggled(rule.in, option);
										if (next !== null) replaceAt(index, { field: 'EMPLOYMENT_TYPE', in: next });
									}}
								/>
								{option}
							</label>
						{/each}
					</div>
				{:else if rule.field === 'WORK_CLASSIFICATION'}
					<div class="flex flex-wrap gap-3">
						{#each CLASSIFICATIONS as option (option)}
							<label class="flex items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									class="size-4"
									checked={rule.in.includes(option)}
									{disabled}
									onchange={() => {
										const next = toggled(rule.in, option);
										if (next !== null) replaceAt(index, { field: 'WORK_CLASSIFICATION', in: next });
									}}
								/>
								{option}
							</label>
						{/each}
					</div>
				{:else if rule.field === 'GENDER'}
					<div class="flex flex-wrap gap-3">
						{#each GENDERS as option (option)}
							<label class="flex items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									class="size-4"
									checked={rule.in.includes(option)}
									{disabled}
									onchange={() => {
										const next = toggled(rule.in, option);
										if (next !== null) replaceAt(index, { field: 'GENDER', in: next });
									}}
								/>
								{option}
							</label>
						{/each}
					</div>
				{:else if rule.field === 'SERVICE_MONTHS'}
					<div class="grid gap-2 sm:grid-cols-2">
						<label class="grid gap-1.5 text-sm font-medium">
							From (months)
							<Input
								type="number"
								min="0"
								step="1"
								value={rule.from}
								{disabled}
								oninput={(event) =>
									replaceAt(index, {
										...rule,
										from: numberFrom(event.currentTarget.value, 0)
									})}
							/>
						</label>
						<label class="grid gap-1.5 text-sm font-medium">
							To (blank = no upper bound)
							<Input
								type="number"
								min="0"
								step="1"
								value={rule.to ?? ''}
								{disabled}
								oninput={(event) =>
									replaceAt(index, {
										...rule,
										to: nullableNumberFrom(event.currentTarget.value)
									})}
							/>
						</label>
					</div>
				{:else if rule.field === 'DEPARTMENT'}
					<label class="grid gap-1.5 text-sm font-medium">
						Departments (comma separated)
						<Input
							value={rule.in.join(', ')}
							{disabled}
							placeholder="Operations, Finance"
							oninput={(event) =>
								replaceAt(index, {
									field: 'DEPARTMENT',
									in: splitList(event.currentTarget.value)
								})}
						/>
					</label>
				{:else if rule.field === 'PAYROLL_GROUP'}
					<label class="grid gap-1.5 text-sm font-medium">
						Payroll groups (comma separated)
						<Input
							value={rule.in.join(', ')}
							{disabled}
							placeholder="MONTHLY, WEEKLY"
							oninput={(event) =>
								replaceAt(index, {
									field: 'PAYROLL_GROUP',
									in: splitList(event.currentTarget.value)
								})}
						/>
					</label>
				{/if}
			</div>
		{/each}

		<Combobox
			options={FIELD_OPTIONS}
			value={null}
			{disabled}
			searchable={false}
			emptyPlaceholder="Add a rule…"
			onValueChange={addRule}
		/>
	</Stack>
{/if}
