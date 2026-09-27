// Runs (X-18 ledger): no grant; read through $bolt.runs, RunStatus, RunsFor and /runs (rule 56).
import { collection } from '../../../../decl/collection.ts';

export default collection('sys_run', { read: { fields: 'all' } });
