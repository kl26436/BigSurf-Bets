# Big Surf Bets app — setup

The app (`app/`) is a React PWA that reads Supabase directly. Everything below is one-time.

## 1. Run it on your laptop (5 minutes)

```bash
cd app
npm install
copy .env.example .env.local      # macOS/Linux: cp
```

Fill `.env.local` with the project URL and the anon / publishable key (Supabase dashboard → Project settings → API).
Both are public by design; what protects the data is the sign-in plus row-level security.

```bash
npm run dev                        # http://localhost:5173
```

With no `.env.local` the app runs on built-in sample data and says so in a banner.

## 2. Sign in and claim the app

1. **Create account** with your email and a password, open the confirmation email, then **Sign in**.
2. The app shows **Claim this app**. The first account to claim it becomes the owner; after that the door is shut.
   Until you do this nobody, signed in or not, can read anything.
3. Optional but sensible: Supabase dashboard → Authentication → Sign In / Providers → turn off "Allow new users to sign up".
   To add someone later: `insert into bsb.app_users (user_id, email) select id, email from auth.users where email = '...';`

## 3. Let the app start work, and make the schedule exact (3 minutes)

Lineup builds, refreshes and salary uploads run as GitHub workflows. The database starts them, and it needs a token:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   Repository access: **only `BigSurf-Bets`**. Permissions: **Actions → Read and write**. Nothing else.
2. Supabase dashboard → SQL editor:
   ```sql
   select vault.create_secret('PASTE_THE_TOKEN_HERE', 'github_pat');
   ```
3. In the app: Week → **Check player statuses**. Settings → "Requests from this app" should show it reached GitHub (answer 204).

The same token switches on the database timetable (`0007_scheduler.sql`), which fires on the minute. Without it the
workflows' own cron lines still run, a few minutes late and occasionally not at all — which is why `Feed health`
emails you when a feed goes quiet. To rotate the token: `select vault.update_secret(id, 'NEW') from vault.secrets where name = 'github_pat';`

## 4. Put it on bigsurf.bet

1. Firebase console → create a project → Hosting → add the custom domain `bigsurf.bet` (same DNS steps as dev.big.surf).
2. GitHub → repo → Settings → Secrets and variables → Actions:
   - secret `FIREBASE_SERVICE_ACCOUNT`: Firebase console → Project settings → Service accounts → Generate new private key (paste the whole JSON)
   - variable `FIREBASE_PROJECT_ID`: the project id
3. Supabase dashboard → Authentication → URL configuration: Site URL `https://bigsurf.bet`; add `http://localhost:5173` to the redirect list.
4. Actions → **App** → Run workflow. Every later push that touches `app/` deploys by itself.
5. On the iPhone: open bigsurf.bet in Safari → Share → Add to Home Screen. Sign in with the password (an emailed link opens in Safari, not in the installed app).

## What the app can and cannot do

- Reads: the `public.app_*` views only. Writes: the `public.bsb_*` functions only (overrides, hand-built lineups, settings, job requests).
- It never places an entry or a bet. Lineups leave as a DraftKings upload file; bets are prices and stakes to act on yourself.
- Checks: `npm test` (lineup rules, stakes), `npm run audit:design` (brand tokens only, no inline styles, no banned jargon), `npm run build`.
