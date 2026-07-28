import type { Relationships } from './$types.js';
import { cascade } from '@norbital-ai/pod/authoring';

/**
 * The relation graph. Foreign keys are derived from here, never declared in a `+model.ts`.
 *
 * Five families of reference deliberately have NO relation, because the identifier lives inside a
 * discriminated union and a variant cannot be a foreign key:
 *   - `accrual_bands.owner`            → jurisdiction_id | company_id
 *   - `leave_types.payroll_effect`     → component_id on the UNPAID arm
 *   - `component_entries.origin`       → agreement_id / reverses_entry_id / evidence_file
 *   - `leave_ledger.source_id`         → a leave request, or an encashment
 *   - `payslip_line_sources.source`    → entry_id | time_entry_id | leave_request_id
 * Referential integrity for those is checked in `+hooks.ts` (validation gate A3), not by the
 * database. See plan/12-validation.md A3.
 */
export default ((r) => ({
	jurisdictions: {
		company_jurisdiction: r.many.companies(),
		contribution_jurisdiction: r.many.statutory_contributions(),
		overtime_rule_jurisdiction: r.many.overtime_rules(),
		overtime_limit_jurisdiction: r.many.overtime_limits()
	},

	statutory_contributions: {
		contribution_jurisdiction: r.one.jurisdictions({
			from: r.statutory_contributions.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		}),
		rate_contribution: r.many.contribution_rates(),
		treatment_contribution: r.many.contribution_treatments(),
		statutory_fact_contribution: r.many.employment_statutory_facts(),
		payslip_contribution_contribution: r.many.payslip_contributions()
	},

	contribution_rates: {
		rate_contribution: cascade(
			r.one.statutory_contributions({
				from: r.contribution_rates.statutory_contribution_id,
				to: r.statutory_contributions.norbital_id
			})
		)
	},

	component_types: {
		treatment_component_type: r.many.contribution_treatments(),
		pay_component_type: r.many.pay_components(),
		payslip_line_component_type: r.many.payslip_lines()
	},

	contribution_treatments: {
		treatment_component_type: cascade(
			r.one.component_types({
				from: r.contribution_treatments.component_type_id,
				to: r.component_types.norbital_id
			})
		),
		treatment_contribution: cascade(
			r.one.statutory_contributions({
				from: r.contribution_treatments.statutory_contribution_id,
				to: r.statutory_contributions.norbital_id
			})
		)
	},

	overtime_rules: {
		overtime_rule_jurisdiction: r.one.jurisdictions({
			from: r.overtime_rules.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		})
	},

	overtime_limits: {
		overtime_limit_jurisdiction: r.one.jurisdictions({
			from: r.overtime_limits.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		})
	},

	accrual_bands: {},

	companies: {
		company_jurisdiction: r.one.jurisdictions({
			from: r.companies.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		}),
		employment_company: r.many.employments(),
		pay_component_company: r.many.pay_components(),
		leave_type_company: r.many.leave_types(),
		shift_definition_company: r.many.shift_definitions(),
		company_holiday_company: r.many.company_holidays(),
		payroll_run_company: r.many.payroll_runs()
	},

	pay_components: {
		pay_component_company: r.one.companies({
			from: r.pay_components.company_id,
			to: r.companies.norbital_id
		}),
		pay_component_type: r.one.component_types({
			from: r.pay_components.component_type_id,
			to: r.component_types.norbital_id
		}),
		entry_pay_component: r.many.component_entries(),
		agreement_pay_component: r.many.repayment_agreements(),
		payslip_line_pay_component: r.many.payslip_lines()
	},

	leave_types: {
		leave_type_company: r.one.companies({
			from: r.leave_types.company_id,
			to: r.companies.norbital_id
		}),
		leave_request_type: r.many.leave_requests(),
		ledger_leave_type: r.many.leave_ledger()
	},

	shift_definitions: {
		shift_definition_company: r.one.companies({
			from: r.shift_definitions.company_id,
			to: r.companies.norbital_id
		}),
		roster_entry_shift: r.many.roster_entries()
	},

	company_holidays: {
		company_holiday_company: cascade(
			r.one.companies({
				from: r.company_holidays.company_id,
				to: r.companies.norbital_id
			})
		)
	},

	employees: {
		employment_employee: r.many.employments()
	},

	employments: {
		employment_employee: r.one.employees({
			from: r.employments.employee_id,
			to: r.employees.norbital_id
		}),
		employment_company: r.one.companies({
			from: r.employments.company_id,
			to: r.companies.norbital_id
		}),
		term_employment: r.many.employment_terms(),
		statutory_fact_employment: r.many.employment_statutory_facts(),
		entry_employment: r.many.component_entries(),
		agreement_employment: r.many.repayment_agreements(),
		leave_request_employment: r.many.leave_requests(),
		ledger_employment: r.many.leave_ledger(),
		roster_entry_employment: r.many.roster_entries(),
		time_entry_employment: r.many.time_entries(),
		payslip_employment: r.many.payslips()
	},

	employment_terms: {
		term_employment: cascade(
			r.one.employments({
				from: r.employment_terms.employment_id,
				to: r.employments.norbital_id
			})
		)
	},

	employment_statutory_facts: {
		statutory_fact_employment: cascade(
			r.one.employments({
				from: r.employment_statutory_facts.employment_id,
				to: r.employments.norbital_id
			})
		),
		statutory_fact_contribution: r.one.statutory_contributions({
			from: r.employment_statutory_facts.statutory_contribution_id,
			to: r.statutory_contributions.norbital_id
		})
	},

	component_entries: {
		entry_employment: r.one.employments({
			from: r.component_entries.employment_id,
			to: r.employments.norbital_id
		}),
		entry_pay_component: r.one.pay_components({
			from: r.component_entries.pay_component_id,
			to: r.pay_components.norbital_id
		})
	},

	repayment_agreements: {
		agreement_employment: r.one.employments({
			from: r.repayment_agreements.employment_id,
			to: r.employments.norbital_id
		}),
		agreement_pay_component: r.one.pay_components({
			from: r.repayment_agreements.pay_component_id,
			to: r.pay_components.norbital_id
		})
	},

	leave_requests: {
		leave_request_employment: r.one.employments({
			from: r.leave_requests.employment_id,
			to: r.employments.norbital_id
		}),
		leave_request_type: r.one.leave_types({
			from: r.leave_requests.leave_type_id,
			to: r.leave_types.norbital_id
		})
	},

	leave_ledger: {
		ledger_employment: cascade(
			r.one.employments({
				from: r.leave_ledger.employment_id,
				to: r.employments.norbital_id
			})
		),
		ledger_leave_type: r.one.leave_types({
			from: r.leave_ledger.leave_type_id,
			to: r.leave_types.norbital_id
		})
	},

	roster_entries: {
		roster_entry_employment: r.one.employments({
			from: r.roster_entries.employment_id,
			to: r.employments.norbital_id
		}),
		roster_entry_shift: r.one.shift_definitions({
			from: r.roster_entries.shift_definition_id,
			to: r.shift_definitions.norbital_id
		})
	},

	time_entries: {
		time_entry_employment: r.one.employments({
			from: r.time_entries.employment_id,
			to: r.employments.norbital_id
		})
	},

	payroll_runs: {
		payroll_run_company: r.one.companies({
			from: r.payroll_runs.company_id,
			to: r.companies.norbital_id
		}),
		payslip_payroll_run: r.many.payslips()
	},

	payslips: {
		payslip_payroll_run: cascade(
			r.one.payroll_runs({
				from: r.payslips.payroll_run_id,
				to: r.payroll_runs.norbital_id
			})
		),
		payslip_employment: r.one.employments({
			from: r.payslips.employment_id,
			to: r.employments.norbital_id
		}),
		payslip_line_payslip: r.many.payslip_lines(),
		payslip_contribution_payslip: r.many.payslip_contributions()
	},

	payslip_lines: {
		payslip_line_payslip: cascade(
			r.one.payslips({
				from: r.payslip_lines.payslip_id,
				to: r.payslips.norbital_id
			})
		),
		payslip_line_pay_component: r.one.pay_components({
			from: r.payslip_lines.pay_component_id,
			to: r.pay_components.norbital_id
		}),
		payslip_line_component_type: r.one.component_types({
			from: r.payslip_lines.component_type_id,
			to: r.component_types.norbital_id
		}),
		payslip_line_source_line: r.many.payslip_line_sources()
	},

	payslip_line_sources: {
		payslip_line_source_line: cascade(
			r.one.payslip_lines({
				from: r.payslip_line_sources.payslip_line_id,
				to: r.payslip_lines.norbital_id
			})
		)
	},

	payslip_contributions: {
		payslip_contribution_payslip: cascade(
			r.one.payslips({
				from: r.payslip_contributions.payslip_id,
				to: r.payslips.norbital_id
			})
		),
		payslip_contribution_contribution: r.one.statutory_contributions({
			from: r.payslip_contributions.statutory_contribution_id,
			to: r.statutory_contributions.norbital_id
		})
	}
})) satisfies Relationships;
