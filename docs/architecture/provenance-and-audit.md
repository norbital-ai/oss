# Provenance and audit

```text
effective configuration ---> payroll_runs.configuration_snapshot
                                      |
employment ------------------------> payslip
                                      |
                                      v
pay_component <---------------- payslip_line ----------------> statutory scheme
                                      |
                                      `----------------------> component_entry
```

There is no line-source collection. The payslip line is the physical junction and directly answers:

- which component produced the amount;
- which monetary event was consumed, when the line is entry-backed;
- which statutory scheme, base, band and special amounts produced a statutory line; and
- which payslip and run froze the result.

The configuration snapshot is housed once by the pay run because every payslip in that run shares
the same picked policy. Pre-migration runs retain `LEGACY_HASH_ONLY`; the migration does not invent
historical configuration that was never stored.

Single-use and recurring consumption are database invariants:

```text
SINGLE_USE: unique(component_entry_id)
RECURRING:  unique(component_entry_id, payslip_id)
MATCHING:   FK(line.entry_id, line.component_id, line.usage)
            -> component_entry(id, component_id, usage)
```

Scheduled, formula and overtime lines link to their pay component and remain reproducible from the
run snapshot plus approved inputs. Historical aggregated entry lines are migrated as
`LEGACY_COMPONENT` instead of guessing an allocation across old many-source rows.
