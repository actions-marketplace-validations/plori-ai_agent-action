# Plori agent review

Give each repository a persistent review workspace. The agent checks out the exact pull-request commits, reads the surrounding code, and can run targeted tests instead of judging a diff in isolation.

## Quick start

```yaml
name: Plori review
on: {pull_request: {types: [opened, synchronize, reopened]}}
jobs:
  review:
    permissions: {contents: read, id-token: write, pull-requests: write}
    uses: plori-ai/agent-action/.github/workflows/review.yml@v1
```

That is the recommended integration. The called workflow deliberately splits the work:

- `agent` can mint a Plori OIDC capability and gets only `contents: read`. Its job token is available in the remote workspace for this turn only, so the agent can clone the repository; Plori does not persist it.
- `comment` gets `pull-requests: write`, but no OIDC permission and no path to the agent. It creates one marker comment and edits that comment on later commits.

The separation is the security boundary. Do not collapse both steps into a job with a write-capable token.

## What happens

For an unclaimed public repository, GitHub's signed workload identity creates or resumes one repository-scoped agent. The first three runs per repository are free, within a limit of ten free runs per GitHub owner per UTC month. The agent, disk, conversation history, and private memory remain attached to that repository.

Private repositories and exhausted free quotas return a signed claim link. The workflow posts that link and exits successfully; after an owner claims the repository, rerunning continues with the same agent and disk. No signup, API key, or GitHub App is required for the default path.

The default prompt asks the agent to fetch the exact base and head commits, inspect callers and contracts, and run the smallest relevant checks. It reports a finding only when the current diff introduces a concrete failure or contract violation that the agent can support with evidence. Repository content is treated as untrusted. The agent cannot push, approve, merge, or post a comment.

The reviewer favors precision over volume. It leaves out style preferences, speculative edge cases, and unrelated cleanup. Nits are omitted by default. If a useful polish suggestion remains, the review labels it as optional and non-blocking. A sound change receives `No actionable findings.` instead of a manufactured objection.

Each review is a batch run. It never pauses for a question, approval, or credential. If the agent cannot finish, the Action fails instead of reporting an empty review as a success. Push another commit or rerun the workflow to request a new review; replying to the review comment does not resume the agent.

## Customize the review

Pass extra maintainer instructions to the reusable workflow:

```yaml
jobs:
  review:
    permissions: {contents: read, id-token: write, pull-requests: write}
    uses: plori-ai/agent-action/.github/workflows/review.yml@v1
    with:
      prompt: Focus on migration rollback safety and API compatibility.
```

The custom text is appended to the safety-preserving default prompt; it does not replace it.

## Manual API-key fallback

GitHub Enterprise Server does not mint tokens from GitHub.com's Actions OIDC issuer. A claimed Plori repository can instead pass an `agent-id` input and a `PLORI_API_KEY` reusable-workflow secret. Keep the job's repository token read-only. The API key is an account credential, so prefer OIDC on GitHub.com and never expose it to pull requests from untrusted forks.

## Fork pull requests

GitHub may downgrade `GITHUB_TOKEN` permissions for workflows triggered from forks. The remote review still runs when OIDC and repository read access are available, but GitHub can reject the summary comment. The review remains visible in the `agent` job summary; do not switch to `pull_request_target` merely to recover comment permission.

## Direct Action usage

Advanced callers may use `plori-ai/agent-action@v1` directly in a job with only `contents: read` and `id-token: write`. Pass `${{ github.token }}` as `repository-token`. Direct mode returns `review`, `outcome`, `claim-url`, `run-id`, and `session-id` outputs and writes the result to the job summary. It intentionally does not post a PR comment. Use the reusable workflow when you need the isolated comment job.

## Data and credentials

- GitHub verifies the repository identity; Plori accepts only OIDC tokens whose issuer is GitHub Actions and whose audience is `plori.ai`.
- The exchanged `plori_ghr_` capability starts one run on one repository agent and can poll only that run.
- The job token is exposed to commands as `GITHUB_TOKEN` and `GH_TOKEN`. Git reads it through an environment-backed credential helper, so the token value is not written to the workspace, conversation, agent configuration, or database.
- The Action has no GitHub App and Plori holds no GitHub write credential.
- Usage telemetry records repository-scoped installs/exchanges and claims so aggregate activation and week-two retention can be evaluated. It does not add tracking parameters to repository URLs.

See [Plori's API documentation](https://plori.ai/docs/api) for the underlying OIDC and claim contracts.
