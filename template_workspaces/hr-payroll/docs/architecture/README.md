# HR and payroll architecture

Payroll is a deterministic settlement engine over approved, effective-dated facts. The database
keeps business inputs separate from settled output, but does not add projection or linkage layers.

## Current architecture (before this migration)

```text
component_types ----< pay_components ----< component_entries
       |                    |                       |
       |                    v                       v
       +-------------> payslip_lines <---- payslip_line_sources
                              ^
                              |
payroll_runs ----< payslips --+---- payslip_contributions

leave_requests ----> leave_ledger
leave_types --------> accrual_bands
```

The type catalogue duplicated policy above `pay_components`; output then split a payslip across
lines, source links and statutory contribution rows. Leave likewise duplicated approved requests
into a ledger. Those layers made a settled number harder to query without adding new business facts.

## Target architecture

```text
APPROVED INPUTS                         SETTLED OUTPUT

employment_terms --+                 +-> payroll_runs [one policy snapshot]
time_entries -------+                 |        |
leave_requests -----+--> calculator -+        v
component_entries --+                          payslips
       |                                        |
       v                                        v
pay_components <-------------------------- payslip_lines
 [policy + calculation +                    [the only junction]
  entitlement union]                        |- pay_component_id
                                             |- component_entry_id (when entry-backed)
                                             `- statutory_contribution_id (when statutory)

leave_types
 [accrual + payroll effect + entitlement layers]
       |
       `-- statutory floor
           + organisation enhancement
           + employee enhancement
```

The payroll-output core is five collections:

1. `pay_components` — one reusable definition with a strict settlement/statutory policy and a
   polymorphic calculation definition.
2. `component_entries` — approved monetary events such as claims, allowances, adjustments and loan
   instalments.
3. `payroll_runs` — one company-period calculation and one captured policy snapshot.
4. `payslips` — one employment's totals in a run.
5. `payslip_lines` — the direct payslip-to-component junction and complete breakdown.

`payslip_lines.component` is a closed union. Ordinary lines must name a pay component; entry-backed
lines must also name exactly one component entry; statutory lines must name a statutory scheme.
Generated relational columns and composite foreign keys enforce those links physically. A
single-use entry has one line globally. A recurring entry may have one line per payslip.

## Leave and layered entitlement

Leave is not itself money. `leave_requests` is the approved event stream, `leave_types` owns the
entitlement/accrual policy, and a mapped `pay_component` owns only the monetary effect (for example,
unpaid-leave deduction or encashment).

The entitlement matrix is embedded in `leave_types` as a strict layer union:

```text
effective entitlement = max(statutory floor, organisation layer, employee layer)
```

The same layering principle applies to claim and allowance caps in their pay-component definition:
statutory policy cannot be weakened, while organisation and employee layers may enhance it. This is
policy data, not a reason to add one collection per benefit kind.

## Run snapshot and locking

Configuration is captured once on `payroll_runs`, never once per payslip. Every payslip in a run was
calculated from the same picked company and statutory policy. Repeating the snapshot per payslip
would duplicate identical JSON and permit impossible disagreement inside one run.

```text
DRAFT run --recalculate--> DRAFT run --lock & pay--> PAID run
                                                   [immutable]
```

YTD is summed from earlier paid statutory payslip lines. Leave balance is derived from approved
leave events. Neither requires a mutable ledger/cache collection.
