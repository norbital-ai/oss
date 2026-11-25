import './dom.ts';
import { flushSync } from 'svelte';
import { expect, it, vi } from 'vitest';
import { in_root } from './run-root.svelte.ts';
import {
	bind_avoid_keyboard,
	bind_drag_preview,
	bind_viewport,
	check_direction,
	check_pattern,
	color_scheme_of,
	color_scheme_script,
	contrast_ratio,
	create_carousel,
	create_checkbox_group,
	create_color_picker,
	create_color_scheme,
	create_cookie_storage,
	create_drawer,
	create_file_dropzone,
	create_hover_card,
	create_image_cropper,
	create_menubar,
	create_navigation_menu,
	create_overlay_stack,
	create_panel_group,
	create_password_input,
	create_pointer_kind,
	create_preview,
	create_timeline,
	create_token_input,
	create_trigger_menu,
	create_velocity_tracker,
	create_waterfall,
	current_modality,
	format_color,
	fuzzy_score,
	hsl_to_rgb,
	hsv_to_rgb,
	invoke_control,
	is_focus_from_keyboard,
	keep_focus,
	match_ranges,
	match_segments,
	mix_colors,
	nearest_snap_point,
	parse_color,
	pointer_kind_of,
	rgb_to_hsl,
	rgb_to_hsv,
	rubber_band,
	settle_draft,
	step_spring
} from '../src/behaviors/index.ts';

it('scores fuzzy text matches and extracts highlight ranges and segments', () => {
	expect(fuzzy_score('', 'Invoice')).toBe(1);
	expect(fuzzy_score('inv', 'Invoice')).toBeGreaterThan(fuzzy_score('ice', 'Invoice'));
	expect(fuzzy_score('zzz', 'Invoice')).toBe(0);
	expect(match_ranges('cr', 'Create Record')).toEqual([{ start: 0, end: 2 }]);
	expect(match_ranges('cd', 'Create Record')).toEqual([
		{ start: 0, end: 1 },
		{ start: 12, end: 13 }
	]);
	const segments = match_segments('inv', 'Invoice List');
	expect(segments).toEqual([
		{ text: 'Inv', matched: true },
		{ text: 'oice List', matched: false }
	]);
});

it('covers gesture physics, spring stepping, velocity tracking, snap points and drawer state', () => {
	expect(rubber_band(0, 200)).toBe(0);
	expect(rubber_band(100, 200)).toBeGreaterThan(0);
	expect(rubber_band(100, 200)).toBeLessThan(100);
	expect(rubber_band(-100, 200)).toBeLessThan(0);

	const tracker = create_velocity_tracker();
	tracker.add(0, 1000);
	tracker.add(50, 1050);
	expect(tracker.velocity()).toBeGreaterThan(0);
	tracker.reset();
	expect(tracker.velocity()).toBe(0);

	expect(nearest_snap_point(0.3, 0, [0.25, 0.6, 1])).toBe(0.25);
	expect(nearest_snap_point(0.4, 0.004, [0.25, 0.6, 1])).toBe(1);

	let spring = { position: 0, velocity: 0, settled: false };
	for (let i = 0; i < 240 && !spring.settled; i++) {
		spring = step_spring(spring, 100);
	}
	expect(spring.settled).toBe(true);
	expect(spring.position).toBe(100);

	const stop = in_root(() => {
		const drawer = create_drawer({
			side: 'bottom',
			snap_points: [0.4, 0.9],
			label: 'Inspector',
			control: { id: 'parity-drawer' }
		});
		flushSync();
		expect(drawer.open).toBe(false);
		expect(invoke_control('parity-drawer', 'open').ok).toBe(true);
		flushSync();
		expect(drawer.open).toBe(true);
		expect(drawer.surface_attrs().role).toBe('dialog');
		expect(invoke_control('parity-drawer', 'snap', [0]).ok).toBe(true);
		flushSync();
		expect(drawer.snap_fraction).toBe(0.4);
		expect(invoke_control('parity-drawer', 'close').ok).toBe(true);
		flushSync();
		expect(drawer.open).toBe(false);
	});
	stop();
});

