import { makeLayer as makeBundleLoaderLayerValue } from './bundle-loader.js';
import { makeAiBinding as makeAiBindingValue } from './facilities/ai.js';
import { makeCommunicationBinding as makeCommunicationBindingValue } from './facilities/communication.js';
import { makeConnectorBinding as makeConnectorBindingValue } from './facilities/connector.js';
import {
	makeLocalDatabase as makeLocalDatabaseValue,
	makePostgresDatabase as makePostgresDatabaseValue
} from './facilities/database.js';
import { makeLocalFilesBinding as makeLocalFilesBindingValue } from './facilities/files.js';
import { makeHostToolBinding as makeHostToolBindingValue } from './facilities/host-tools.js';
import { makeTaskBinding as makeTaskBindingValue } from './facilities/tasks.js';
import {
	makeMemoryTransport as makeMemoryTransportValue,
	makeTransportBinding as makeTransportBindingValue
} from './facilities/transport.js';
import { startServer as startServerValue } from './server.js';

/** Groups the physical self-host constructors for explicit host composition and discovery. */
export const selfHostConstructors = {
	bundleLoaderLayer: makeBundleLoaderLayerValue,
	aiBinding: makeAiBindingValue,
	communicationBinding: makeCommunicationBindingValue,
	connectorBinding: makeConnectorBindingValue,
	localDatabase: makeLocalDatabaseValue,
	postgresDatabase: makePostgresDatabaseValue,
	localFilesBinding: makeLocalFilesBindingValue,
	hostToolBinding: makeHostToolBindingValue,
	taskBinding: makeTaskBindingValue,
	transportBinding: makeTransportBindingValue,
	memoryTransport: makeMemoryTransportValue,
	server: startServerValue
};

export {
	ApplicationStartError,
	installProcessShutdown,
	startApplication,
	type ApplicationOptions,
	type RunningApplication
} from './app.js';
export {
	BundleLoadError,
	BundleLoader,
	makeLayer as makeBundleLoaderLayer,
	type LayerOptions as BundleLoaderLayerOptions
} from './bundle-loader.js';
export {
	ConfigurationError,
	ProviderConfigurationError,
	ServerConfiguration,
	loadConfiguration,
	selectConfiguredProvider,
	type ConfiguredProviderFactory,
	type ConfiguredProviderSettings
} from './config.js';
export {
	AdmissionStopped,
	DrainTimedOut,
	HealthSnapshot,
	ServerHealth,
	layer as serverHealthLayer
} from './health.js';
export {
	CommandInputError,
	ServerTransportError,
	startServer,
	type RunningServer
} from './server.js';
export {
	makeAiBinding,
	makeAiBindingFromConfig,
	type Provider as AiProvider
} from './facilities/ai.js';
export {
	makeCommunicationBinding,
	makeCommunicationBindingFromConfig,
	type Provider as CommunicationProvider
} from './facilities/communication.js';
export {
	makeConnectorBinding,
	makeConnectorBindingFromConfig,
	type Provider as ConnectorProvider
} from './facilities/connector.js';
export {
	makeDatabaseFromConfig,
	makeLocalDatabase,
	makePostgresDatabase,
	makePostgresDatabaseFromConfig,
	type DatabaseProvider,
	type LocalDatabase,
	type LocalDatabaseOptions,
	type PostgresDatabaseOptions
} from './facilities/database.js';
export {
	makeFilesBindingFromConfig,
	makeLocalFilesBinding,
	makeLocalFilesBindingFromConfig,
	type LocalFilesOptions
} from './facilities/files.js';
export {
	makeHostToolBinding,
	makeHostToolBindingFromConfig,
	type Provider as HostToolProvider
} from './facilities/host-tools.js';
export { makeTaskBinding, TaskFacilities } from './facilities/tasks.js';
export { makeScheduler, type Scheduler, type SchedulerOptions } from './scheduler.js';
export {
	makeMemoryTransport,
	makeTransportBinding,
	TransportFacilities,
	type Provider as TransportProvider
} from './facilities/transport.js';
