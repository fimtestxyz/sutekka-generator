# STEP_HUMAN_TODO.md — Human steps to ship Google sign-in (Sutekka)

> Created: **2026-11-26 12:37 SGT (Thursday)** · Last updated: 2026-11-26 12:37 SGT
> Owner: Bed · Repo: `fimtestxyz/sutekka-generator` · Branch: `auth-db-v0.2`
> Scope: everything only the human can do. Muse already wrote the code; it
> cannot create a Google Cloud project or read your Neon/Vercel dashboards.
> Each step has a `Completed at` line. Fill it in when you finish the step.

## Where things stand (already done)

| When (SGT) | What | State |
|---|---|---|
| 2026-11-26 ~11:30 | Auth code finished on branch `auth-db-v0.2` (8 commits, 40 files) | Done, verified by Muse: schema valid, typecheck clean, 64/64 tests pass |
| 2026-11-26 ~11:47 | Neon project `sutekka-generator` created (Singapore, Postgres only) | Done |
| 2026-11-26 ~12:15 | Neon API key stored (`custom.neon`) | Done |
| 2026-11-26 12:21 | `api.neon.tech` still unreachable from this VM (TLS closes after proxy CONNECT) | Blocked; one retry set for ~14:20 SGT today, then the manual route below |

## Step 1 — Google Cloud project

- [ ] Go to [Google Cloud Console](https://console.cloud.google.com/) and sign in
      with your Google account.
- [ ] Top bar → project picker → **New Project**.
- [ ] Project name: `sutekka-generator`. Leave organisation and location as-is.
      Click **Create** and wait for it to finish, then make sure it is the
      selected project.
- [ ] Completed at (SGT): ______

## Step 2 — OAuth consent screen

- [ ] Left menu → **APIs & Services** → **OAuth consent screen**.
- [ ] User type: **External** → **Create**.
- [ ] App information:
  - App name: `Sticker Showcase`
  - User support email: your email (pick the address users would contact).
  - App logo: skip for now (optional).
- [ ] Developer contact information → Email addresses: your email.
- [ ] Click **Save and Continue** through Scopes and Test users.
  - Scopes: leave the defaults. Auth.js asks for `openid`, `email`,
    `profile` at sign-in time; no extra scopes are needed.
  - Test users: while the app is in **Testing**, only listed test users can
    sign in. Add your own Google account here so you can test immediately.
- [ ] Back on the consent screen, click **Publish App** so anyone can sign
      in (not just test users). This needs only the fields above; no Google
      verification is required for these three scopes.
- [ ] Completed at (SGT): ______

## Step 3 — Create the OAuth client (Google SSO)

- [ ] Left menu → **APIs & Services** → **Credentials** → **Create
      Credentials** → **OAuth client ID**.
- [ ] Application type: **Web application**.
- [ ] Name: `sutekka-generator-web`.
- [ ] Under **Authorized redirect URIs**, click **Add URI** and add exactly
      this line (no trailing slash, `https`, production domain):

      ```
      https://sutekka-generator.vercel.app/api/auth/callback/google
      ```

- [ ] Optional, only if you also want to test sign-in on your own machine:
      add a second URI:

      ```
      http://localhost:3000/api/auth/callback/google
      ```

- [ ] Click **Create**. A panel shows your **Client ID** and **Client
      secret**. Copy both somewhere safe for Step 4. You can re-open them
      later under Credentials, but the secret is only shown on that panel.
- [ ] Completed at (SGT): ______

## Step 4 — Neon connection strings (manual route)

- [ ] Open the [Neon console](https://console.neon.tech/), project
      `sutekka-generator` → **Connect** (or Dashboard → connection details).
- [ ] Copy the **pooled** connection string. This is `DATABASE_URL`. You can
      tell it apart by `-pooler` in the hostname.
- [ ] Copy the **direct** (non-pooled) connection string. This is
      `DIRECT_URL`. No `-pooler` in the hostname.
- [ ] Do not paste either string in chat. They go straight into Vercel in
      Step 5.
- [ ] Completed at (SGT): ______

## Step 5 — Vercel environment variables

- [ ] Open [Vercel](https://vercel.com/), project `sutekka-generator` →
      **Settings** → **Environment Variables**.
- [ ] Add each row below. Environment: **Production** for all six. (Preview
      is optional; add it too only if you want preview deploys to sign in.)

      | Variable | Value (where to get it) |
      |---|---|
      | `DATABASE_URL` | Pooled string from Step 4 |
      | `DIRECT_URL` | Direct string from Step 4 |
      | `AUTH_SECRET` | Generate now: run `openssl rand -base64 32` in a terminal and paste the output |
      | `AUTH_URL` | `https://sutekka-generator.vercel.app` |
      | `AUTH_GOOGLE_ID` | Client ID from Step 3 |
      | `AUTH_GOOGLE_SECRET` | Client secret from Step 3 |

- [ ] Save each variable. Nothing else changes in Vercel.
- [ ] Completed at (SGT): ______

## Step 6 — Tell Muse, then verify live

- [ ] Tell Muse: "Env vars are set." Muse will then merge `auth-db-v0.2`
      into `main`, deploy, run the database migration and seed on the first
      deploy, and verify the live site.
- [ ] Verification checklist (Muse runs it, you confirm the sign-in):
  - [ ] `https://sutekka-generator.vercel.app/api/auth/session` no longer
        returns `503 auth_not_configured`.
  - [ ] Click sign-in on the live site → Google account chooser appears →
        after choosing, your name shows in the header.
  - [ ] Like a sticker set, post a comment, bookmark a set, then reload:
        all three stick to your account.
- [ ] Completed at (SGT): ______

## Values cheat-sheet (copy-paste)

```
Production domain:  https://sutekka-generator.vercel.app
Redirect URI:       https://sutekka-generator.vercel.app/api/auth/callback/google
Local redirect URI: http://localhost:3000/api/auth/callback/google
AUTH_URL:           https://sutekka-generator.vercel.app
AUTH_SECRET:        openssl rand -base64 32
```

## If something fails

- `redirect_uri_mismatch` on Google's error page: the URI in Step 3 does not
  exactly match what the site sent. Compare character by character with the
  cheat-sheet above (scheme, domain, path, no trailing slash).
- `access_blocked` / "This app isn't verified" for other accounts: the
  consent screen is still in Testing. Finish Step 2's Publish App, or add
  the account under Test users.
- Live API answers `503 {"error":"auth_not_configured"}`: one or more of the
  six variables in Step 5 is missing on Production. Check Vercel and
  redeploy after adding them.
- Live sign-in loops back to the login page: the Google client secret or
  `AUTH_SECRET` is wrong, or the deployment predates the variables. Check
  Step 5, then redeploy.
