# HR & Payroll documentation

These documents describe the current implementation. Historical plans and superseded variance
explanations are intentionally not retained here: a reader should not have to decide which version
is true.

## Architecture

| Document                                                                            | Purpose                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Overview](architecture/README.md)                                                  | System boundaries, model pillars and the end-to-end map                       |
| [Payroll lifecycle](architecture/payroll-lifecycle.md)                              | Eight calculation phases, run states, cutoffs and YTD ordering                |
| [Time, overtime and cutoffs](architecture/time-overtime-and-cutoffs.md)             | Clocks, shifts, day types, half-hour flooring, 12-hour and 104-hour controls  |
| [Calculation and statutory treatment](architecture/calculation-and-statutory.md)    | Rates, proration, contribution bases, statutory calculations and YTD          |
| [Adjustments, ledgers and locking](architecture/adjustments-ledgers-and-locking.md) | Corrections, leave and loan ledgers, approval locks and paid-run immutability |
| [Provenance and audit](architecture/provenance-and-audit.md)                        | Source relationships, configuration hashes, current guarantees and known gaps |

## Data and reconciliation

| Document                                          | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [Data preparation](data/README.md)                | What cleaned source data means and what belongs in seed                  |
| [Source-to-seed contract](data/source-to-seed.md) | Field classes, allowed transformations, omissions and corrections        |
| [Reconciliation method](data/reconciliation.md)   | How an independent source workbook is compared with a generated workbook |

Dated variance evidence against real source workbooks is maintained in the private Core
reconciliation suite, not in this public template.

## Authority order

When two statements disagree, use this order:

1. statutory source and effective jurisdiction configuration;
2. current executable template code;
3. cleaned source input and its provenance;
4. generated payroll workbook;
5. explanatory documentation.

Documentation is updated when code or reconciliation evidence changes. Generated workbooks are
never promoted into source input merely because they are convenient.
