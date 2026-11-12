// `@norbital-ai/bolt/host-api`: the Host API between a host and a pinned release (`protocol/host-api.ts`). The types a
// host hands over or gets back derive from `HostApi` (`Parameters<HostApi['branch']>[0]`,
// `Awaited<ReturnType<HostApi['activate']>>`) and `HostPorts`.
export {
	HOST_API,
	HOST_API_VERSION,
	HostApiFailure,
	HostFailure,
	MigrationImpact,
	render_mode,
	type CellEnd,
	type HostApi,
	type HostPorts,
	type Kernel
} from './protocol/host-api.ts';
