/** Preserve continuity when a record section changes versions or receives new values. */
export function contentMotion(node: HTMLElement) {
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
	const active = new Set<Animation>();
	const play = (target: HTMLElement, frames: Keyframe[], duration = 220) => {
		if (reduced.matches || typeof target.animate !== 'function' || !target.isConnected) return;
		const animation = target.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)' });
		active.add(animation);
		void animation.finished.then(
			() => active.delete(animation),
			() => active.delete(animation)
		);
	};
	let observed = node.firstElementChild;
	const FIELDS = 'dd,td,li,[data-field]';
	// A field is known from when it is first seen: one filled while its section is closed, or still rendering just after
	// it opens, is structure, not a change. Only a field seen for a moment flashes.
	const SETTLE_MS = 600;
	const seen = (field: HTMLElement) =>
		typeof field.checkVisibility === 'function' ? field.checkVisibility() : true;
	const known = new Map<HTMLElement, number>(
		[...node.querySelectorAll<HTMLElement>(FIELDS)].filter(seen).map((field) => [field, 0])
	);
	const changes = new MutationObserver((records) => {
		const next = node.firstElementChild;
		if (resize && next !== observed) {
			if (observed) resize.unobserve(observed);
			observed = next;
			if (observed) resize.observe(observed);
		}
		// The record shell handles field changes across section mounts; nested sections only animate height.
		if (node.matches('[data-section] [id]') && node.closest('[data-view=record]')) return;
		// A field that arrives with a mounted tab, a virtualised row or a newly opened section is structure, not a value
		// change: only known fields whose contents mutate flash. New fields join the known set for later updates.
		const inserted = new Set<HTMLElement>();
		for (const record of records)
			for (const added of record.addedNodes) {
				if (!(added instanceof HTMLElement)) continue;
				if (added.matches(FIELDS)) inserted.add(added);
				for (const field of added.querySelectorAll<HTMLElement>(FIELDS)) inserted.add(field);
			}
		const now = performance.now();
		for (const field of inserted) if (seen(field)) known.set(field, now);
		const fields = new Set<HTMLElement>();
		for (const record of records) {
			const element =
				record.target instanceof HTMLElement ? record.target : record.target.parentElement;
			const field = element?.closest<HTMLElement>(FIELDS);
			if (!field || inserted.has(field) || !node.contains(field)) continue;
			const since = known.get(field);
			if (since === undefined) {
				if (seen(field)) known.set(field, now);
			} else if (now - since > SETTLE_MS) fields.add(field);
		}
		for (const field of fields)
			play(
				field,
				[
					{ backgroundColor: 'var(--accent)' },
					{ backgroundColor: 'var(--accent)', offset: 0.35 },
					{ backgroundColor: 'transparent' }
				],
				700
			);
	});
	changes.observe(node, { childList: true, characterData: true, subtree: true });
	let height = node.firstElementChild?.getBoundingClientRect().height ?? 0;
	const resize =
		typeof ResizeObserver === 'undefined' || node.matches('[data-view=record]')
			? null
			: new ResizeObserver(([entry]) => {
					if (!entry) return;
					const next = entry.contentRect.height;
					if (height > 0 && next > 0 && Math.abs(next - height) > 1)
						play(node, [
							{ height: `${height}px`, overflow: 'clip' },
							{ height: `${next}px`, overflow: 'clip' }
						]);
					height = next;
				});
	if (observed) resize?.observe(observed);
	const cancel = () => {
		if (reduced.matches) for (const animation of active) animation.cancel();
	};
	reduced.addEventListener('change', cancel);
	return {
		destroy() {
			changes.disconnect();
			resize?.disconnect();
			reduced.removeEventListener('change', cancel);
			for (const animation of active) animation.cancel();
		}
	};
}
