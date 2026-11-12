<script lang="ts">
	import { Button, Icon, ReadonlyMarkdown } from '@norbital-ai/ui';
	import type { AgentConversation } from '../../protocol/wire.ts';
	let { plan, place, starting, empty, running, on_revise, on_execute, on_discard, t }: {
		plan: NonNullable<AgentConversation['plan']>;
		place: 'current' | 'draft';
		starting: boolean;
		empty: boolean;
		running: boolean;
		on_revise: () => void;
		on_execute: () => void;
		on_discard: () => void;
		t: (key: string) => string;
	} = $props();
	let draftOpen = $state(false);
	const planState = (p: NonNullable<AgentConversation['plan']>) =>
		p.status === 'draft' ? t('Planning') : p.status === 'active' ? t('Executing') : t('Verified');
	const planTitle = (body: string) =>
		(
			body.split('\n').find((l) => /^#{1,3}\s+\S/.test(l.trim())) ??
			body.split('\n').find((l) => l.trim() !== '') ??
			''
		)
			.replace(/^#+\s*/, '')
			.trim();
</script>

{#if place === 'current'}
						<!-- Current work strip: the executed plan the agent works from, kept in view while the transcript scrolls; it opens
		over the transcript, not into it -->
						<div class="relative z-20 mx-auto w-full agent-column shrink-0 px-4 pt-3" data-now-strip>
							<div
								class="grid gap-1 rounded-xl border border-border/70 bg-background/95 px-3 py-2 backdrop-blur"
							>
								<details class="group/plan" data-plan={plan.status}>
									<summary
										class="flex cursor-pointer list-none items-center gap-2 rounded text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
									>
										<Icon
											name={plan.status === 'verified'
												? 'lucide:circle-check'
												: 'lucide:notebook-pen'}
											class="size-3.5 shrink-0 text-muted-foreground"
										/>
										<span class="min-w-0 flex-1 truncate font-medium"
											>{planTitle(plan.body) || t('Plan')}</span
										>
										<span class="shrink-0 text-muted-foreground"
											>{t('Plan')} {plan.revision} · {planState(plan)}</span
										>
									</summary>
									<div
										class="absolute inset-x-4 top-full mt-1 max-h-[50dvh] overflow-auto rounded-xl border border-border/70 bg-background px-3 py-2 text-xs shadow-deep"
									>
										<ReadonlyMarkdown value={plan.body} />
										<div class="mt-2 flex justify-end gap-1 border-t border-border/60 pt-2">
											{#if plan.status === 'active'}<Button
													variant="ghost"
													disabled={!empty}
													onclick={on_revise}>{t('Revise plan')}</Button
												>{/if}
											<Button
												variant="ghost"
												onclick={on_discard}
												>{t('Delete plan')}</Button
											>
										</div>
									</div>
								</details>
							</div>
						</div>
{:else}
<!-- Draft plan: a collapsed card above the prompt, reviewed by expanding it, executed or deleted from its header -->
					<div class="mx-auto w-full agent-column shrink-0 px-4 pb-3" data-draft-plan>
						<section
							class="rounded-lg border border-border bg-muted/20"
							aria-label={t('Draft plan')}
							aria-busy={starting}
						>
							<div class="flex items-center gap-1 px-2 py-1.5">
								<Button
									variant="ghost"
									class="min-w-0 px-1"
									aria-expanded={draftOpen}
									onclick={() => (draftOpen = !draftOpen)}
								>
									<Icon
										name="lucide:chevron-down"
										class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {draftOpen
											? 'rotate-180'
											: ''}"
									/>
									<span class="truncate">{t('Draft plan')}</span>
								</Button>
								<span
									class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
									title={`${t('Revision')} ${plan.revision}`}>r{plan.revision}</span
								>
								<Button
									size="icon"
									variant="ghost"
									class="shrink-0"
									aria-label={t('Delete plan')}
									title={t('Delete plan and return to Agent mode')}
									disabled={starting}
									onclick={on_discard}
								>
									<Icon name="lucide:trash-2" class="size-3.5" />
								</Button>
								<Button
									class="shrink-0 px-2"
									aria-label={starting ? t('Starting…') : t('Execute plan')}
									disabled={starting || running || !empty}
									onclick={on_execute}
									data-execute-plan
								>
									<Icon
										name={starting ? 'lucide:loader-circle' : 'lucide:play'}
										class="size-3.5 {starting ? 'animate-spin motion-reduce:animate-none' : ''}"
									/>
									<span aria-live="polite">{starting ? t('Starting…') : t('Execute')}</span>
								</Button>
							</div>
							{#if draftOpen}
								<div
									class="overflow-auto border-t border-border/60 px-3 py-2 text-sm leading-relaxed"
									style="height: 28dvh"
								>
									<ReadonlyMarkdown value={plan.body} />
								</div>
							{/if}
						</section>
					</div>
{/if}

<style>
	.agent-column { max-width: var(--agent-column-width); }
</style>
