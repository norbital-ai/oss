// Type corpus for the built-in layer (`src/system/**`): workspace code names the system models as it names its
// own, typed by their declarations; the engine's private models (sessions, challenges, config) are no model.
import type { Insert, Patch } from '../../src/decl/ctx.ts';
import type { ModelName, ColumnValue, ReadField, SystemName } from '../../src/decl/names.ts';
import type { Id, Json } from '../../src/decl/values.ts';
import type { Where } from '../../src/decl/where.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;
type Flat<T> = { [K in keyof T]: T[K] };

is<Eq<ColumnValue<'sys_user', 'kind'>, 'staff' | 'external' | 'anonymous'>>();
is<Eq<ColumnValue<'sys_user', 'email'>, string | null>>();
is<Eq<ColumnValue<'sys_user', 'team'>, string | null>>();
is<Eq<ColumnValue<'approval_request', 'id'>, Id<'approval_request'>>>();
is<Eq<'sys_run' extends SystemName ? true : false, true>>();
is<Eq<'sys_session' extends ModelName ? true : false, false>>();
const staff: Where<'sys_user'> = { kind: { eq: 'staff' }, active: { eq: true } };
// @ts-expect-error S1 a stored user's kind is staff, external or anonymous, unlike an actor's member kind
const member: Where<'sys_user'> = { kind: { eq: 'member' } };
// a member's team is a source handle: `actor.teams` / `actor.teamTree` compare it in a list
const inTree: Where<'sys_user'> = { team: { in: { var: 'requestor.teamTree' } } };
// @ts-expect-error S1 a team operand only on a team field
const notTeam: Where<'sys_user'> = { email: { in: { var: 'requestor.teams' } } };
void staff;
void member;
void inTree;
void notTeam;

// an instance is created naming its definition (and its member, when personal, or the envoy it carries); the host's
// fence is no column of it
is<
	Eq<
		Flat<Insert<'sys_integration'>>,
		{
			readonly integration: string;
			readonly name: string;
			readonly owner?: Id<'sys_user'> | null;
			readonly envoy?: string | null;
			readonly configuration?: Json;
		}
	>
>();
is<Eq<ColumnValue<'sys_message', 'integration'>, Id<'sys_integration'> | null>>();
is<
	Eq<
		Flat<Patch<'sys_integration'>>,
		{
			readonly name?: string;
			readonly envoy?: string | null;
			readonly active?: boolean;
			readonly configuration?: Json;
			readonly import_start?: Json;
		}
	>
>();
// @ts-expect-error S2 an instance's definition never changes
const moved: Patch<'sys_integration'> = { integration: 'email' };
// @ts-expect-error S3 the host's fence is never readable
const fence: ReadField<'sys_integration'> = 'epoch';
void moved;
void fence;
