// Name unions of the runtime roles, read from the names index like the data-layer names (§3.1).
import type { AutomationName, NamesPart } from '../names.ts';
import type { ConvertTarget } from './facilities.ts';

/** The connection names (`src/connection/+<n>.connection.ts`). */
export type ConnectionName = keyof NamesPart<'connections'> & string;
type Env = NamesPart<'workspace'> extends { env: infer E } ? E : {};
/** A name `+workspace.ts` declares under `env`. */
export type EnvName = keyof Env & string;
type Ai = NamesPart<'workspace'> extends { ai: infer A } ? A : {};
/** A name `+workspace.ts` declares under `ai.embeddings`. */
export type EmbeddingModelName = Ai extends { embeddings: readonly (infer E)[] } ? E & string : never;
type ConvertDecl = NamesPart<'workspace'> extends { convert: { to: readonly (infer T)[] } } ? T : never;
/** A document target `+workspace.ts` declares under `convert.to`; `ctx.convert.document` takes only these. */
export type DeclaredConvertTarget = ConvertDecl & ConvertTarget;
/** A `sys_2` model class an agent or `ctx.ai.sys_2.infer` asks for; the host maps each to a model. */
export type AiModelClass = 'default' | 'fast' | 'strong'; // every sys_2 model takes images (P39): no 'vision' class
export type GroupName = keyof NamesPart<'groups'> & string;
/** The `+<page>.page.svelte` files in app `A`'s folder. */
export type PageName<A> = A extends keyof NamesPart<'pages'> ? NamesPart<'pages'>[A] & string : never;
/** The app and group folders directly in group `G`. */
export type ChildName<G> = G extends keyof NamesPart<'groups'> ? NamesPart<'groups'>[G] & string : never;

/** A channel transport: `email`, `whatsapp`, `telegram`, or the built-in in-app `inbox`. */
export type Transport = 'email' | 'whatsapp' | 'telegram' | 'inbox';
/** The transport a channel declares (`inbox` is the built-in in-app channel). */
export type TransportOf<N> = N extends 'inbox' ? 'inbox'
	: N extends keyof NamesPart<'channels'> ? NamesPart<'channels'>[N] extends { transport: infer T } ? T : never : never;
/** The literal an automation declares, by name. */
export type AutomationSpecOf<A> = A extends AutomationName ? NamesPart<'automations'>[A] extends { spec: infer S } ? S : never : never;
export type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
