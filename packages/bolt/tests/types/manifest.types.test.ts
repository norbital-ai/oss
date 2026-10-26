// The engine manifest's part types are the decl types (W2.F2b): each part decodes as its declaration's literal type, so
// an interior reads what an author wrote without a cast. `Same` is mutual assignability: a Schema-built part is
// `readonly` where the decl type is not. Never run, only checked.
import { expectTypeOf } from '@effect/vitest';
import type { TeamEntries } from '../../src/decl/access/team.ts';
import type { customField } from '../../src/decl/custom-field.ts';
import type { CollectionSpec, ModelSpec } from '../../src/decl/model.ts';
import type { RelationshipSpec } from '../../src/decl/names.ts';
import type { EnvoySpec, mcp } from '../../src/decl/runtime/agent.ts';
import type { AppSpec, GroupSpec, secrets, workspace } from '../../src/decl/runtime/app.ts';
import type { AutomationSpec } from '../../src/decl/runtime/automation.ts';
import type { IntegrationSpec } from '../../src/decl/runtime/integration.ts';
import type { KioskSpec } from '../../src/decl/runtime/kiosk.ts';
import type { Signup } from '../../src/engine/identity/session.ts';
import type { EngineManifest } from '../../src/engine/manifest.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Part<K extends keyof EngineManifest> =
	NonNullable<EngineManifest[K]> extends { readonly [name: string]: infer V } ? V : never;
type Workspace = EngineManifest['workspace'];

// ── parts the compiler proves: exactly the decl type ──
expectTypeOf<Part<'models'>>().toEqualTypeOf<ModelSpec>();
expectTypeOf<Part<'relationships'>>().toEqualTypeOf<RelationshipSpec>();
expectTypeOf<Part<'collections'>>().toEqualTypeOf<CollectionSpec>();
expectTypeOf<Omit<Part<'integrations'>, 'test'>>().toEqualTypeOf<IntegrationSpec>();
expectTypeOf<Part<'integrations'>['test']>().toEqualTypeOf<true | undefined>();
expectTypeOf<Part<'automations'>>().toEqualTypeOf<AutomationSpec>();
expectTypeOf<Part<'envoys'>>().toEqualTypeOf<EnvoySpec>();
expectTypeOf<Part<'mcp'>>().toEqualTypeOf<ReturnType<typeof mcp>>();
expectTypeOf<Part<'apps'>>().toEqualTypeOf<AppSpec>();
expectTypeOf<Part<'kiosks'>>().toEqualTypeOf<KioskSpec>();
expectTypeOf<Part<'groups'>>().toEqualTypeOf<GroupSpec>();
expectTypeOf<Part<'customFields'>>().toEqualTypeOf<
	Omit<ReturnType<typeof customField>['spec'], 'validate'> & { check?: true }
>();

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
expectTypeOf<
	Same<Part<'connections'>, { integration: string; envoy?: string }>
>().toEqualTypeOf<true>();
expectTypeOf<Workspace['tz']>().toEqualTypeOf<string>();
