# Malaysia Payroll Calculation

Current Norbital specification for Malaysian payroll. This document describes the calculation that
the engine performs now; it does not preserve superseded rules or earlier variance explanations.

## 1. Governing records

| Fact                                                                      | Current collection / field                 |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| Monthly salary, weekly hours, working days and contractual OT eligibility | `employment_terms`                         |
| First Schedule OT-pay category                                            | `employment_terms.statutory_work_category` |
| Company OT calculation method and payroll cutoff                          | `companies`                                |
| Dynamic work/rest/off assignment                                          | `roster_entries.designation`               |
| Fixed-week fallback rest day                                              | `employment_terms.rest_day`                |
| Shift times and unpaid breaks                                             | `shift_definitions`                        |
| Actual clocks and authorised OT buckets                                   | `time_entries`                             |
| Public and substitute holidays                                            | `company_holidays`                         |
| Statutory rate ladders and limits                                         | `overtime_rules`, `overtime_limits`        |
| Approved leave and payroll effect                                         | `leave_requests`, `leave_types`            |
| Earnings, reimbursements, recoveries and corrections                      | `component_entries`, `pay_components`      |

Terms are effective-dated. A change in salary, working pattern or statutory work category is stored
as a successor term rather than overwriting the earlier period.

## 2. Schedule, rest days and public holidays

### Rostered shift workers

The roster is authoritative for each date:

- `WORK` → ordinary working day;
- `REST` → statutory rest day;
- `OFF` → non-working off day.

A shift worker's rest day may therefore move to any weekday. The engine does not assume that Sunday
is always the rest day for a rostered employee.

### Fixed-week workers

When no roster row exists:

- a five-day worker with Sunday rest works Monday–Friday, has Saturday `OFF_DAY`, and Sunday
  `REST_DAY`;
- a six-day worker with Sunday rest works Monday–Saturday and has Sunday `REST_DAY`.

Off-day work uses the ordinary-day OT rule. Rest-day work uses the statutory rest-day ladder.

### Public holiday on a rest day

Under Employment Act 1955 section 60D(1), when a paid public holiday falls on the employee's rest
day, the immediately following working day is the substituted paid holiday.

Norbital resolves this per employee:

1. the original date remains `REST_DAY`;
2. the next rostered or fixed ordinary working day becomes `PUBLIC_HOLIDAY`;
3. work on that substitute date is priced by the public-holiday ladder.

If the company has declared a specific substitute, its `company_holidays` row stores the original
date in `substitutes_date`. That suppresses a duplicate automatic substitute. This is a substituted
paid holiday in the schedule; the engine does not invent a leave-balance credit.

## 3. Overtime hours

An entry is payable only when its attendance/OT record is authorised. Clock noise remains excluded
until approval.

Daily derivation:

```text
clocked work = clock-out − clock-in − unpaid break
raw OT       = approved OT punch/bucket, or authorised work beyond the scheduled boundary
payable OT   = floor(raw OT to 0.5-hour increments)
```

Examples:

```text
1.99 hours → 1.5 payable hours
2.00 hours → 2.0 payable hours
2.49 hours → 2.0 payable hours
2.50 hours → 2.5 payable hours
```

The floor is applied to each dated OT result. Rounded-up or fractional incentive hours are never
created.

## 4. Overtime rate and rounding

Nihon uses the Infotech annualised method configured on the company:

```text
HRP              = round(monthly salary × 12 / (weekly hours × 52), 2)
dated unit rate  = round(HRP × statutory multiplier, 2)
dated OT amount  = round(payable hours on date × dated unit rate, 2)
payroll OT       = sum of dated OT amounts in the settlement window
```

The Malaysian statutory hourly-rate result remains the minimum floor where the Employment Act
requires a higher amount:

```text
statutory HRP floor = round((monthly salary / 26) / ordinary daily hours, 2)
effective OT HRP    = max(annualised HRP, statutory HRP floor)
```

The multiplier and award shape come from the effective `overtime_rules` row:

- ordinary/off day: ordinary OT ladder;
- rest day: half-day/full-day entitlement within normal hours, then the rest-day excess rate;
- paid public holiday or substitute holiday: public-holiday entitlement and excess rate.

The source workbook's `1.5`, `2.0` or `3.0` display bucket does not override the legal day type.

## 5. Independent statutory controls

### Twelve actual work hours in a day

Employment Act 1955 section 60A(7) generally prohibits requiring an employee to work more than 12
hours in one day, subject to the Act's exceptions.

Norbital does not discard the corresponding pay. After the statutory rate ladder prices the whole
day:

```text
daily excess = floor(max(0, actual work hours − 12), 0.5 hour)
retained OT  = payable OT − daily excess
```

The value of the excess moves to the derived statutory-excess component at the same legal rate. A
payroll warning identifies the employee, date and actual work hours. Reclassification pays the
work; it does not cure an hours-of-work breach.

Example:

```text
normal hours       = 8.5
actual work        = 13.0
payable OT         = 4.5
retained OT        = 3.5
statutory excess   = 1.0
```

An 11-hour rest-day shift is below 12 actual hours. Its full statutory rest-day award remains OT;
none is moved merely because more than four hours were worked.

### 104 hours in a calendar month

Employment (Limitation of Overtime Work) Regulations 1980 regulation 2 limits overtime work to 104
hours in any one calendar month.

