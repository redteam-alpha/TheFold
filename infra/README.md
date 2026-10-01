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
npx twenty remote:add --url http://localhost:3000 --api-key "$FOLD_M0_API_KEY" --as thefold
npx twenty remote:status                 # confirm it is signed in
npx twenty apply --force --no-delete     # first install: registers the app, uploads it, syncs the model
```

Why `--force --no-delete` on the **first** install: `twenty plan` (and a plain `apply`, which previews first) sends a dry run to the server before anything has
registered the app, and the server answers `No registration found for "<app id>"`. `--force` skips that preview and the delete confirmation; `--no-delete`
means nothing is ever removed, which matters more on a workspace that already has data. Once the app is registered, `npx twenty plan` works and is the
safe way to preview a change before `npx twenty apply --no-delete`. After a `git pull` that changes the model, re-run `apply`.

If the server rejects the model it says so per entity (`fieldMetadata: … This name is reserved`, `Field metadata not found`…), and nothing is applied.
Fix the model, not the server; `apps/fold-app/test/model.test.ts` guards the reserved names.

Do **not** name the remote `local`. That is the CLI's built-in remote (`http://localhost:2020`, where its own `docker:start` container would run), and
when `--as` names an existing remote, `remote:add` re-authenticates it with its stored URL and **ignores `--url`**. You then get `Cannot connect to
Twenty server` followed by `Authentication failed` even though your server is fine.

Do **not** use `app:install` for this. In `twenty-sdk@2.43.0` it installs an app that has already been *deployed* (published); `plan`/`apply` are the
path for local source, and `twenty dev` is the same thing in watch mode.

The **"The Fold service account"** role exists only after `apply`. It is not a different kind of key: it is a role that an ordinary API key can be
given (*Settings → APIs & Webhooks*, pick the role when creating the key; the key is shown once). The real services will use a key with this role,
so the harness should run as it. Keep an admin key too: the service account deliberately cannot read workspace metadata (the `app-installed` check
needs that) or delete people and households (the harness creates and removes them). Step 3 uses the admin key for those two jobs only.

## 3. Run the harness

Run it from the **repository root**: `m0` is a root script, and from inside `apps/fold-app` pnpm answers `Command "m0" not found`.

