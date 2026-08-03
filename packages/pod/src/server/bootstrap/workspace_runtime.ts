import {
	withRequestWorkspaceCtx,
	type ProvisionedContext
} from '$lib/server/bootstrap/workspace_store.js';

export function runWithWorkspaceContext<R>(ctx: ProvisionedContext, fn: () => R): R {
	return withRequestWorkspaceCtx(ctx, fn);
}
