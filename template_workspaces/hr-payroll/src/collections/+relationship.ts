import type { Relationships } from './$types.js';
import { cascade } from '@norbital-ai/pod/authoring';

/**
 * The relation graph. Foreign keys are derived from here, never declared in a `+model.ts`.
 *
 * Variant identifiers remain in their discriminated unions as audit provenance. High-traffic join
 * paths use read-only generated projections so they can be indexed and related without creating a
 * second writable source of truth. The remaining families deliberately have NO relation:
 *   - `leave_types.payroll_effect`     → component_id on the UNPAID arm
 *   - `component_entries.origin`       → reverses_entry_id / evidence_file
 * Referential integrity for those is checked in `+hooks.ts` (validation gate A3), not by the
 * database. See docs/architecture/provenance-and-audit.md.
 */
export default ((r) => ({
	jurisdictions: {
		company_jurisdiction: r.many.companies(),
		contribution_jurisdiction: r.many.statutory_contributions(),
		overtime_rule_jurisdiction: r.many.overtime_rules(),
		overtime_limit_jurisdiction: r.many.overtime_limits(),
		overtime_coverage_rule_jurisdiction: r.many.overtime_coverage_rules(),
		rest_break_rule_jurisdiction: r.many.rest_break_rules()
	},

	statutory_contributions: {
		contribution_jurisdiction: r.one.jurisdictions({
			from: r.statutory_contributions.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		}),
		rate_contribution: r.many.contribution_rates(),
		statutory_fact_contribution: r.many.employment_statutory_facts(),
		payslip_line_statutory_contribution: r.many.payslip_lines()
	},

	contribution_rates: {
		rate_contribution: cascade(
			r.one.statutory_contributions({
				from: r.contribution_rates.statutory_contribution_id,
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

	overtime_coverage_rules: {
		overtime_coverage_rule_jurisdiction: r.one.jurisdictions({
			from: r.overtime_coverage_rules.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		})
	},

	rest_break_rules: {
		rest_break_rule_jurisdiction: r.one.jurisdictions({
			from: r.rest_break_rules.jurisdiction_id,
			to: r.jurisdictions.norbital_id
		})
	},

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
		work_pattern_company: r.many.work_patterns(),
		roster_company: r.many.rosters(),
		payroll_run_company: r.many.payroll_runs()
	},

	pay_components: {
		pay_component_company: r.one.companies({
			from: r.pay_components.company_id,
			to: r.companies.norbital_id
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
		leave_request_type: r.many.leave_requests()
	},

	shift_definitions: {
		shift_definition_company: r.one.companies({
			from: r.shift_definitions.company_id,
			to: r.companies.norbital_id
		}),
		roster_entry_shift: r.many.roster_entries(),
		work_pattern_default_shift: r.many.work_patterns()
	},

	work_patterns: {
		work_pattern_company: r.one.companies({
			from: r.work_patterns.company_id,
			to: r.companies.norbital_id
		}),
		work_pattern_default_shift: r.one.shift_definitions({
			from: r.work_patterns.default_shift_definition_id,
			to: r.shift_definitions.norbital_id
		}),
		term_work_pattern: r.many.employment_terms(),
		roster_work_pattern: r.many.rosters()
	},

	rosters: {
		roster_company: r.one.companies({
			from: r.rosters.company_id,
			to: r.companies.norbital_id
		}),
		roster_work_pattern: r.one.work_patterns({
			from: r.rosters.work_pattern_id,
			to: r.work_patterns.norbital_id
		}),
		roster_entry_roster: r.many.roster_entries()
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
		),
		term_work_pattern: r.one.work_patterns({
			from: r.employment_terms.work_pattern_id,
			to: r.work_patterns.norbital_id
		})
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
		}),
		agreement_instalments: r.one.repayment_agreements({
			from: r.component_entries.repayment_agreement_id,
			to: r.repayment_agreements.norbital_id
		}),
		entry_payslip_lines: r.many.payslip_lines()
	},

	repayment_agreements: {
		agreement_employment: r.one.employments({
			from: r.repayment_agreements.employment_id,
			to: r.employments.norbital_id
		}),
		agreement_pay_component: r.one.pay_components({
			from: r.repayment_agreements.pay_component_id,
			to: r.pay_components.norbital_id
		}),
		agreement_instalments: r.many.component_entries()
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

	roster_entries: {
		roster_entry_employment: r.one.employments({
			from: r.roster_entries.employment_id,
			to: r.employments.norbital_id
		}),
		roster_entry_shift: r.one.shift_definitions({
			from: r.roster_entries.shift_definition_id,
			to: r.shift_definitions.norbital_id
		}),
		roster_entry_roster: cascade(
			r.one.rosters({
				from: r.roster_entries.roster_id,
				to: r.rosters.norbital_id
			})
		)
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
		payslip_line_payslip: r.many.payslip_lines()
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
		entry_payslip_lines: r.one.component_entries({
			from: r.payslip_lines.component_entry_id,
			to: r.component_entries.norbital_id
		}),
		payslip_line_statutory_contribution: r.one.statutory_contributions({
			from: r.payslip_lines.statutory_contribution_id,
			to: r.statutory_contributions.norbital_id
		})
	}
})) satisfies Relationships;
