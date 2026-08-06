<script lang="ts" module>
	/**
	 * The three arms `component_definition.cap.matrix.layers[]` and `leave_entitlement.layers[]`
	 * both declare, and the picker for the one id either of them can name.
	 *
	 * The arms are identical between the two shapes — same three literals, same `employment_id` on
	 * the EMPLOYEE arm and on no other — and the scoping rule ("the people of the company this
	 * matrix belongs to, read as name · number") is a correctness rule rather than presentation.
	 * Duplicating it would give the two matrices two chances to drift apart on who may be named.
	 */
	export type PolicyLayerLevel = 'STATUTORY' | 'ORGANISATION' | 'EMPLOYEE';

	export interface LayerLevelPickerProps {
		readonly level: PolicyLayerLevel;
		/** The employment the EMPLOYEE arm names; `null` on the two arms that name nobody. */
		readonly employmentId: string | null;
		/** The company whose people the EMPLOYEE arm may name. */
		readonly companyId: string | null;
		readonly disabled: boolean;
		/** Called with the chosen arm. The caller rebuilds the row, because only it knows the rest. */
		onLevelChange(level: PolicyLayerLevel): void;
		onEmploymentChange(employment: string): void;
	}
</script>

<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid } from '@norbital-ai/ui/layout';

	let props: LayerLevelPickerProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const LEVEL_OPTIONS = $derived([
		{
			value: 'STATUTORY',
			label: t('component.level_statutory'),
			description: t('component.level_statutory_description')
		},
		{
			value: 'ORGANISATION',
			label: t('component.level_organisation'),
			description: t('component.level_organisation_description')
		},
		{
			value: 'EMPLOYEE',
			label: t('component.level_employee'),
			description: t('component.level_employee_description')
		}
	]);

	/*
	 * The EMPLOYEE arm's id is a foreign key no constraint can declare — a layer is one JSONB value
	 * — so the option set is built here, scoped to the company the matrix belongs to. One query
	 * serves every row of the editor and the person's name travels with the row, rather than a
	 * lookup per option (controller-surfaces.md §5). This is an edit surface only: nothing here
	 * mounts in display mode, where a per-row lookup would be the N+1 §5 forbids.
	 */
	/**
	 * The joined shape the option set reads. The typed client models a row without its `with`
	 * payload, so the person's name is declared here and the query result is read through it — the
	 * same boundary `payslips/payslip-representation.svelte` draws for its summary read.
	 */
	type EmploymentWithName = {
		readonly norbital_id: string;
		readonly employee_number: string;
		readonly employment_employee?: { readonly name?: string | null } | null;
	};

	const employmentsQuery = $derived(
		props.companyId == null
			? null
			: client.db.employments.findMany({
					where: { company_id: { eq: props.companyId } },
					with: { employment_employee: { columns: { name: true } } },
					orderBy: { employee_number: 'asc' },
					limit: 1000
				})
	);
	const employments = $derived((employmentsQuery?.current ?? []) as readonly EmploymentWithName[]);
	const employmentOptions = $derived(
		employments.map((employment) => {
			const name = employment.employment_employee?.name ?? '';
			const number = employment.employee_number;
			return {
				value: employment.norbital_id,
				label: [name, number].filter((part) => part !== '').join(' · ') || '—',
				search_term: `${name} ${number}`
			};
		})
	);
</script>

<Grid gap="sm" minimum="compact">
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.level')}
		<Combobox
			options={LEVEL_OPTIONS}
			value={props.level}
			disabled={props.disabled}
			searchable={false}
			emptyPlaceholder={t('component.select_a_level')}
			onValueChange={(level) => {
				if (level === 'STATUTORY' || level === 'ORGANISATION' || level === 'EMPLOYEE') {
					props.onLevelChange(level);
				}
			}}
		/>
	</label>
	{#if props.level === 'EMPLOYEE'}
		<label class="grid gap-1.5 text-sm font-medium">
			{t('component.person')}
			<Combobox
				ariaLabel={t('component.employment')}
				options={employmentOptions}
				value={props.employmentId === '' ? null : props.employmentId}
				disabled={props.disabled || props.companyId == null}
				searchPlaceholder={t('component.search_company_people')}
				emptyPlaceholder={t('component.choose_arrangement')}
				clientConfig={{
					isLoading: employmentsQuery?.loading ?? false,
					error: employmentsQuery?.error?.message ?? null
				}}
				onValueChange={(value) => props.onEmploymentChange(typeof value === 'string' ? value : '')}
			/>
		</label>
	{/if}
</Grid>
