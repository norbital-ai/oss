import { Context, Layer } from 'effect';

/**
 * Which tenant this invocation is for, as the host scoped it.
 *
 * It exists because a *static* identity has to be minted with a tenant and has no row to read one
 * off. A person's subject carries `tenantId` from the credential that authenticated them; an envoy
 * or an automation is declared in source, so the only party that knows which workspace it is acting
 * in is the invocation itself.
 *
 * It comes from `invocation.scope`, never from a payload, and it is exactly the value
 * `authorizeInvocationProvenance` compares a claimed subject's tenant against — so a minted subject
 * and an authenticated one are scoped by the same fact rather than by two.
 *
 * Deliberately not folded into `CallContext`, which is the shape a *facility call* carries: this is
 * read by services deciding who is acting, and putting it there would mean every facility binding
 * received a field none of them read.
 */
export type Interface = Readonly<{ readonly tenantId: string }>;

/** Identifies the tenant scope in Effect's context so it is provided rather than ambient. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/TenantScope');

export const layer = (tenantId: string): Layer.Layer<Interface> =>
	Layer.succeed(Service, { tenantId });

export * as TenantScope from './tenant.js';
