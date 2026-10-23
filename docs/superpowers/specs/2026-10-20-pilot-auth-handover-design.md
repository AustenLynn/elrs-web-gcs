# Pilot accounts and automatic handover: Design

**Date:** 2026-10-20 · **Amends:** `2026-10-05-elrs-web-gcs-design.md` (pilot selection, IPC, safety
rules) and `docs/ARCHITECTURE.md` §5.5, §6.1, §7.4, §8.
**Status:** agreed in conversation, part by part; this spec is for the team's review.

> **Amended 2026-10-22: the automatic handover is replaced** by the two-stage failsafe in
> [`2026-10-21-hold-then-land-failsafe-design.md`](2026-10-21-hold-then-land-failsafe-design.md). Goals 4–5, A7, A9, A10 and §4.3–4.5 below describe
> the design as first agreed; each carries a note. Accounts, the queue and sign-in (§4.1, §4.2, §4.4's
> queue order) are unchanged.

## 1. Why

The pilot page has no login. Anyone who opens the address takes the free pilot seat and can arm the
drone (`docs/HANDOFF.md` §6). The team still wants to use the Cloudflare tunnel for flights and the
2026-11-23 demo, so a login is now needed.

The second need comes from the pilot's connection. When it drops in flight today, the core fails safe
within 300 ms and the Aquila20's motors stop. With a second team pilot standing by, the drone could
keep flying instead.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Only signed-in pilots can take control. This applies on the local Wi-Fi as well as through the tunnel.
2. Anyone with the link can watch (video, telemetry, status) without an account.
3. An admin adds and removes pilots from a phone, just before a flight.
4. If the active pilot's connection drops while a second pilot is signed in, control passes to that
   pilot at once and the drone keeps flying, with no FAILSAFE.
   *Amended 2026-10-22: the drone holds, and the second pilot chooses «Tomar el control» or «Aterrizar».*
5. If nobody is waiting, FAILSAFE happens as today and the motors stop.
   *Amended 2026-10-22: with or without a second pilot, the drone holds, then lands, then FAILSAFE.*

**Non-goals**
- Hosted identity services (Firebase, Cognito, Auth0). Two to a few accounts on one Pi don't justify
  an outside dependency, and the system must work on a local Wi-Fi with no internet.
- Self sign-up, e-mail, invitation links, password reset by e-mail. The admin picks a username and
  password and tells the pilot ("first option for now").
- Spectator accounts.
- A "hand over" button. There's no explicit control for passing the drone on. But letting go (A9)
  does hand over when a standby is ready.
- Accounts for the internet relay (M7, `?room=`). Relay pilots keep flying with the room
  `pilotToken` alone (A11, §7 open item).

**Anti-goals: these would be failures even if everything else worked**
- A handover that makes the drone fall: FAILSAFE fires before the standby gets control, or the new
  pilot's page sends "throttle 0" as its first command.
- An unauthenticated client reaches the pilot seat or the admin screen in any way: WebSocket without a
  cookie, a forged Origin. The only other way in is the relay's room `pilotToken` (A11). Nothing else
  on the relay path may reach the pilot queue, and nothing on it reaches `/admin`.
- A safety decision made in the gateway. Which session may fly, and when FAILSAFE fires, stays in
  `crsf-core` (CLAUDE.md).
- An active pilot removed while flying.

## 3. Decisions taken in conversation

