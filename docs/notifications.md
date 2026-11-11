# Notifications

Big Surf Bets tells you when something changes while there is still time to act.

## What is sent

| Change | Listed on Week → What changed | Pop-up and e-mail |
|---|---|---|
| A player in a lineup you **entered** is ruled out (Out, IR, Doubtful, or dropped from expected points) | yes | **yes** |
| A player in a lineup you entered picks up an injury tag (Questionable) | yes | **yes** |
| Any other player on this week's games changes status (and is expected to score 8 or more, or is ruled out) | yes | no |
| A player's expected points move by 3 or more between two runs | yes | no |

- Each change is sent once. Doubtful and then Out counts as two changes.
- Three or more at once (an inactives list) arrive as one message.
- Nothing is sent about a player whose game has started: he can no longer be swapped.
- The check runs after every player-status snapshot and every expected-points run. On Sundays the
  snapshots run every 30 minutes from 10:23 am to 3:52 pm Eastern, so an alert can trail the
  announcement by up to about half an hour, plus the few minutes the run takes.

## Pop-ups on an iPhone

1. Open Big Surf Bets **from the Home Screen icon** (pop-ups do not exist in a Safari tab). It needs iOS 16.4 or later.
2. More → Settings → Notifications → **Turn on pop-ups**, and allow them when the phone asks.
3. Tap **Send a test**. It arrives within a couple of minutes.

A laptop browser can be signed up the same way; each device is listed in Settings and can be removed there.

Nothing needs setting up for pop-ups: the key pair that signs them is made at deploy time and kept in
`bsb.app_config`, which no app account can read.

## E-mail

E-mail needs an account to send from. This is the one step only the repository owner can do.

1. Use a Gmail account with 2-Step Verification on. At <https://myaccount.google.com/apppasswords> create an
   app password (name it "Big Surf Bets"). It is 16 letters.
2. On GitHub: the repository → Settings → Secrets and variables → Actions → **New repository secret**, twice:
   - `SMTP_USER` — the Gmail address
   - `SMTP_PASSWORD` — the 16-letter app password
3. In the app: More → Settings → Notifications → tick **E-mail me too**. Mail goes to the address you sign in
   with unless you type another.
4. Tap **Send a test**.

Another mail provider works too: add repository *variables* `SMTP_HOST` and `SMTP_PORT` (SSL, usually 465).

Until the two secrets exist, e-mails are logged as "not sent" with the reason, and pop-ups are unaffected.

## Where to look when one does not arrive

- More → Settings → Notifications → **Recently sent** lists each attempt: sent, failed (with the reason), or not sent.
- A device that stops accepting pop-ups (the app was removed, or permission withdrawn) is dropped from the list
  automatically; turn pop-ups on again from that device.
- `bsb notify run` prints what it found and sent; it is the "What changed" step of the *Weekly ingest* and
  *Projections* workflows.

## How it works

```
status snapshot / projections run
        └─ bsb notify run
              ├─ notify/detect.py   compare now with before → events (bsb.events, one row per change)
              ├─ notify/send.py     pop-up (Web Push, encrypted for the device) · e-mail (SMTP)
              └─ bsb.notifications  what was sent, to whom, and whether it arrived
```

Tables and functions: `supabase/migrations/0014_notifications.sql`.
