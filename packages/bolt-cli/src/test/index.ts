// Public test edge: one scoped workspace layer and Effect-native callers.
export {
	it,
	expect,
	type NativeReadAnswer,
	type NativeActAnswer,
	type Caller,
	KitInvalid,
	type CassetteOptions,
	type TestPorts,
	type TestOptions,
	type Kit,
	type WorkspaceServices,
	JobResult,
	NativeReadRow,
	respond_system_1,
	TestWorkspace
} from './effect.ts';
export { memory_audit } from './audit.ts';
export { release } from './release.ts';
export { prune } from './checkpoint.ts';
// a host's tests generate a fixture's migration history as `bolt build` does
export { prepare_migrations } from '../compiler/migrations.ts';
