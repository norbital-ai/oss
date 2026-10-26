<!--
	Settings → Audit rules (§5 "Audit: rules are an organization's data"), an administrator's: every rule grouped by
	pack with its summary, principles, rationale and its bad and good examples as code, a state per rule (error, hint,
	off), the organization's path scopes and its own rules. Edits are a draft: Save stores it over the revision it read
	(the host compiles every own rule first and answers the compiler's message if one fails), Try audits the head with
	the draft unsaved, Audit with the saved rules. Each finding links to its rule. Exceptions stay in the source
	(`repository-health:allow <rule> -- <reason>`, `.doctorignore`), never here.
-->
<script lang="ts">
	import { Badge, Button, CodeEditor, Icon, Spinner, Textarea } from '@norbital-ai/ui';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		byPack,
		ignoreText,
		ownText,
		withIgnore,
		withOwn,
		withState,
		type AuditRuleSet,
		type AuditRuleState,
		type StudioAudit,
		type StudioAuditRule,
		type StudioAuditRules
	} from './audit.ts';

	let {
		rules,
		audit,
		busy = false,
		error = null,
		onsave,
		ontry,
		onaudit,
		onopen,
		t
	}: {
		/** The saved set under its catalogue; absent while it loads. */
		rules: StudioAuditRules | undefined;
		/** The last audit (Try or Audit) of the head. */
		audit?: StudioAudit | undefined;
		busy?: boolean;
		/** The host's refusal of the last save (a rule that does not compile, a save that landed first). */
		error?: string | null;
		onsave: (revision: number, ruleSet: AuditRuleSet) => void;
		ontry: (ruleSet: AuditRuleSet) => void;
		onaudit: () => void;
		/** Opens a finding's file. */
		onopen: (path: string) => void;
		t: (key: string) => string;
	} = $props();

	// the draft follows each newly read revision; an edit overrides it until the next one
	let draft = $derived<AuditRuleSet | undefined>(rules?.ruleSet);
	let own = $derived(rules === undefined ? '' : ownText(rules.ruleSet));
	const parsedOwn = $derived(draft === undefined ? undefined : withOwn(draft, own));
	const ownError = $derived(
		parsedOwn !== undefined && 'error' in parsedOwn ? parsedOwn.error : null
	);
	/** The draft with the own rules' editor text applied; undefined while that text is not a rule list. */
	const edited = $derived(
		parsedOwn !== undefined && 'ruleSet' in parsedOwn ? parsedOwn.ruleSet : undefined
	);
	const dirty = $derived(
		rules !== undefined &&
			edited !== undefined &&
			JSON.stringify(edited) !== JSON.stringify(rules.ruleSet)
	);
	const STATES: readonly { state: AuditRuleState; label: string }[] = [
		{ state: 'error', label: 'Error' },
		{ state: 'hint', label: 'Hint' },
		{ state: 'off', label: 'Off' }
	];
	const stateOf = (rule: StudioAuditRule): AuditRuleState =>
		draft?.states[rule.id] ?? rule.severity;
	const set = (rule: StudioAuditRule, state: AuditRuleState) => {
		if (draft !== undefined) draft = withState(draft, rule, state);
	};
	const pathOf = (location: string) => location.split(':')[0] ?? location;
</script>

