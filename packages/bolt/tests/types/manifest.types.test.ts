// The engine manifest's part types are the decl types (W2.F2b): each part decodes as its declaration's literal type, so
// an interior reads what an author wrote without a cast. `Same` is mutual assignability: a Schema-built part is
// `readonly` where the decl type is not. Never run, only checked.
import { expectTypeOf } from '@effect/vitest';
import type { TeamEntries } from '../../src/decl/access/team.ts';
import type { custom_field } from '../../src/decl/custom-field.ts';
import type { ExposureSpec, ModelParts, ModelSpec } from '../../src/decl/model.ts';
import type { RelationshipSpec } from '../../src/decl/names.ts';
import type { McpBase } from '../../src/decl/runtime/agent.ts';
import type { AppSpec, GroupSpec, secrets, workspace } from '../../src/decl/runtime/app.ts';
import type { AutomationSpec } from '../../src/decl/runtime/automation.ts';
import type { IntegrationSpec } from '../../src/decl/runtime/integration.ts';
import type { Signup } from '../../src/engine/identity/session.ts';
import type { EngineManifest, Relation } from '../../src/engine/manifest.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Part<K extends keyof EngineManifest> =
	NonNullable<EngineManifest[K]> extends { readonly [name: string]: infer V } ? V : never;
type Workspace = EngineManifest['workspace'];

// ── parts the compiler proves: exactly the decl type ──
expectTypeOf<Part<'models'>>().toEqualTypeOf<ModelSpec>();
expectTypeOf<Part<'relationships'>>().toEqualTypeOf<RelationshipSpec>();
expectTypeOf<ModelParts['relationships'][string]>().toEqualTypeOf<RelationshipSpec>();
expectTypeOf<Relation['spec']>().toEqualTypeOf<RelationshipSpec>();
const relationship: RelationshipSpec = {
	to: ['customers', 'suppliers'],
	optional: true,
	default: { var: 'requestor.party' },
	where: { and: [{ active: { eq: true } }, { name: { in: ['A', 'B'] } }] }
};
// @ts-expect-error decoded relationship metadata is readonly
relationship.to = 'customers';
const invalid_relationship: RelationshipSpec = {
	to: 'customers',
	// @ts-expect-error relationship predicates retain strict JSON rather than arbitrary objects
	where: { active: () => true }
};
void relationship;
void invalid_relationship;
expectTypeOf<Same<Part<'exposures'>, ExposureSpec>>().toEqualTypeOf<true>();
expectTypeOf<Same<Omit<Part<'integrations'>, 'test'>, IntegrationSpec>>().toEqualTypeOf<true>();
expectTypeOf<Part<'integrations'>['test']>().toEqualTypeOf<true | undefined>();
expectTypeOf<Same<Part<'automations'>, AutomationSpec>>().toEqualTypeOf<true>();
expectTypeOf<Same<Part<'mcp'>, McpBase>>().toEqualTypeOf<true>();
expectTypeOf<Part<'apps'>>().toEqualTypeOf<AppSpec>();
expectTypeOf<Part<'groups'>>().toEqualTypeOf<GroupSpec>();
expectTypeOf<
	Same<Part<'custom_fields'>, Omit<ReturnType<typeof custom_field>['spec'], 'validate'> & { check?: true }>
>().toEqualTypeOf<true>();

// ── parts decoded member by member: the decl shape ──
expectTypeOf<
	Same<NonNullable<Workspace['secrets']>[string], ReturnType<typeof secrets>[string]>
>().toEqualTypeOf<true>();
expectTypeOf<
	Same<NonNullable<Workspace['ai']>, NonNullable<ReturnType<typeof workspace>['ai']>>
>().toEqualTypeOf<true>();
expectTypeOf<
	Same<NonNullable<Workspace['convert']>, NonNullable<ReturnType<typeof workspace>['convert']>>
>().toEqualTypeOf<true>();
expectTypeOf<
	Same<NonNullable<Workspace['agent']>, NonNullable<ReturnType<typeof workspace>['agent']>>
>().toEqualTypeOf<true>();
expectTypeOf<Same<NonNullable<Workspace['signup']>, Signup>>().toEqualTypeOf<true>();
expectTypeOf<Same<EngineManifest['teams'], TeamEntries>>().toEqualTypeOf<true>();
expectTypeOf<'connections' extends keyof EngineManifest ? true : false>().toEqualTypeOf<false>();
expectTypeOf<Workspace['tz']>().toEqualTypeOf<string>();
