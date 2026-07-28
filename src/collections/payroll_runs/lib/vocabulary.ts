/**
 * What a payroll workbook calls each statutory scheme.
 *
 * A statutory column is produced by a contribution, and the contribution already knows everything
 * true about itself: its `code`, who pays it, the wage it was charged on, what it took from the
 * employee and what it cost the employer. The one thing it cannot know is what the customer's
 * spreadsheet writes at the top of the column — `epfEmployee` in Kuala Lumpur, `sssEmployee` in
 * Manila, `withholdingTax` where Malaysia writes `pcb`. That is a fact about a workbook, not about
 * a scheme, so it is not on the model; it is here, in the export path, as data.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY PLACE A JURISDICTION IS NAMED.
 *
 * `report.ts` walks the contributions a run actually charged and asks this table what to call each
 * one. It contains no scheme code, no country and no statutory concept of its own, so adding a
 * jurisdiction is an addition *here* and nowhere else. Correspondingly, a code this table does not
 * know is an error and not a silence: `statutoryNaming` throws. A scheme whose column quietly
 * failed to appear reads, to every downstream reconciliation, as the number zero — and zero is a
 * claim about the law, not about the report.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The codes below are `statutory_contributions.code` as seeded (see the statutory rows seed). The
 * order of this array is the order the statutory columns appear in the workbook; within a
 * jurisdiction it follows the scheme's own `sequence`, which is the order the schemes are charged
 * in and therefore the order a payroll clerk reads them.
 */

/** The four numbers a scheme produces, each of which a workbook may or may not give a column. */
export type StatutoryRole = 'employee' | 'employer' | 'total' | 'base';

export type StatutoryNaming = {
	/** `statutory_contributions.code`. */
	readonly code: string;
	/** Column for what the employee was charged. Omitted when the scheme has no employee side. */
	readonly employee?: string;
	/** Column for what the employer was charged. Omitted when the scheme has no employer side. */
	readonly employer?: string;
	/** Column for the two shares added together, where the workbook carries one. */
	readonly total?: string;
	/** Column for the wage the scheme was charged on, where the workbook carries one. */
	readonly base?: string;
};

/**
 * Two codes may share a column. Malaysia charges retirement under two schemes — the citizen ladder
 * and the non-citizen Part C flat rate — and an employment is enrolled in exactly one of them; the
 * workbook has one EPF column, so both schemes name it and the column reports whichever charged.
 * The column means "EPF", not "the contribution whose code happens to be EPF".
 */
export const STATUTORY_VOCABULARY: readonly StatutoryNaming[] = [
	// ── Malaysia ──────────────────────────────────────────────────────────────────────────────────
	{
		code: 'EPF',
		employee: 'epfEmployee',
		employer: 'epfEmployer',
		total: 'totalEpf',
		base: 'epfGross'
	},
	{
		code: 'EPF_NON_CITIZEN',
		employee: 'epfEmployee',
		employer: 'epfEmployer',
		total: 'totalEpf',
		base: 'epfGross'
	},
	{
		code: 'SOCSO',
		employee: 'socsoEmployee',
		employer: 'socsoEmployer',
		total: 'totalSocso',
		base: 'socsoGross'
	},
	// The PERKESO 24-hour add-on is additive to the tabled SOCSO amount and is charged as its own
	// scheme, so it gets its own column rather than being folded into SOCSO's.
	{ code: 'LINDUNG_24_JAM', employee: 'lindung24Jam' },
	{ code: 'EIS', employee: 'eisEmployee', employer: 'eisEmployer', total: 'totalEis' },
	// The Malaysian workbook writes the monthly tax deduction under its statutory name, not under a
	// generic one — which is exactly why the tax column cannot be hardcoded across jurisdictions.
	{ code: 'PCB', employee: 'pcb', base: 'pcbGross' },
	{ code: 'HRDF', employer: 'hrdf' },
	// Charged on the employee and rebated against PCB. No Malaysian employment in the seeded
	// population claims it, so the column exists here rather than as a hardcoded zero elsewhere.
	{ code: 'ZAKAT', employee: 'zakat' },

	// ── Philippines ───────────────────────────────────────────────────────────────────────────────
	{ code: 'SSS', employee: 'sssEmployee', employer: 'sssEmployer' },
	// Employees' Compensation is levied on the employer alongside SSS and the workbook keeps it in
	// its own column, so it is named as an employer share and has no employee side at all.
	{ code: 'SSS_EC', employer: 'sssEmployerCompensation' },
	{ code: 'PHIC', employee: 'philhealthEmployee', employer: 'philhealthEmployer' },
	{ code: 'HDMF', employee: 'pagibigEmployee', employer: 'pagibigEmployer' },
	{ code: 'WTAX', employee: 'withholdingTax' },

	// ── Singapore ─────────────────────────────────────────────────────────────────────────────────
	{ code: 'CPF', employee: 'cpfEmployee', employer: 'cpfEmployer', total: 'totalCpf' },
	{ code: 'SDL', employer: 'sdl' },

	// ── Vietnam ───────────────────────────────────────────────────────────────────────────────────
	{ code: 'SI', employee: 'siEmployee', employer: 'siEmployer' },
	{ code: 'HI', employee: 'hiEmployee', employer: 'hiEmployer' },
	{ code: 'UI', employee: 'uiEmployee', employer: 'uiEmployer' },
	{ code: 'UNION_FEE', employer: 'unionFee' },
	// Vietnam excludes the overtime premium from the tax base, so the base column is the one a
	// reviewer checks first; it is named for the scheme that charged it, not for Malaysia's.
	{ code: 'PIT', employee: 'pit', base: 'pitGross' },

	// ── Taiwan ────────────────────────────────────────────────────────────────────────────────────
	{ code: 'LI', employee: 'liEmployee', employer: 'liEmployer' },
	{ code: 'NHI', employee: 'nhiEmployee', employer: 'nhiEmployer' },
	{ code: 'LABOR_PENSION', employer: 'laborPension' },
	{ code: 'INCOME_TAX', employee: 'incomeTax' }
];

const NAMING_BY_CODE: ReadonlyMap<string, StatutoryNaming> = new Map(
	STATUTORY_VOCABULARY.map((naming) => [naming.code, naming])
);

/**
 * What the workbook calls this scheme.
 *
 * Throws on a code the vocabulary does not know. A run that charges a scheme this file has never
 * heard of has produced a number nobody can name, and exporting the workbook without it would put
 * that number's absence and the number zero in the same cell.
 */
export function statutoryNaming(code: string): StatutoryNaming {
	const naming = NAMING_BY_CODE.get(code);
	if (naming) return naming;
	throw new Error(
		`Statutory contribution ${JSON.stringify(code)} has no workbook column. Name its employee ` +
			`and employer shares in STATUTORY_VOCABULARY (lib/vocabulary.ts) before exporting a run ` +
			`that charges it.`
	);
}

/**
 * Every column the vocabulary can produce for the given roles, in workbook order.
 *
 * Role-major: all the employee columns, then all the employer columns — which is how the customer's
 * workbook lays the statutory block out, and how a payroll clerk reconciles it (down the employee
 * side against the payslip, then down the employer side against the remittance).
 */
export function statutoryOutputIds(roles: readonly StatutoryRole[]): string[] {
	const ids: string[] = [];
	for (const role of roles)
		for (const naming of STATUTORY_VOCABULARY) {
			const id = naming[role];
			if (id != null && !ids.includes(id)) ids.push(id);
		}
	return ids;
}