| # | Decision |
|---|---|
| A1 | Two roles: **pilot** (signed in) and **spectator** (anyone, no account). An **admin** flag on a pilot account allows the admin screen. |
| A2 | Accounts are **username + password**, created by the admin, who tells the pilot. |
| A3 | Pilots **always** sign in, on the local Wi-Fi too. |
| A4 | The admin screen is used **from a phone**, right before a flight, possibly through the tunnel. |
| A5 | **An active pilot cannot be removed.** |
| A6 | Several pilots may be signed in. They queue **in the order they signed in**: the first flies, the second is standby, the rest wait behind. |
| A7 | **Pilot lost with a standby present → standby gets control immediately, the drone keeps flying, no FAILSAFE.** With nobody waiting → FAILSAFE as today (motors stop). *Amended 2026-10-22: replaced. Pilot lost → HOLD, then LANDING; the queue head may take control or land. Nothing switches pilots on its own.* |
| A8 | No outside identity service. Accounts live on the Pi and are managed by the gateway. |
| A9 | **Letting go hands over too.** With a ready standby, a pilot who lets go (Esc, hidden tab, lost focus, layout change: anything that makes the page stop sending) is treated like a lost connection: the drone keeps flying under the standby. To stop the motors on purpose, the pilot uses **Desarmar** (or the manual FAILSAFE), which still works. *Amended 2026-10-22: letting go starts a HOLD then a landing, with or without a second pilot; it never stops the motors. Desarmar is the only way to stop them in flight.* |
| A10 | **The standby only watches** until they get control: no arm, disarm or FAILSAFE buttons. *Amended 2026-10-22: stands. The queue head also sees «Tomar el control» and «Aterrizar» during a hold or landing.* |
| A11 | **Relay pilots** (`?room=` with the room's `pilotToken`) can still fly without an account. They join the same queue as signed-in pilots, in arrival order, and can be active or standby (*queue placement is my call*). |

## 4. Design

### 4.1 Accounts and sign-in (gateway)

- **Store:** `/var/lib/gcs/users.json`, owned by the `gcs` user (mode 0600). Each entry has a username,
  a password hash and an `admin` flag. *Builder's call:* the hash is `crypto.scrypt` from Node's
  standard library, with a per-user salt (no new dependencies). The file is written atomically
  (temporary file + rename).
- **First admin:** created on the Pi from the command line, for example
  `sudo -u gcs node /opt/gcs/gateway/src/users-cli.js add <name> --admin`. *Builder's call:* the
  exact name. With no users at all, the page says no pilot accounts exist yet and explains how to
  create one.
- **Sign-in:** a form on the pilot page posts to `POST /login` (HTTPS only). A successful sign-in sets
  a **session cookie**: random, at least 128 bits, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
  The server keeps the cookie table in memory, so a gateway restart signs everyone out. That is
  acceptable: the core fails safe on gateway loss anyway.
  *Builder's call:* the cookie lifetime (12 h suggested, enough for a test day), and the
  `POST /logout` endpoint.
- **Brute force:** failed sign-ins are rate-limited per username and per address (*builder's call*
  on the numbers, e.g. 5 per minute). The page is public on the tunnel.
- **WebSocket:** `hello {role: pilot}` is granted only if the upgrade request carried a valid session
  cookie, or (relay clients only) the correct room `pilotToken`, which the relay already checks (A11). Without one the client is a spectator and gets `welcome {role: observer, reason: "login_required"}`.
  The existing Origin check stays.
- **Removing a user** ends their cookies at once. If that user is in the pilot queue but not flying,
  they drop out of the queue. If they are the active pilot, removal is refused (A5).

### 4.2 Admin screen (`/admin`)

Sketched during the brainstorm (the sketch is not in the repo). It's a phone layout
in the page's Spanish:
- the list of pilots, each with **Cambiar contraseña** and **Quitar**;
- **Quitar** is disabled, with a short reason, for the active pilot (A5);
- a form **Agregar piloto**: username + password, plus an "admin" checkbox;
- **Salir**.

It is served only to a signed-in admin. Admin actions are JSON `POST`s that require the admin's
cookie and a matching `Origin` (CSRF). They're also checked against `SameSite=Strict`. An admin
cannot remove their own account, so the system always keeps at least one admin.

### 4.3 Pilot page

> **Amended 2026-10-22:** «Listo para tomar el control» is gone. The queue head is the standby, and
> during HOLD or LANDING it gets a banner with «Tomar el control» and «Aterrizar». Takeover sticks seed
> from the drone's outputs (hold-then-land spec §4.3, §4.5).

- Everyone starts as a spectator: video, telemetry, status. No controls.
- **Iniciar sesión como piloto** opens the sign-in form. Once signed in, the page joins the pilot queue
  automatically (A6).
- The status line shows everyone **who is flying and who is standby**: `Piloto: ana · En espera: luis`.
- A standby pilot sees "Estás en espera. Si ana pierde la conexión, el control pasa a ti al instante.",
  the live sticks of the drone (from the 10 Hz STATUS, which already carries the 16 channels) and no
  arm, disarm or FAILSAFE buttons (A10).
- **On takeover:** the new pilot's sticks start at the last values the drone received, not at their
  own resting position. Then they follow the new pilot's input. *Builder's call* on how: for touch
  sticks, the throttle (which does not spring back) is set to the last throttle, and the springy axes
  start centred only if the last values were near centre. Otherwise they start where the drone was.
  The rule is that **the first command from the new pilot must not jump the throttle.**
  The page shows a large, unmistakable "TIENES EL CONTROL" banner and vibrates on phones that support it.
- **The standby must be ready in advance** (*my call, from goal 4*). A signed-in pilot in second
  place becomes the standby only after pressing **«Listo para tomar el control»**. Like «Tomar
  control» today, this asks for full screen and the orientation lock. A ready page holds its
  dead-man state, sends nothing, and starts sending the moment it's promoted. A page that stops
  being ready (Esc, hidden tab, lost focus, layout change) is no longer the standby, and the gateway
  tells the core (STANDBY 0, or the next ready pilot). A page that isn't ready can't meet the 300 ms
  in §4.5, so a handover to it would end in FAILSAFE anyway.

### 4.4 Queue (gateway, `hub.js`)

> **Amended 2026-10-22:** `STANDBY` always names the queue head; there is no ready flag. The core's
> `taken` event (not `handover`) moves the seat, and the old pilot goes to the back of the queue.

- The queue holds the signed-in pilot connections, in the order they joined. The head flies, the next
  one is the **standby**. Each queued connection gets a session as today.
- **The gateway tells the core which session is the standby** (new IPC message, §4.5). This happens
  whenever the standby changes: someone joins, leaves, or is promoted.
- When the active pilot's socket closes, the hub sends `PILOT_LOST` as today. The core decides
  (§4.5), and the hub follows the core's result. The gateway never promotes on its own.
- A pilot who reconnects (new socket) goes to the **back** of the queue. *Builder's call*, and the
  natural reading of A6 for a reconnect.
- **The old pilot after a handover** (*my call*): when the core reports `handover`, the old pilot's
  connection, if still open, moves to the **back** of the queue and isn't ready (its page shows
  "Perdiste el control: ahora vuela luis"). It can become the standby again only by pressing
  «Listo» again. So a bad link never silently gets control back.