The counter:

- resets on the first day of each calendar month;
- includes ordinary-day OT and `OFF_DAY` OT priced under the ordinary rule;
- excludes work on a rest day and work on a paid public holiday;
- counts the whole qualifying OT quantity even when daily excess is separately reclassified.

The engine reads the full calendar months touched by a payroll cutoff, classifies dated OT in
chronological order, and moves only the portion above 104 hours to the derived statutory-excess
component. Warnings identify the actual calendar month. This monthly control is independent of the
12-hour daily control.

The 21st–20th attendance window never resets or substitutes for the calendar-month counter.
It only decides which dated work is paid in the run. The 104-hour test is a forward-running
threshold, so later work cannot retroactively turn an earlier hour into excess; a blanket
one-month payment lag is neither required nor present.

### PINCEN is an expected output

Nihon's source `PINCEN` amount is never seeded. The run derives statutory excess from time entries
and the 12-hour/104-hour controls, exports the result as incentive OT, and only then compares it with
the source `PINCEN` value. A difference is a calculation or source-policy variance to investigate;
copying the expected amount into an `ENTRY` would invalidate the reconciliation.

## 6. Settlement windows

For monthly Nihon payroll:

| Item                              | Settlement window                                 |
| --------------------------------- | ------------------------------------------------- |
| Salary and fixed monthly items    | first through last day of payroll month           |
| Attendance-derived OT             | 21st of prior month through 20th of payroll month |
| Ordinary unpaid-leave deduction   | 21st of prior month through 20th of payroll month |
| Statutory OT-limit classification | full calendar month containing each work date     |

Example for January payroll:

```text
payment dates                 = 21 Dec–20 Jan
December statutory counter    = 1–31 Dec
January statutory counter     = 1–31 Jan
```

January 21–31 OT is paid in February, but it still belongs to January's 104-hour counter.

## 7. Statutory OT-pay coverage

`work_classification = NON_EA` is a legacy company label. It does not mean that the Employment Act
does not apply.

For the overtime, rest-day and paid-holiday pay provisions identified in the First Schedule:

- a Malaysian employee earning RM4,000 or less per month is covered;
- above RM4,000, covered categories include manual labour, manual-labour supervision, commercial
  vehicle operation/maintenance and qualifying vessel work;
- the employer may grant a more favourable contractual OT entitlement.

The effective-dated `statutory_work_category` stores this operational decision:

- `NON_MANUAL`;
- `MANUAL_LABOUR`;
- `MANUAL_LABOUR_SUPERVISOR`;
- `COMMERCIAL_VEHICLE_OPERATOR`;
- `VESSEL_WORK`.

Seeded Nihon `OPERATION` roles are initially inferred as `MANUAL_LABOUR`. HR can correct the stored
category; payroll does not repeatedly guess it from job title.

## 8. Unpaid leave and incomplete months

Malaysian incomplete-month pay follows Employment Act 1955 section 18A:

```text
calendar-day rate = round(monthly salary / calendar days in month, 2)
dated NPL         = round(calendar-day rate × approved unpaid-leave days, 2)
```

The leave date and settlement policy decide which payroll owns the deduction. A source attendance
comment is not allowed to overwrite an accepted leave request without supporting operational
evidence.

## 9. Statutory contributions

The engine first builds contribution wage bases from the legal substance of each pay component,
then applies the effective statutory table.

- EPF: genuine overtime, including the same OT value reported as statutory-excess incentive OT, is
  excluded from EPF wages. Salary, ordinary incentives, allowances, bonuses and wage arrears follow
  their configured legal treatment.
- SOCSO and EIS: salary, overtime, incentives and applicable allowances enter the insured wage base,
  subject to the effective statutory ceiling/table.
- PCB: taxable remuneration and relief/YTD facts are passed to the effective computerised MTD
  calculation.
- HRD levy: the effective employer rate is applied to the eligible Malaysian employee wage base.

Changing a contribution amount without reconciling its wage base is not an acceptable fix.

## 10. Current validation behaviour

Payroll calculation:

- blocks missing configuration or unmapped payable statutory rate bands;
- preserves the OT authorisation gate;
- floors dated OT down to half-hour units;
- emits warnings for work above 12 actual hours;
- emits calendar-month warnings for regulated OT above 104 hours;
- pays statutory excess through its derived component at the same legal value;
- preserves source provenance for every generated payroll line.

## Official references

- [Employment Act 1955, current JTKSM copy](https://jtksm.mohr.gov.my/sites/default/files/2023-11/Akta%20Kerja%201955%20%28Akta%20265%29.pdf)
- [Employment (Limitation of Overtime Work) Regulations 1980](https://jtksm.mohr.gov.my/sites/default/files/2023-03/7.%20EMPLOYMENT%20%28LIMITATION%20OF%20OVERTIME%20WORK%29%20REGULATIONS%201980_0.pdf)
- [JTKSM legislation and guideline register](https://jtksm.mohr.gov.my/en/services/registration-place-employment/acts-guidelines)
- [EPF mandatory contribution guidance](https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution)
- [PERKESO contribution rates](https://www.perkeso.gov.my/en/rate-of-contribution.html)
- [LHDN computerised MTD specifications](https://www.hasil.gov.my/majikan/potongan-cukai-bulanan-pcb/)
