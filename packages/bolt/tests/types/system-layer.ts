// Type corpus for the built-in layer (`src/system/**`): workspace code names the system collections as it names its
// own, typed by their declarations; the engine's private models (sessions, challenges, config) are no collection.
import type { CollectionName, ColumnValue, SystemName } from '../../src/decl/names.ts';
import type { Id } from '../../src/decl/values.ts';
import type { Where } from '../../src/decl/where.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

is<Eq<ColumnValue<'sys_user', 'kind'>, 'staff' | 'external'>>();
is<Eq<ColumnValue<'sys_user', 'email'>, string | null>>();
is<Eq<ColumnValue<'sys_user', 'team'>, Id<'sys_team'> | null>>();
is<Eq<ColumnValue<'approval_request', 'id'>, Id<'approval_request'>>>();
is<Eq<'sys_run' extends SystemName ? true : false, true>>();
is<Eq<'sys_session' extends CollectionName ? true : false, false>>();
const staff: Where<'sys_user'> = { kind: { eq: 'staff' }, active: { eq: true } };
// @ts-expect-error S1 a member's kind is staff or external (the old hand type said 'member')
const member: Where<'sys_user'> = { kind: { eq: 'member' } };
// @ts-expect-error S2 a system row carries no engine columns beyond its key
const approval: ColumnValue<'sys_team', 'approval_id'> = null;
void staff; void member; void approval;
