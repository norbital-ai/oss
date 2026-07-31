/**
 * Declares that reconstructions are created, and nothing else.
 *
 * A collection's mutation surface is gated by its behaviour: without a `create`
 * entry here, `api.db.site_reconstructions.create` simply does not exist at
 * runtime. The project hooks do not need it — an `after` hook writes through the
 * elevated `api.db.mutate` — but `+rebuild_reconstruction.ts` is a remote command
 * handler, and a remote handler is given the ordinary (non-elevated) API. That is
 * the path a seeded or imported project takes, which is exactly the path that has
 * no hook to ride on.
 *
 * No hook body: a run is assembled in full by `runStitchForProject` before it is
 * written, so there is nothing to add or check on the way in.
 */
export default {
	create: {}
};
