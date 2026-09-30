# Running The Fold locally, and verifying the Twenty assumptions (M0)

Everything The Fold does with Twenty rests on assumptions taken from documentation and source we could not
run in the environment this was written in. `docs/verification-status.md` lists each one. **This is how to
turn them into facts.** It takes about 20 minutes.

## 1. Start the stack

```sh
cp infra/.env.example infra/.env        # fill in the three secrets (openssl rand -base64 32)
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker compose -f infra/docker-compose.yml --env-file infra/.env ps      # wait until twenty-server is healthy
```

Open http://localhost:3000, create the first workspace and an admin user. Mail lands in http://localhost:8025.

## 2. Install the app (Node 24 required by `twenty-sdk`)

```sh
nvm use                                  # .nvmrc = 24
cd apps/fold-app
npx twenty remote:add                    # point it at http://localhost:3000 and sign in
npx twenty dev:build
npx twenty app:install
```

Then in Twenty: *Settings → APIs & Webhooks → create an API key* and assign it the **"The Fold service account"** role.

## 3. Run the harness

```sh
export FOLD_M0_BASE_URL=http://localhost:3000
export FOLD_M0_API_KEY=...                       # from step 2
# Optional, both opt-in:
export FOLD_M0_RATE_TEST=1                       # sends ~150 GETs to find the rate limit
export FOLD_M0_WEBHOOK_HOST=host.docker.internal # a name Twenty can reach this machine at
export FOLD_M0_WEBHOOK_SECRET=...                # the secret shown for the webhook, if Twenty shows one
pnpm m0
```

The harness prints a table and writes `.tmp/m0-report.md`. **Paste it into `docs/verification-status.md`**, flip
the corresponding rows from ❓ to ✅ or ❌, and fix anything that came back FAIL before building on it:

| A FAIL in… | means… | so change… |
|---|---|---|
| `sourceref-idempotent` | filter syntax or unique constraint differs | `TwentyClient.findBySourceRef` (REST adapter) |
| `select-defaults` | defaults are not applied as written | `scalarField` in `apps/fold-app/src/model/build.ts` |
| `app-installed` | the app did not install fully | the SDK output, then the model |
| `batch-limit-and-paging` | pagination fields differ | `nextCursorOf` / `listUpdatedSince` |
| `webhook-signature` | the signed string differs | `defaultSignedPayload` in `webhook.ts` — nothing else |

## 4. Do the manual checks

The report lists the `MANUAL` checks with exact steps. The two that matter most for privacy are
**care-permissions** and **workflow-bypass**: if either fails, do not put a real congregation on this.
