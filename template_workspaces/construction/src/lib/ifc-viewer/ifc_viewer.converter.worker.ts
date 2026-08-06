/// <reference lib="webworker" />

import { getErrorMessage } from '@norbital-ai/std';

import type {
	ViewerIfcApi,
	ViewerIfcApiConstructor,
	ViewerLocateFileHandler
} from './ifc_viewer.types.js';

declare const self: DedicatedWorkerGlobalScope;

type ConvertRequestMessage = {
	type: 'convert';
	bytes: ArrayBuffer;
};

type ConvertSuccessMessage = {
	type: 'success';
	fragmentBytes: ArrayBuffer;
};

type ConvertErrorMessage = {
	type: 'error';
	error: string;
};

type WorkerReadyMessage = {
	type: 'ready';
};

type WorkerRequestMessage = ConvertRequestMessage;

const GEOMETRY_LOG_MESSAGE = 'Fragments: Zero length geometry:';

let webIfcConfigured = false;

function configureWebIfc(wasmUrl: string, IfcAPI: ViewerIfcApiConstructor): void {
	if (webIfcConfigured) return;

	const originalInit = IfcAPI.prototype.Init;
	IfcAPI.prototype.Init = function initWithResolvedWasmUrl(
		this: ViewerIfcApi,
		customLocateFileHandler?: ViewerLocateFileHandler,
		forceSingleThread = true
	): Promise<void> {
		const handler = customLocateFileHandler ?? (() => wasmUrl);
		return originalInit.call(this, handler, forceSingleThread);
	};
	webIfcConfigured = true;
}

async function importIfcImporter() {
	const wasmUrl = 'https://esm.sh/web-ifc@0.0.77/web-ifc.wasm';
	const { IfcAPI } = await import(/* @vite-ignore */ 'https://esm.sh/web-ifc@0.0.77');
	configureWebIfc(wasmUrl, IfcAPI);
	const FRAGS = await import(
		/* @vite-ignore */ 'https://esm.sh/@thatopen/fragments@3.4.6?deps=three@0.185.1,web-ifc@0.0.77'
	);
	const instance = new FRAGS.IfcImporter();
	instance.wasm = { path: '', absolute: true };
	return instance;
}

function shouldSuppressGeometryLog(args: unknown[]): boolean {
	const [firstArg] = args;
	return typeof firstArg === 'string' && firstArg.includes(GEOMETRY_LOG_MESSAGE);
}

async function withSuppressedGeometryLogs<T>(task: () => Promise<T>): Promise<T> {
	const originalLog = console.log;
	const originalWarn = console.warn;

	console.log = (...args: unknown[]) => {
		if (shouldSuppressGeometryLog(args)) return;
		originalLog(...args);
	};

	console.warn = (...args: unknown[]) => {
		if (shouldSuppressGeometryLog(args)) return;
		originalWarn(...args);
	};

	try {
		return await task();
	} finally {
		console.log = originalLog;
		console.warn = originalWarn;
	}
}

async function createImporter() {
	const importer = await importIfcImporter();
	self.postMessage({ type: 'ready' } satisfies WorkerReadyMessage);
	return importer;
}

async function handleConvert(message: ConvertRequestMessage): Promise<void> {
	try {
		const importer = await createImporter();
		const fragmentBytes = await withSuppressedGeometryLogs(() =>
			importer.process({
				bytes: new Uint8Array(message.bytes)
			})
		);
		const transferableFragmentBytes = fragmentBytes.slice().buffer;

		self.postMessage(
			{
				type: 'success',
				fragmentBytes: transferableFragmentBytes
			} satisfies ConvertSuccessMessage,
			[transferableFragmentBytes]
		);
	} catch (error) {
		self.postMessage({
			type: 'error',
			error: error instanceof Error ? getErrorMessage(error) : 'ifc.unable_to_convert'
		} satisfies ConvertErrorMessage);
	}
}

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
	const message = event.data;
	if (message.type !== 'convert') return;

	void handleConvert(message);
};

self.onerror = (event: ErrorEvent) => {
	self.postMessage({
		type: 'error',
		error: 'ifc.worker_crashed'
	} satisfies ConvertErrorMessage);
};
