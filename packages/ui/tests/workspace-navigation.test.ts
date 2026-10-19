import './dom.ts';
import { afterEach, expect, it, vi } from '@effect/vitest';
import {
	beginWorkspaceNavigation,
	workspaceNavigation
} from '../src/utilities/workspace-navigation.ts';

const disposers: (() => void)[] = [];
const initialUrl = location.href;
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.replaceChildren();
	history.replaceState(null, '', initialUrl);
	vi.unstubAllGlobals();
});
const cover = () => document.querySelector('.workspace-opening');
const link = () => {
	const node = document.createElement('a');
	// Exercise the browser's default action without requesting a fixture server.
	node.href = '#workspace-option';
	document.body.append(node);
	const action = workspaceNavigation(node, 'Opening workspace…');
	disposers.push(() => action.destroy());
	return node;
};

it('covers a workspace link synchronously before its normal navigation can start', async () => {
	const node = link();
	const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
	node.dispatchEvent(event);
	expect(cover()?.textContent).toContain('Opening workspace…');
	expect(cover()?.getAttribute('role')).toBe('status');
	expect(event.defaultPrevented).toBe(false);
	expect(location.hash).toBe('#workspace-option');
	await Promise.resolve();
	expect(cover()).not.toBeNull();
});

it('preserves modified clicks, other targets, downloads and cancelled navigation', async () => {
	const node = link();
	for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
		node.hash = `workspace-${modifier}`;
		node.dispatchEvent(new MouseEvent('click', { button: 0, [modifier]: true }));
		expect(cover()).toBeNull();
	}
	node.hash = 'workspace-top';
	node.target = '_top';
	node.dispatchEvent(new MouseEvent('click', { button: 0 }));
	expect(cover()).toBeNull();
	node.target = '';
	node.hash = 'workspace-download';
	node.download = 'file';
	node.dispatchEvent(new MouseEvent('click', { button: 0 }));
	expect(cover()).toBeNull();
	node.removeAttribute('download');
	node.addEventListener('click', (event) => event.preventDefault());
	node.dispatchEvent(new MouseEvent('click', { button: 0, cancelable: true }));
	await Promise.resolve();
	expect(cover()).toBeNull();
});

it('clears a failed or aborted navigation and restores keyboard focus', () => {
	const navigation = new EventTarget();
	vi.stubGlobal('navigation', navigation);
	const button = document.createElement('button');
	document.body.append(button);
	button.focus();
	disposers.push(beginWorkspaceNavigation('Opening workspace…'));
	expect(document.activeElement).toBe(cover());
	navigation.dispatchEvent(new Event('navigateerror'));
	expect(cover()).toBeNull();
	expect(document.activeElement).toBe(button);
	disposers.push(beginWorkspaceNavigation('Opening workspace…'));
	const controller = new AbortController();
	const event = new Event('navigate');
	Object.defineProperty(event, 'signal', { value: controller.signal });
	navigation.dispatchEvent(event);
	controller.abort();
	expect(cover()).toBeNull();
});

it('does not cache a stale cover on Back or retain one after a cancelled unload or Escape', async () => {
	for (const type of ['pagehide', 'pageshow', 'popstate']) {
		disposers.push(beginWorkspaceNavigation('Opening workspace…'));
		window.dispatchEvent(new Event(type));
		expect(cover()).toBeNull();
	}
	disposers.push(beginWorkspaceNavigation('Opening workspace…'));
	const leaving = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(leaving);
	leaving.preventDefault();
	await Promise.resolve();
	expect(cover()).toBeNull();
	disposers.push(beginWorkspaceNavigation('Opening workspace…'));
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
	expect(cover()).toBeNull();
});

it('teardown removes the cover and no longer responds to link activation', () => {
	const node = document.createElement('a');
	document.body.append(node);
	const action = workspaceNavigation(node, 'Opening workspace…');
	node.dispatchEvent(new MouseEvent('click', { button: 0 }));
	expect(cover()).not.toBeNull();
	action.destroy();
	node.dispatchEvent(new MouseEvent('click', { button: 0 }));
	expect(cover()).toBeNull();
});