it('covers platform utilities: viewport, pointer/color scheme, modality, keep_focus, preview, settle_draft, cookies and overlay stack', async () => {
	const box = document.createElement('div');
	document.body.appendChild(box);
	const stopViewport = bind_viewport()(box);
	expect(box.style.getPropertyValue('--viewport-height')).toMatch(/px$/);
	stopViewport?.();

	const stopAvoid = bind_avoid_keyboard({ mode: 'padding' })(box);
	stopAvoid?.();

	expect(['coarse', 'fine']).toContain(pointer_kind_of().precision);
	expect(['light', 'dark']).toContain(color_scheme_of());
	expect(color_scheme_script('ui.theme')).toContain('ui.theme');

	const btn = document.createElement('button');
	const stopKeep = keep_focus()(btn);
	const pd = new Event('pointerdown', { cancelable: true });
	btn.dispatchEvent(pd);
	expect(pd.defaultPrevented).toBe(true);
	stopKeep?.();

	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
	expect(is_focus_from_keyboard()).toBe(true);
	expect(current_modality()).toBe('keyboard');
	window.dispatchEvent(new PointerEvent('pointerdown'));
	expect(is_focus_from_keyboard()).toBe(false);
	expect(current_modality()).toBe('pointer');

	expect(settle_draft({ a: 'v1', b: 'v2-edited' }, { a: 'v1', b: 'v2' })).toEqual({
		b: 'v2-edited'
	});

	const cookies = create_cookie_storage();
	cookies.set('nb_parity', 'ok');
	expect(cookies.get('nb_parity')).toBe('ok');
	cookies.remove('nb_parity');

	const ghost = document.createElement('div');
	let resolvedOverlay: string | undefined;
	const stop = in_root(() => {
		const pk = create_pointer_kind();
		expect(['coarse', 'fine']).toContain(pk.precision);
		const scheme = create_color_scheme({ storage_key: 'nb.parity.scheme', apply_class: false });
		scheme.set('dark');
		flushSync();
		expect(scheme.resolved).toBe('dark');

		let committed = 10;
		const preview = create_preview({
			value: () => committed,
			on_commit: (v) => {
				committed = v;
			}
		});
		preview.update(25);
		expect(preview.previewing).toBe(true);
		expect(preview.current).toBe(25);
		preview.cancel();
		expect(preview.current).toBe(10);
		preview.update(42);
		preview.commit();
		expect(committed).toBe(42);

		const stopGhost = bind_drag_preview({ point: () => ({ x: 20, y: 30 }) })(ghost);
		flushSync();
		expect(ghost.hidden).toBe(false);
		expect(ghost.style.transform).toContain('32px');
		stopGhost?.();

		const stack = create_overlay_stack<{ readonly title: string }, string>();
		const entry = stack.open({ title: 'Confirm' });
		expect(stack.count).toBe(1);
		expect(stack.top?.payload.title).toBe('Confirm');
		void entry.promise.then((res) => {
			resolvedOverlay = res;
		});
		stack.close(entry.id, 'confirmed');
		expect(stack.count).toBe(0);
	});
	await Promise.resolve();
	expect(resolvedOverlay).toBe('confirmed');
	stop();
	box.remove();
});

