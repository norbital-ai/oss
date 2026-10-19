import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** An APNs registration as the iOS shell reports it. */
export type PushRegistration = {
	kind: 'apns';
	/** The device token, lowercase hex. */
	token: string;
	/** The bundle id, which APNs calls the topic. */
	topic: string;
	environment: 'development' | 'production';
	teamId: string;
};

/**
 * The native `NorbitalShell` plugin (templates' `NorbitalShell.swift` and `NorbitalShellPlugin.java`).
 * `pushRegistration` exists on iOS only; `startNotices` / `stopNotices` on Android only.
 */
type NorbitalShellPlugin = {
	locationStatus(): Promise<{ enabled: boolean; always: boolean }>;
	openSettings(): Promise<void>;
	pushRegistration(): Promise<PushRegistration>;
	addListener(
		event: 'pushRegistration',
		listener: (registration: PushRegistration) => void
	): Promise<PluginListenerHandle>;
	startNotices(options: { url: string }): Promise<void>;
	stopNotices(): Promise<void>;
};

export const NorbitalShell = registerPlugin<NorbitalShellPlugin>('NorbitalShell');
