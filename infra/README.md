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

First create an API key in Twenty (*Settings → APIs & Webhooks*). It gets the workspace's default role, which is enough to install. On a
headless machine the key is also how the CLI signs in, since `remote:add` would otherwise want a browser.

```sh
nvm use                                  # .nvmrc = 24
export FOLD_M0_API_KEY=...               # the key you just created
cd apps/fold-app
npx twenty remote:add --url http://localhost:3000 --api-key "$FOLD_M0_API_KEY" --as local
npx twenty remote:status                 # confirm it is signed in
npx twenty plan                          # preview only: read what it will create
npx twenty apply --no-delete             # --no-delete: never remove anything that is not in our source
```

Do **not** use `app:install` for this. In `twenty-sdk@2.43.0` it installs an app that has already been *deployed* (published); `plan`/`apply` are the
path for local source, and `twenty dev` is the same thing in watch mode.

The **"The Fold service account"** role exists only after `apply`. Then, in Twenty, create (or edit) an API key, give it that role, and use *that*
key for the harness, so it runs with the least privilege the real services will have.

## 3. Run the harness

```sh
export FOLD_M0_BASE_URL=http://localhost:3000
export FOLD_M0_API_KEY=...                       # the service-account key from step 2
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