it('covers extra inputs: token input, trigger menu, checkbox group, file dropzone and password input', () => {
	const stop = in_root(() => {
		const tokens = create_token_input({
			default_value: ['alpha'],
			control: { id: 'parity-tokens' }
		});
		flushSync();
		tokens.add('beta');
		expect(tokens.values).toEqual(['alpha', 'beta']);
		tokens.add('alpha'); // duplicate ignored by default
		expect(tokens.values).toEqual(['alpha', 'beta']);
		expect(invoke_control('parity-tokens', 'add', ['gamma']).ok).toBe(true);
		flushSync();
		expect(tokens.values).toEqual(['alpha', 'beta', 'gamma']);
		tokens.remove_at(1);
		expect(tokens.values).toEqual(['alpha', 'gamma']);

		const pickedTriggers: string[] = [];
		const trigger = create_trigger_menu({
			triggers: ['@'],
			items: () => [
				{ id: 'u1', label: 'Alice' },
				{ id: 'u2', label: 'Bob' }
			],
			on_select: (item) => pickedTriggers.push(item.id)
		});
		const ta = document.createElement('textarea');
		const stopField = trigger.field(ta);
		ta.value = 'Hi @al';
		ta.selectionStart = ta.value.length;
		ta.selectionEnd = ta.value.length;
		const inputAttrs = trigger.input_attrs();
		const inputEvt = new Event('input');
		Object.defineProperty(inputEvt, 'currentTarget', { value: ta });
		inputAttrs.oninput(inputEvt);
		flushSync();
		expect(trigger.open).toBe(true);
		expect(trigger.items.map((i) => i.id)).toEqual(['u1']);
		trigger.input_attrs().onkeydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
		expect(pickedTriggers).toEqual(['u1']);
		stopField?.();

		const checks = create_checkbox_group({
			items: () => ['read', 'write', 'delete'],
			default_value: ['read'],
			label: 'Permissions',
			control: { id: 'parity-checks' }
		});
		flushSync();
		expect(checks.all_state).toBe('indeterminate');
		expect(checks.all_attrs()['aria-checked']).toBe('mixed');
		checks.toggle_all();
		expect(checks.all_state).toBe(true);
		expect(checks.checked).toEqual(['read', 'write', 'delete']);
		checks.toggle_all();
		expect(checks.all_state).toBe(false);

		const onFiles = vi.fn();
		const dz = create_file_dropzone({
			accept: ['.pdf', 'image/*'],
			max_bytes: 100,
			max_files: 1,
			on_files: onFiles
		});
		const okFile = new File(['abc'], 'doc.pdf', { type: 'application/pdf' });
		const badType = new File(['abc'], 'notes.txt', { type: 'text/plain' });
		const bigFile = new File(['x'.repeat(200)], 'huge.pdf', { type: 'application/pdf' });
		const extraFile = new File(['def'], 'second.pdf', { type: 'application/pdf' });
		dz.process([okFile, badType, bigFile, extraFile]);
		expect(onFiles).toHaveBeenCalledWith({
			accepted: [okFile],
			rejected: [
				{ file: badType, reason: 'type' },
				{ file: bigFile, reason: 'size' },
				{ file: extraFile, reason: 'count' }
			]
		});

		const pw = create_password_input({ label: 'Secret', control: { id: 'parity-pw' } });
		flushSync();
		expect(pw.input_attrs().type).toBe('password');
		expect(pw.input_attrs()['data-agent-secret']).toBe('');
		pw.toggle();
		expect(pw.input_attrs().type).toBe('text');
	});
	stop();
});

