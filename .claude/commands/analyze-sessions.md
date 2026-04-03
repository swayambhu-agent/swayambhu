Analyze Swayambhu's recent sessions. Run the data gathering script, then
perform an exhaustive analysis of every aspect of agent behavior.

## Step 1: Gather data

```bash
node scripts/analyze-sessions.mjs --last $ARGUMENTS 2>/dev/null
```

Default $ARGUMENTS is 10 if not specified. Save the full output — you'll
reference it throughout the analysis.

## Step 2: Executive summary

Before diving into details, output a concise summary (5-10 bullet points)
of the key findings. Scan all the data first, then report:

- **Session count & time span** — how many ticks, over what period
- **Overall health** — is the pipeline working end-to-end or broken?
- **Top issues** — the 2-3 most important problems (errors, failures, gaps)
- **Budget** — total cost, is it reasonable?
- **DR status** — did deep reflect run? Did it produce useful output?
- **Cognitive quality** — one-line verdict on desire/samskara/plan quality
- **What's working well** — anything that's functioning as designed

This summary should let someone skip the rest and still know what matters.
Use a markdown header `### Key Findings` for this section.

## Step 3: Tick-by-tick analysis

For EACH karma record (tick), analyze in order:

### Act phase
- Did the plan phase produce an action or no_action?
- If action: is it desire-motivated? Tool-grounded? Completable?
- If no_action: is the reason valid given current desires and circumstances?
- Did the act phase execute? How many steps? Did it hit budget limits?
- Did tool calls succeed or fail? Which tools? What errors?
- Were there model fallbacks (provider_fallback events)?

### Eval phase
- Which eval tier ran (embeddings → NLI → LLM)?
- What sigma (alignment signal) was produced?
- What salience score? Was an experience written?
- Were samskara strengths updated?

### Review phase
- Did review produce output or was there a parse failure?
- What assessment/narrative was generated?

### DR phase
- Was drCycle invoked? What happened?
- If dispatched: job ID, what context was sent?
- If polled: was the job complete? Did parsing succeed?
- If applied: what desires/samskaras were created/modified/retired?
- If failed: why? Transient or structural?

### Memory writes
- Was an action record written to action:{id}?
- Was an experience written to experience:{timestamp}?
- Were samskara strengths updated?

## Step 4: Cross-cutting analysis

After all ticks, analyze these dimensions across the full session history:

### Pipeline health
- Which phases are working end-to-end?
- Which phases are broken or producing no output?
- Any systematic failures (same error recurring)?

### Cognitive quality
- Are desires concrete and NLI-evaluable? Or abstract principle restatements?
- Are samskaras capturing real patterns or bootstrap platitudes?
- Are plans driven by desires or inventing work?
- Is the eval signal meaningful or defaulting?

### Budget efficiency
- Total cost across all ticks (OpenRouter only — agent's operating budget)
- Cost breakdown: plan vs act vs eval vs review
- DR runs on Akash via Anthropic subscription — zero cost to agent budget. Do NOT include DR/Akash costs in budget analysis.
- Any wasted tokens (retries, fallbacks, parse failures)?
- Model selection: right model for each phase?

### Model issues
- Any provider_fallback events? Which models failed?
- Parse failures: which phase, which model?
- Are cheap models (minimax, deepseek) adequate for plan/act?
- Are expensive models being used where cheap ones would suffice?

### DR effectiveness
- Did DR produce good desires? (NLI test: are they evaluable?)
- Did DR produce good samskaras? (Real patterns vs platitudes?)
- Is the DR prompt producing the right output structure?
- Is the full lifecycle working? (dispatch → complete → parse → apply)

### Configuration issues
- Are intervals appropriate?
- Budget limits: too tight? Too loose?
- Model assignments: right models for each phase?
- Any missing config that's falling back to defaults?

## Step 5: Issue summary

Categorize findings:

**Errors** — things that broke (parse failures, tool errors, KV errors)
**Suboptimal** — things that worked but poorly (bad plans, wasted tokens, wrong models)
**Missing** — things that should happen but don't (no experiences written, no samskara updates)
**Design gaps** — architectural issues revealed by the session data

For each finding, include:
- What happened (with karma event references)
- Why it matters
- Suggested fix (code change, config change, or prompt change)

## Step 6: Akash job inspection (if DR ran)

If any DR jobs were dispatched, check the akash compute target:

```bash
node -e "
const { execSync } = require('child_process');
const envStr = execSync('bash -c \"set -a && source .env && env\"', { encoding: 'utf8' });
const env = {};
for (const line of envStr.split('\n')) {
  const idx = line.indexOf('=');
  if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1);
}
const baseUrl = 'https://akash.swayambhu.dev';
const headers = {
  'Content-Type': 'application/json',
  'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  'Authorization': 'Bearer ' + env.COMPUTER_API_KEY,
};
async function run(cmd) {
  const resp = await fetch(baseUrl + '/execute?wait=10', {
    method: 'POST', headers,
    body: JSON.stringify({ command: cmd }),
  });
  return resp.json();
}
run('ls -la /home/swayambhu/jobs/ && echo --- && for d in /home/swayambhu/jobs/j_*/; do echo \$d; cat \$d/exit_code 2>/dev/null || echo NO_EXIT; ls -la \$d/output.json 2>/dev/null || echo NO_OUTPUT; tail -5 \$d/stderr.log 2>/dev/null || echo NO_STDERR; echo; done').then(r => {
  console.log(r.output?.map(o => o.data || '').join(''));
});
"
```

For each job: check exit_code, output.json size, stderr.log content.