- **Standby order counts ready pilots only:** the standby is the first *ready* pilot after the
  active one in sign-in order (A6).

### 4.5 Handover in crsf-core (the safety part)

> **Amended 2026-10-22: replaced by HOLD, LANDING and TAKE/LAND** (hold-then-land spec §4.1). The
> handover, its 300 ms first-command window and the "no chained handovers" rule no longer exist. The
> DISARM and manual FAILSAFE rule (active session only) and the list of instant triggers stand.

The realistic loss is Wi-Fi or tunnel trouble, not a closed tab. In that case the socket stays open
for a while and the first sign is the core's own **300 ms command timeout**. So the handover must
be decided in the core, triggered by the same events that trigger FAILSAFE today.

- **New IPC message** `STANDBY (u32 session)`, gw → core. Session 0 means "no standby". The core keeps
  one standby session next to the active one.
- **Handover triggers:** `cmd_timeout` and `pilot_lost` for the active session, **while a standby
  session is registered**. Instead of entering FAILSAFE, the core:
  1. makes the standby session the active one (`last_seq` reset to 0) and clears the standby;
  2. keeps sending the last applied channels (same as during the 300 ms before a timeout);
  3. starts a fresh **300 ms** timer: if the new session's first fresh command doesn't arrive in
     time, FAILSAFE (`cmd_timeout`) as today;
  4. emits an event `handover {from, to, reason}` for the gateway and the evidence log.