{#snippet code(label: string, examples: readonly string[], bad: boolean)}
	<Stack gap="xs">
		<p class="text-micro font-medium {bad ? 'text-destructive' : 'text-muted-foreground'}">
			{t(label)}
		</p>
		{#each examples as example, i (i)}
			<pre
				class="rounded border border-border/60 bg-muted/40 p-2 font-mono text-micro whitespace-pre-wrap text-foreground">{example}</pre>
		{/each}
	</Stack>
{/snippet}

{#if rules === undefined || draft === undefined}
	<p class="inline-flex items-center gap-1.5 p-4 text-meta" role="status">
		<Spinner class="size-3" />{t('Reading the audit rules…')}
	</p>
{:else}
	<Scroll name={t('Audit rules')} class="h-full">
		<Stack gap="lg" class="p-4 sm:p-6" data-audit-rules>
			<Cluster gap="sm" align="start" justify="between">
				<Stack gap="xs" class="min-w-0">
					<h2 class="text-sm font-semibold text-foreground">{t('Audit rules')}</h2>
					<p class="text-meta">
						{t('Revision')}
						{rules.revision} · doctor {rules.version} · {rules.digest.slice(0, 12)}
					</p>
				</Stack>
				<Cluster gap="sm" justify="end">
					<Button
						size="sm"
						variant="outline"
						disabled={busy || edited === undefined}
						onclick={() => edited !== undefined && ontry(edited)}
						><Icon name="lucide:flask-conical" class="size-3.5" />{t('Try')}</Button
					>
					<Button size="sm" variant="outline" disabled={busy} onclick={onaudit}
						><Icon name="lucide:stethoscope" class="size-3.5" />{t('Audit')}</Button
					>
					<Button
						size="sm"
						disabled={busy || !dirty}
						onclick={() => edited !== undefined && onsave(rules.revision, edited)}
						>{#if busy}<Spinner class="size-3" />{/if}{t('Save')}</Button
					>
				</Cluster>
			</Cluster>
			{#if error !== null}
				<p class="text-xs whitespace-pre-wrap text-destructive" role="alert">{error}</p>
			{/if}
			{#each rules.errors as failed (failed.id)}
				<p class="text-xs text-destructive" role="alert">
					{failed.id}: {failed.message}
				</p>
			{/each}

			{#if audit !== undefined}
				<Stack gap="sm" aria-label={t('Findings')}>
					<h3 class="text-xs font-semibold text-foreground">
						{t('Findings')} ({audit.findings.length}) · {audit.commit.slice(0, 12)}
					</h3>
					<Stack as="ul" gap="none" divided>
						{#each audit.findings as finding, i (i)}
							<li
								class="border-l-2 py-1.5 pl-2 {finding.severity === 'hint'
									? 'border-l-amber-600'
									: 'border-l-destructive'}"
							>
								<Stack gap="xs">
									<Inline gap="sm">
										<a
											class="text-micro font-medium text-primary hover:underline"
											href="#rule-{finding.rule}">{finding.rule}</a
										>
										<span class="text-xs text-foreground">{finding.summary}</span>
									</Inline>
									<button
										type="button"
										class="text-left font-mono text-micro text-muted-foreground hover:underline"
										onclick={() => onopen(pathOf(finding.location))}>{finding.location}</button
									>
								</Stack>
							</li>
						{/each}
					</Stack>
				</Stack>
			{/if}

			<Stack gap="sm">
				<h3 class="text-xs font-semibold text-foreground">{t('Paths the audit skips')}</h3>
				<p class="text-meta">{t('One glob per line, for every rule, e.g. vendor/**.')}</p>
				<Textarea
					value={ignoreText(draft)}
					oninput={(event) => {
						if (draft !== undefined) draft = withIgnore(draft, event.currentTarget.value);
					}}
					rows={3}
					class="font-mono text-xs"
					aria-label={t('Paths the audit skips')}
				/>
			</Stack>

			{#each byPack(rules.rules) as [pack, members] (pack)}
				<Stack gap="sm">
					<h3 class="text-xs font-semibold text-foreground">
						{pack === 'organization' ? t('Your rules') : pack} ({members.length})
					</h3>
					<Stack as="ul" gap="none" divided class="border-y border-border/50">
						{#each members as rule (rule.id)}
							{@const current = stateOf(rule)}
							<li id="rule-{rule.id}" class="py-3">
								<Stack gap="sm">
									<Cluster gap="sm" align="start" justify="between">
										<Stack gap="xs" class="min-w-0">
											<p class="font-mono text-xs font-semibold text-foreground">{rule.id}</p>
											<p class="text-xs text-foreground">{rule.summary}</p>
											<Cluster gap="xs">
												{#each rule.principles as principle (principle)}
													<Badge variant="outline">{principle}</Badge>
												{/each}
											</Cluster>
										</Stack>
										<Inline gap="xs" role="radiogroup" aria-label={t('State')}>
											{#each STATES as option (option.state)}
												<Button
													size="sm"
													variant={current === option.state ? 'default' : 'outline'}
													class="px-2 text-micro"
													role="radio"
													aria-checked={current === option.state}
													disabled={busy}
													onclick={() => set(rule, option.state)}>{t(option.label)}</Button
												>
											{/each}
										</Inline>
									</Cluster>
									{#if rule.rationale !== undefined}
										<p class="text-xs whitespace-pre-wrap text-muted-foreground">
											{rule.rationale}
										</p>
									{/if}
									{#if rule.files !== undefined}
										<p class="font-mono text-micro text-muted-foreground">
											{rule.files.join(', ')}
										</p>
									{/if}
									{@render code('Reported', rule.examples.bad, true)}
									{@render code('Not reported', rule.examples.good, false)}
								</Stack>
							</li>
						{/each}
					</Stack>
				</Stack>
			{/each}

			<Stack gap="sm">
				<h3 class="text-xs font-semibold text-foreground">{t('Edit your rules')}</h3>
				<p class="text-meta">
					{t(
						'A JSON array of rules in the platform packs’ schema: id, summary, severity, principles, files, rule (ast-grep’s rule language) and examples with bad and good code.'
					)}
				</p>
				<CodeEditor
					value={own}
					onChange={(next) => (own = next)}
					language="json"
					invalid={ownError !== null}
					minHeight="8rem"
					aria-label={t('Edit your rules')}
				/>
				{#if ownError !== null}
					<p class="text-xs text-destructive">{t(ownError)}</p>
				{/if}
			</Stack>
		</Stack>
	</Scroll>
{/if}