it('covers extra composite widgets, color math, cropper, waterfall, timeline and ARIA pattern checker', () => {
	const white = parse_color('#ffffff');
	const black = parse_color('#000000');
	const accent = parse_color('#3366cc');
	expect(white).not.toBeNull();
	expect(black).not.toBeNull();
	expect(accent).not.toBeNull();
	if (white !== null && black !== null && accent !== null) {
		expect(contrast_ratio(white, black)).toBeCloseTo(21, 0);
		expect(format_color(accent, 'hex')).toBe('#3366cc');
		expect(format_color(accent, 'rgb')).toContain('rgb(');
		expect(format_color(accent, 'hsl')).toContain('hsl(');
		expect(hsl_to_rgb(rgb_to_hsl(accent)).b).toBeGreaterThan(180);
		expect(hsv_to_rgb(rgb_to_hsv(accent)).b).toBeGreaterThan(180);
		expect(mix_colors(black, white, 0.5).r).toBe(128);
	}

	const stop = in_root(() => {
		const panels = create_panel_group({
			panels: [
				{ id: 'nav', default_size: 30, min_size: 15, max_size: 60 },
				{ id: 'main', default_size: 70, min_size: 40 }
			],
			control: { id: 'parity-panels' }
		});
		flushSync();
		expect(panels.sizes).toEqual([30, 70]);
		panels.handle_attrs(0).onkeydown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
		expect(panels.sizes[0]).toBe(32);
		expect(panels.sizes[1]).toBe(68);
		panels.reset();
		expect(panels.sizes).toEqual([30, 70]);

		const carousel = create_carousel({
			count: () => 3,
			loop: true,
			control: { id: 'parity-carousel' }
		});
		flushSync();
		expect(carousel.index).toBe(0);
		carousel.next();
		expect(carousel.index).toBe(1);
		carousel.prev();
		carousel.prev();
		expect(carousel.index).toBe(2);

		const menubar = create_menubar({
			menus: () => ['file', 'edit', 'view'],
			control: { id: 'parity-menubar' }
		});
		flushSync();
		menubar.open('file');
		expect(menubar.open_menu).toBe('file');
		menubar.trigger_attrs('edit').onpointerenter();
		expect(menubar.open_menu).toBe('edit');
		menubar.close();
		expect(menubar.open_menu).toBeNull();

		const navMenu = create_navigation_menu({
			items: () => ['products', 'docs'],
			control: { id: 'parity-nav' }
		});
		flushSync();
		navMenu.open('docs');
		expect(navMenu.is_open('docs')).toBe(true);
		navMenu.close();
		expect(navMenu.active).toBeNull();

		const hoverCard = create_hover_card({ open_delay: 0, close_delay: 0 });
		hoverCard.set_open(true);
		expect(hoverCard.open).toBe(true);
		hoverCard.set_open(false);
		expect(hoverCard.open).toBe(false);

		const picker = create_color_picker({ default_value: '#2563eb' });
		expect(picker.value).toBe('#2563eb');
		expect(picker.set_text('#10b981')).toBe(true);
		expect(picker.value).toBe('#10b981');

		const cropper = create_image_cropper({
			aspect: () => 1,
			control: { id: 'parity-cropper' }
		});
		flushSync();
		cropper.rotate(90);
		expect(cropper.rotation).toBe(90);
		cropper.set_zoom(2);
		expect(cropper.zoom).toBe(2);
		const px = cropper.pixel_crop(1000, 1000);
		expect(px.width).toBeGreaterThan(0);

		const wf = create_waterfall({
			items: () => [
				{ id: 'root', label: 'Request', start: 0, end: 100 },
				{ id: 'db', parent: 'root', label: 'SQL', start: 20, end: 70 }
			]
		});
		expect(wf.min).toBe(0);
		expect(wf.max).toBe(100);
		const rect = wf.bar_rect({ id: 'db', parent: 'root', label: 'SQL', start: 20, end: 70 });
		expect(rect.left_pct).toBeCloseTo(20, 1);
		expect(rect.width_pct).toBeCloseTo(50, 1);
		wf.zoom(20, 70);
		expect(wf.view_start).toBe(20);
		wf.reset_zoom();
		expect(wf.view_start).toBe(0);

		const timeline = create_timeline({
			items: () => ['e1', 'e2'],
			control: { id: 'parity-timeline' }
		});
		flushSync();
		timeline.toggle('e1');
		expect(timeline.is_expanded('e1')).toBe(true);
		expect(invoke_control('parity-timeline', 'collapse_all').ok).toBe(true);
		flushSync();
		expect(timeline.expanded).toEqual([]);
	});
	stop();

	// ARIA pattern checker & direction checker
	const host = document.createElement('div');
	host.setAttribute('dir', 'rtl');
	host.innerHTML = `<div role="tablist"><button role="tab" aria-selected="true" tabindex="0">One</button><button role="tab" aria-selected="false" tabindex="-1">Two</button></div>`;
	document.body.appendChild(host);
	expect(check_pattern(host, 'tabs')).toEqual([]);
	expect(check_direction(host, 'rtl')).toEqual([]);
	expect(check_direction(host, 'ltr').length).toBe(1);

	const bad = document.createElement('div');
	bad.innerHTML = `<div role="dialog"></div>`;
	expect(check_pattern(bad, 'dialog').length).toBe(1);
	host.remove();
});