```sh
cd ~/TheFold                                     # the repository root
export FOLD_M0_BASE_URL=http://localhost:3000
export FOLD_M0_API_KEY=...                       # the checks run as THIS key: the service-account key from step 2
export FOLD_M0_ADMIN_API_KEY=...                 # an admin key, used ONLY to read workspace metadata and delete test records
export FOLD_M0_TWENTY_VERSION=v2.43.0            # recorded in the report header (else it says "unknown")
# For the care-permissions-api check (needs two test users, see "Two test users" below; without them it is SKIPped):
read -rp  'Church staff email: ' FOLD_M0_STAFF_EMAIL;     export FOLD_M0_STAFF_EMAIL
read -rsp 'Church staff password: ' FOLD_M0_STAFF_PASSWORD; echo; export FOLD_M0_STAFF_PASSWORD
read -rp  'Care team email: ' FOLD_M0_CARE_EMAIL;         export FOLD_M0_CARE_EMAIL
read -rsp 'Care team password: ' FOLD_M0_CARE_PASSWORD;   echo; export FOLD_M0_CARE_PASSWORD
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
| `care-permissions-api` | a user without the care role can see a care request, **or** the harness could not sign in | a leak: the role in `apps/fold-app/src/model/roles.ts`, never the check. A sign-in failure: `login.ts`, from what the server really answered |

Run as the **service-account key**, a FAIL that says `403` on a create, read or update means that role is too narrow for what the real services do:
change `service` in `apps/fold-app/src/model/roles.ts`, `git pull` on the VM and re-run `npx twenty apply --no-delete`. A `403` on the
`app-installed` metadata read is **not** that: it is the role working as intended, and it says to set `FOLD_M0_ADMIN_API_KEY`. Without that key,
records the key may not delete (people, households) are listed in an `INFO` row named `cleanup`; they are test data and safe to delete in Twenty.

### Two test users (for `care-permissions-api`)

A person's role cannot be given to an API key, so the only way to ask "what can a Church staff user read?" is to **be** one. The harness
cannot create users; you make two, with fake addresses (they only need to receive one email each, and Mailpit in this stack catches it
at http://localhost:8025):

1. In Twenty: **Settings → Members → Invite** `staff@fold-test.example`, then `care@fold-test.example`. (Menu names can differ by version.)
2. Open each invitation from the Mailpit inbox, accept it and **set a password**. Use throwaway passwords: the harness reads them from the
   environment and never prints or logs them, and they must never go into a chat, an issue or the ledger.
   **No mail in Mailpit?** The worker sends it, so `twenty-worker` needs the `EMAIL_*` settings too (fixed in this compose file; a stack
   started before that fix needs `git pull` and the `up -d` from step 1, which recreates the worker). Then resend the invitation from the
   Members page. `docker compose -f infra/docker-compose.yml --env-file infra/.env logs --since 15m twenty-worker | grep -iE 'mail|smtp'`
   shows what the worker did with it.
3. **Settings → Roles**: give `staff@…` the **Church staff** role and `care@…` the **Care team** role, and check each has *only* that role.
   A new member may arrive as an admin; an admin can see care requests, and the check would then (correctly) report a leak.
4. Set the four `FOLD_M0_STAFF_*` / `FOLD_M0_CARE_*` variables as in step 3 and run `pnpm m0`.

How to read the `care-permissions-api` row:

| Row | Means | Do |
|---|---|---|
| `PASS` | every surface was tested as the staff user (REST list, by id, person with relations, create; GraphQL; global search; the care request's and the person's timeline) and none returned the care request; the Care team user could read it | record ✅ in the ledger |
| `FAIL … LEAK … <surface>` | that surface returned the care request or accepted a write | **stop**: do not host a real congregation. Fix the role, re-run |
| `FAIL … could not sign in` | the login mutations did not work against this server | do the steps in section 5 by hand and write down what the server answered; `login.ts` is then fixed from that |
| `FAIL … Care team user could not read` | the control failed, so no denial means anything | fix the Care team role or the user's role assignment, re-run |
| `INFO … NOT tested` | nothing leaked, but some surface could not be exercised (e.g. no search query, no timeline entry within `FOLD_M0_TIMELINE_WAIT_MS`, default 6000) | do **those surfaces** by hand (section 5); it is not a PASS |
| `SKIP` | the four variables are not set | create the users |

## 4. Do the manual checks

The report lists the `MANUAL` checks with exact steps. The two that matter most for privacy are
**care-permissions** and **workflow-bypass**: if either fails, do not put a real congregation on this.
`care-permissions-api` automates the API half of the first; its `MANUAL` twin covers only what needs a browser (sidebar, direct URL,
the search box, the timeline tab on a person, the People CSV export).

## 5. Checking care permissions by hand, REST and GraphQL

Use this when `care-permissions-api` is `INFO`, `FAIL … could not sign in`, or you want to see the answers yourself. It does exactly what
the harness does, one surface at a time, so you can read every response.

> **Unverified against a live server.** The login mutations come from the v2.43.0 generated schema, and the `/graphql` shapes for
> `careRequests` and `search` could not be checked offline (the data schema is generated per workspace). If a command answers
> differently from what is written here, **the answer is the finding**: note the status and the first lines of the body (never a token or
> password) in `docs/verification-status.md` and fix the harness from it.

Fake data only. Never paste a token or password anywhere; the shell below holds them in variables and prints neither.

### 5.1 Setup (once per shell)

```sh
sudo apt install -y jq                         # once
cd ~/TheFold
export ORIGIN=http://localhost:3000            # the SAME address you open Twenty at in the browser
export MARKER="M0 manual care probe"           # text only the seeded care request carries
```

### 5.2 Sign in as each test user

Two GraphQL mutations on `/metadata`: a login token from the credentials, then access tokens from the login token. The password is read
silently and sent on stdin, so it is not in the process list or your history.

```sh
login() {  # login STAFF|CARE  ->  sets TOKEN_STAFF or TOKEN_CARE; prints only OK or what failed
  local who=$1 email pw lt at
  read -rp "$who email: " email
  read -rsp "$who password: " pw; echo
  lt=$(E="$email" P="$pw" O="$ORIGIN" jq -n '{query:"mutation($email:String!,$password:String!,$origin:String!){getLoginTokenFromCredentials(email:$email,password:$password,origin:$origin){loginToken{token}}}",variables:{email:env.E,password:env.P,origin:env.O}}' \
    | curl -sS "$ORIGIN/metadata" -H 'content-type: application/json' -d @- \
    | jq -r '.data.getLoginTokenFromCredentials.loginToken.token // ("ERROR: " + ((.errors[0].message // "no token in the answer")))')
  pw=
  case $lt in ERROR:*) echo "login token: $lt" | sed 's/^\(.\{200\}\).*/\1/'; return 1;; esac
  at=$(LT="$lt" O="$ORIGIN" jq -n '{query:"mutation($loginToken:String!,$origin:String!){getAuthTokensFromLoginToken(loginToken:$loginToken,origin:$origin){tokens{accessOrWorkspaceAgnosticToken{token}}}}",variables:{loginToken:env.LT,origin:env.O}}' \
    | curl -sS "$ORIGIN/metadata" -H 'content-type: application/json' -d @- \
    | jq -r '.data.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token // ("ERROR: " + ((.errors[0].message // "no token in the answer")))')
  case $at in ERROR:*) echo "access token: $at" | sed 's/^\(.\{200\}\).*/\1/'; return 1;; esac
  if [ "$who" = STAFF ]; then TOKEN_STAFF=$at; else TOKEN_CARE=$at; fi
  echo "$who: signed in OK"
}
login STAFF      # the user with the Church staff role
login CARE       # the user with the Care team role
```

If a step fails, the message is the server's own words (cut to 200 characters). `FORBIDDEN`/`invalid credentials` is a wrong password or
email; `origin` complaints mean `ORIGIN` is not the address the workspace is served on.

### 5.3 A helper that shows only what matters

```sh
probe() {  # probe TOKEN METHOD PATH [curl args]  -> HTTP status, size, and whether the care request showed up
  local t=$1 m=$2 p=$3; shift 3
  local out code body
  [ -n "$CARE_ID" ] && [ -n "$MARKER" ] || { echo "CARE_ID or MARKER is empty: do 5.4 first (an empty value would match everything)"; return 1; }
  out=$(curl -sS -X "$m" -w '\n%{http_code}' -H "Authorization: Bearer $t" -H 'content-type: application/json' "$@" "$ORIGIN$p")
  code=${out##*$'\n'}; body=${out%$'\n'*}
  printf 'HTTP %s | %s bytes | care id in body: %s | marker text in body: %s\n' "$code" "${#body}" \
    "$(grep -cF -- "$CARE_ID" <<<"$body")" "$(grep -cF -- "$MARKER" <<<"$body")"
  jq -c . <<<"$body" 2>/dev/null | cut -c1-300
}
```

### 5.4 Make a fake care request to look for

Uses the service-account key from step 3 (`FOLD_M0_API_KEY`), which is how the real services write care requests.

```sh
PERSON_ID=$(curl -sS -X POST "$ORIGIN/rest/people" -H "Authorization: Bearer $FOLD_M0_API_KEY" -H 'content-type: application/json' \
  -d '{"name":{"firstName":"M0Manual","lastName":"Probe"}}' | jq -r '[.. | objects | .id? | strings][0] // empty')
CARE_ID=$(curl -sS -X POST "$ORIGIN/rest/careRequests" -H "Authorization: Bearer $FOLD_M0_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$MARKER\",\"personId\":\"$PERSON_ID\"}" | jq -r '[.. | objects | .id? | strings][0] // empty')
echo "person=$PERSON_ID care=$CARE_ID"      # both must be UUIDs; if either is empty, run that curl without | jq and read the answer
```

### 5.5 Control: the Care team user CAN read it

If this fails, every "denied" below means nothing. Fix the Care team role first.

```sh
probe "$TOKEN_CARE" GET "/rest/careRequests/$CARE_ID"        # expect: HTTP 200 and care id in body: 1
probe "$TOKEN_STAFF" GET "/rest/people?limit=1"              # expect: HTTP 200 (the staff token works at all)
```

### 5.6 As the Church staff user: every surface must refuse or show nothing

```sh
# REST
probe "$TOKEN_STAFF" GET "/rest/careRequests"                         # list
probe "$TOKEN_STAFF" GET "/rest/careRequests/$CARE_ID"                # by id
probe "$TOKEN_STAFF" GET "/rest/people/$PERSON_ID?depth=2"            # the person, relations expanded
probe "$TOKEN_STAFF" POST "/rest/careRequests" \
  -d "{\"name\":\"M0 staff should be refused\",\"personId\":\"$PERSON_ID\"}"   # create

# GraphQL
probe "$TOKEN_STAFF" POST /graphql -d '{"query":"{ careRequests { edges { node { id name } } } }"}'
# global search (the same box the UI offers)
probe "$TOKEN_STAFF" POST /graphql -d "$(jq -n --arg q "$MARKER" \
  '{query:"query($q:String!){search(searchInput:$q,limit:20){edges{node{recordId objectNameSingular label}}}}",variables:{q:$q}}')"

# timeline: first prove an entry exists (admin key), then ask as staff
probe "$FOLD_M0_ADMIN_API_KEY" GET /rest/timelineActivities -G --data-urlencode "filter=linkedRecordId[eq]:\"$CARE_ID\""
probe "$TOKEN_STAFF"           GET /rest/timelineActivities -G --data-urlencode "filter=linkedRecordId[eq]:\"$CARE_ID\""
probe "$TOKEN_STAFF"           GET /rest/timelineActivities -G --data-urlencode "filter=targetPersonId[eq]:\"$PERSON_ID\"" --data-urlencode limit=60
```

How to read each line:

| Surface | PASS looks like | FAIL (leak) looks like |
|---|---|---|
| REST list | `HTTP 403` (or 404), or `200` with an empty list / `totalCount: 0` | any care request listed |
| REST by id | `HTTP 403` or `404` | `200` with `care id in body: 1` |
| person, `depth=2` | `200` for the person **without** a `careRequests` list | the care request inside the person |
| REST create | `HTTP 403` | `2xx` (a care request was created: delete it with the admin key) |
| GraphQL `careRequests` | `errors` (forbidden) or `"edges":[]` | an edge with the id or the marker |
| global search | no edge for the care request (nothing, or only the person) | an edge whose `label` is the marker |
| timeline, 1st line (admin) | an entry **is** returned (`care id in body: 1`); if not, wait a few seconds and repeat: there is nothing to test yet | — |
| timeline, 2nd and 3rd lines (staff) | `403`, or `200` with no entry for the care request | the entry (it names the record and may reveal that the person is receiving care) |

If `search` answers `Cannot query field "search"`, copy the query the UI's search box sends (browser developer tools → Network → the
`graphql` request) and use it instead; run the same query as the **Care team** user first, to check it can find the marker at all. Do not
call global search "denied" if the Care team user cannot find the marker with it either.

### 5.7 As the Care team user: the same surfaces must work

Repeat 5.6 with `$TOKEN_CARE` for the two reads and the GraphQL list. `REST by id` and `GraphQL careRequests` must show the care request
(`care id in body: 1`), otherwise the Care team role is too narrow.

### 5.8 Clean up, then record

```sh
curl -sS -X DELETE "$ORIGIN/rest/careRequests/$CARE_ID" -H "Authorization: Bearer $FOLD_M0_ADMIN_API_KEY" -o /dev/null -w 'care: HTTP %{http_code}\n'
curl -sS -X DELETE "$ORIGIN/rest/people/$PERSON_ID"     -H "Authorization: Bearer $FOLD_M0_ADMIN_API_KEY" -o /dev/null -w 'person: HTTP %{http_code}\n'
unset TOKEN_STAFF TOKEN_CARE FOLD_M0_STAFF_PASSWORD FOLD_M0_CARE_PASSWORD
```

Write the result of each surface (status, and **only** "leak" or "no leak") in the `care-permissions` rows of `docs/verification-status.md`. Any leak
means a real congregation must not be hosted on this until it is fixed and the whole of section 5 (or `care-permissions-api`) passes.
