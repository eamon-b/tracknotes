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

A run deploys `main` as it is when the run starts, not the commit that triggered it.
Its first job reads `main`'s head (the GitHub API) and checks that out: a run that queued behind another, or a re-run of an old one, deploys the newest code rather than putting older code back, and a merge after it that did not touch the trigger paths (so started no run of its own) cannot leave it undeployed.
Its summary names the commit it deployed, and a run whose `main` has moved on says so there and in a notice.
The data workflows pass the commit their `plan` job resolved to the `publish` or `upload` job, so what is approved is exactly what was planned.
Runs of one workflow never overlap (`concurrency`, not cancelled in progress); a newer queued run replaces an older queued one, which is fine, since it deploys a `main` that includes it.
`publish:trail-data` also re-checks its own guards against the live catalog at publish time (a rollback, a checkout that does not contain the live publish's commit, a dropped trail), so a late approval cannot publish over a newer publish.
Its `plan` job first rebuilds the trail data (`sync:te-araroa`, `build:trails`, `build:mobile-trails`) and fails if that changes anything, since those guards compare against the live catalog, not against the sources.
`--hold` is an input of *Run workflow*: to hold a trail back from a push's publish (a new trail not ready for every installed app, #289), reject that run's deployment, then *Run workflow* with `hold` set.

Every merge that touches `src/lib/` redeploys the comments API (and runs `migrate:remote`, usually a no-op), since the worker bundles `@lib`; most of those deploys change nothing, and are not a fault.

**Migrations are additive.**
*Deploy comments API* applies pending migrations and then deploys, so between the two the running worker is the old code on the new schema.
Every migration must keep the deployed worker working: add tables, columns and indexes (expand), and remove what the old code reads only in a later release, once no deployed worker reads it (contract).
The deploy job refuses any pending migration that drops or renames anything (a SQLite table rebuild, as `0008` was, does both), and the run fails before applying it.
Apply such a migration by hand, at a moment you choose: from `main`, `cd workers/comments-api && npm run migrate:remote && npm run deploy`, then `scripts/probe-comments-api.sh`, then re-run the workflow, which then finds nothing to apply.

Credentials are passed only to the steps that call Cloudflare or the API, never to `npm ci` or the tests.

What still needs a person:

- A failed run. The *Deploy comments API* summary lists the probes; a probe that fails after a deploy means the deploy happened but a route is missing.
  *Deploy tile workers* deploys the dataset's Worker and then the app's, with no rollback: if the second fails, the two run different code until a re-run succeeds.
- A destructive migration (above), applied by hand.
- When a migration adds routes, add a probe to `scripts/probe-comments-api.sh`.
- Approving trail data and description runs.
- A worker change and the description or trail data change that needs it, merged together: the workflows run side by side, so approve the data run only once *Deploy comments API*'s `deploy` job has succeeded.

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