- **No chained handovers** (*my call, from the budget below*): until the new session's first fresh
  command arrives, the core is "handover pending". During that time it ignores `STANDBY`, and any
  timeout or `pilot_lost` ends in FAILSAFE. Once that first command arrives, the next `STANDBY` from
  the gateway counts again.
- **DISARM and manual FAILSAFE are accepted from the active session only** (*my call*). Today the
  core doesn't check the session for these (only the hub does). After a handover, a late DISARM from
  the old pilot's page would stop the motors under the new pilot. Disarm stays "always accepted" for
  the active pilot. The rule changes only for other sessions.
- **Every other FAILSAFE trigger stays as it is,** even with a standby: `gateway_lost`, `manual`,
  `rf_lost`, and an unexpected `SESSION` change. A standby can't help when the gateway or the radio
  link is gone.
- **States:**
  - ARMED: handover as above; the drone stays ARMED.
  - DISARMED: the session switches; nothing else changes.
  - FAILSAFE (already latched): the session switches, FAILSAFE stays latched, and the new pilot must
    clear it as today.
- **Budget:** the drone flies on the last sticks for at most 300 ms (timeout) + 300 ms (new pilot's
  first command). That is a known cost of A7. Whether 300 ms is right is still open (spec P1, flight
  report §5).
- The commands from the old session are rejected after the switch, as for any other wrong session.

### 4.6 Messages, summarised

| Hop | Change |
|---|---|
| browser → gateway | `POST /login`, `POST /logout`, admin JSON endpoints; `hello {role: pilot}` now requires the cookie |
| gateway → browser | `welcome {role: observer, reason: "login_required"}`; `welcome {role: standby, position}`; `status` gains `pilot` and `standby` names; `event {what: "handover"}` and a `welcome {role: pilot}` to the promoted page |
| gateway → core | new `STANDBY (u32 session)` |
| core → gateway | new event kind `handover` (from, to, reason) |

## 5. Tests the builder must include

- core unit (`safety.c`): handover on `cmd_timeout` and on `pilot_lost` with a standby; FAILSAFE
  without one; no handover for `gateway_lost`, `manual`, `rf_lost`, `SESSION`; new session's 300 ms
  timer; old session refused after the switch; DISARMED and FAILSAFE cases.
- core integration (fake TX module): an armed pilot stops sending, the standby's commands reach the
  channels with no FAILSAFE frame in between; the same with no standby → ARM low.
- gateway: no cookie → spectator; bad password and rate limit; removed user loses the seat; admin
  endpoints refuse non-admins and foreign Origins; removing the active pilot is refused; queue order;
  STANDBY sent on every change.
- gateway: a relay client with the right token joins the queue, with a wrong or no token it's a
  spectator; relay clients never reach `/admin`.
- browser e2e: a ready standby takes over when the pilot presses Esc (A9). Two pages, A flies, A's page is killed, B shows "TIENES EL CONTROL" and its first
  command doesn't drop the throttle.
- Bench (propellers off): the M4 checklist gets a handover step on two devices, turning off Wi-Fi on
  the pilot device.

## 6. Left to the builder

The hash parameters, the cookie lifetime, the rate-limit numbers, the CLI's name and the admin page's
look. Also the exact message field names, and how the takeover stick rule (§4.3) is implemented for
each input mode (touch, keyboard, Prueba steps). These are marked *builder's call* above.

## 7. Open items for the team

- **Relay (M7):** relay pilots fly on the room `pilotToken` alone for now (A11). Should they need an
  account later? Not needed for the tunnel, which goes straight to the gateway.
- **Stopping with a standby present (A9):** letting go no longer stops the motors when someone is
  ready. Every pilot must know that **Desarmar** is the way to stop. The M4 checklist and the pilots'
  briefing must say so.
- **300 ms timeout (P1):** a handover adds up to 300 ms of flying on old sticks. A longer timeout makes
  that worse.
