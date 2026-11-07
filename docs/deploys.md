# Deploys from GitHub Actions

Four workflows deploy or publish from `main` after a merge, so none of these is a manual step any more.
The site is not among them: Vercel builds `main` on push.

| Workflow | Runs on a push to `main` that changes | Does | Environment |
| --- | --- | --- | --- |
| `deploy-comments-api.yml` | `workers/comments-api/**`, `src/lib/**` (the worker bundles `@lib`) | tests and `tsc`, `migrate:remote`, `deploy`, then `scripts/probe-comments-api.sh` | `production` |
| `deploy-tile-workers.yml` | `contours/worker/**` | the worker's tests and `tsc`, `wrangler deploy` (tiles.contour-map-tiles.net) and `wrangler deploy --env app` (tiles.tracknotes.info), then both `/health` | `production` |
| `publish-trail-data.yml` | `mobile/assets/trails/**` | a dry run of `publish:trail-data`, then, once approved, the publish and `--check` | `production-data` |
| `upload-descriptions.yml` | `data/trails/*/descriptions.json` | a dry run of `upload:descriptions` against the live API, then, once approved, the upload | `production-data` |

Each also has *Run workflow* (Actions → the workflow), for a re-deploy or a first run;
it runs from `main` only.
A change to a workflow file alone does not trigger it: use *Run workflow* to try one.

## How they behave

The workers deploy without a reviewer: the same tests as the *Tests* workflow run first, in the deploy job, and an unapplied migration or an undeployed route is the failure this exists to prevent (#141).
Trail data and descriptions reach every installed app, so each waits for a reviewer.
Its `plan` job runs the dry run without credentials and puts it in the run's summary;
nothing to publish means no `publish` job and nothing to approve.
Approve under the run's *Review deployments*, which the GitHub mobile app shows too.

A run deploys only the commit at the head of `main`.
Each starts with a check of `main`'s head (the GitHub API): a run for a commit `main` has moved past, a re-run of an old one, or one that queued behind a newer merge, ends with a notice and deploys nothing, since the newer commit's own run deploys.
Runs of one workflow never overlap (`concurrency`, not cancelled in progress).
`publish:trail-data` also re-checks its own guards against the live catalog at publish time (a rollback, a checkout that does not contain the live publish's commit, a dropped trail), so a late approval cannot publish over a newer publish;
`--hold` is an input of *Run workflow*.

Credentials are passed only to the steps that call Cloudflare or the API, never to `npm ci` or the tests.

What still needs a person:

- A failed run. The *Deploy comments API* summary lists the probes; a probe that fails after a deploy means the deploy happened but a route is missing.
- When a migration adds routes, add a probe to `scripts/probe-comments-api.sh`.
- Approving trail data and description runs.
- A worker change and the description or trail data change that needs it, merged together: the workflows run side by side, so approve the data run only once *Deploy comments API* is green.

## Setup

Both environments are under Settings → Environments.
Restrict each one's *Deployment branches and tags* to `main`, so no other branch's workflow can read its secrets.

**`production`** (the workers), no required reviewers:

- `CLOUDFLARE_API_TOKEN`: a token from Cloudflare's *Edit Cloudflare Workers* template, plus *Account → D1 → Edit* (migrations), limited to the account, with zone resources `tracknotes.info` and `contour-map-tiles.net` (the Workers' custom domains).
- `CLOUDFLARE_ACCOUNT_ID`.

**`production-data`** (trail data and descriptions), with yourself as a required reviewer:

- `CLOUDFLARE_API_TOKEN`: a token with *Account → Workers R2 Storage → Edit*, limited to the account (`publish:trail-data` puts objects with `wrangler r2 object put`).
- `CLOUDFLARE_ACCOUNT_ID`.
- `TRACKNOTES_ADMIN_TOKEN`: the comments API's admin bearer token.

Give each token an expiry you will notice, and replace it in the environment before then.
A personal `wrangler login` still works for anything run by hand.

## Running by hand

The commands in the runbooks still work from a checkout (`docs/mobile-test-build.md` "Full release", `docs/trail-data-updates.md`, `docs/architecture/build-scripts.md`).
Deploy only from `main`, as the workflows do.
