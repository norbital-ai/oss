<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Option, Stream } from 'effect';
	import { getContext } from 'svelte';
	import { watch } from 'runed';
	import { ConversationsReadAnswer, TranscriptReadAnswer } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import { endingSound, settled } from './chime.ts';
	import { SOUNDS, type SoundKind, type Sounds } from '../sounds.ts';

	let {
		bolt,
		active,
		on_ended
	}: { bolt: ShellBolt; active: string | null; on_ended: (kind: SoundKind) => void } = $props();
	const chime = getContext<Sounds>(SOUNDS);
	const ended = settled();
	const conversations = observe(() =>
		bolt.observe({ read: { m: 'conversations', a: [] } }, ConversationsReadAnswer)
	);
	watch(
		() => $conversations,
		(answer) => {
			if (answer === undefined) return;
			for (const { id, since } of ended(answer.rows)) {
				if (id === active) continue;
				fork(
					bolt
						.observe({ read: { m: 'transcript', a: [id, { tail: 10 }] } }, TranscriptReadAnswer)
						.pipe(
							Stream.take(1),
							Stream.runHead,
							Effect.tap((answer) =>
								Effect.sync(() => {
									if (Option.isNone(answer)) return;
									const kind = endingSound(answer.value.rows, since);
									if (kind === null) return;
									chime.play(kind);
									on_ended(kind);
								})
							),
							Effect.asVoid
						),
					() => {}
				);
			}
		}
	);
</script>
