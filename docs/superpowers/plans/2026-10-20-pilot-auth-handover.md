# Pilot Accounts and Automatic Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only signed-in pilots (or relay pilots with the room token) can fly. They wait in a queue, and
if the active pilot's commands stop while a ready standby waits, crsf-core passes control to the
standby without FAILSAFE. An admin manages pilot accounts from `/admin`.

**Architecture:**
- **crsf-core** owns the handover. The gateway registers one *standby* session (`STANDBY`). On
  `cmd_timeout` or `pilot_lost` of the active session, the core switches to that session instead of
  failing safe, and reports `handover` to the gateway.
- **The gateway** owns accounts (a JSON file with scrypt hashes), cookies, the pilot queue, and which
  queued page is the standby. It follows the core's `handover` event and never promotes anyone on its own.
- **The page** gets sign-in, a «Listo» (ready) state for the standby, and a takeover that starts the
  new pilot's inputs from the last command on the air.

**Tech Stack:**
- C (gcc 14, make; `check.h` unit tests, Python integration tests against the real binary);
- Node 22 gateway (`node:test`, only `ws` as a dependency: no new packages);
- plain ES-module web page (`node:test`, headless-Firefox e2e).

**Spec:** `docs/superpowers/specs/2026-10-20-pilot-auth-handover-design.md`

## Global Constraints

- **Safety stays in the core.** The gateway never decides whether the drone keeps flying. It promotes
  a page only when the core reports `handover` (or the seat is free with the core at session 0).
- **Handover triggers:** only `cmd_timeout` (ARMED) and `pilot_lost` (any state) of the active
  session, with a standby registered. `gateway_lost`, `manual`, `rf_lost` and an unexpected `SESSION`
  keep failing safe as today.
- **Timer:** after a handover, the new session has **300 ms** (the configured `cmd_timeout`) to send
  its first fresh command. Until then the core is *handover pending*: it ignores `STANDBY`, so a second
  timeout or `pilot_lost` ends in FAILSAFE. No chained handovers.
- **During the handover gap** the core keeps the last applied sticks, mode, speed and turtle.
- **DISARM and manual FAILSAFE** are applied only for the active session (`session == s->session`,
  non-zero). For the active pilot, DISARM is still always accepted.
- **Accounts:** `/var/lib/gcs/users.json`, mode 0600, owner `gcs`, written atomically (temp file +
  rename). Passwords use `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key, 16-byte random salt per user).
  Usernames are `^[a-z0-9_-]{2,20}$`, passwords at least 8 characters.
- **Cookie:** `gcs_session`, 32 random bytes as hex, `HttpOnly; Secure; SameSite=Strict; Path=/;
  Max-Age=43200` (12 h). `Secure` is left out only when the gateway runs without TLS (tests).
  Cookies are kept in memory, so a gateway restart signs everyone out.
- **Login rate limit:** 5 failed attempts per username and per remote address per 60 s, then
  `429` until the window passes.
- **Who may hold the pilot seat or the queue:** a WebSocket whose upgrade carried a valid cookie, or a
  relay client (the relay already checked the room `pilotToken`). Everyone else is a spectator.
- **Admin endpoints** need an admin cookie **and** `Origin` equal to the request `Host` (no Origin →
  refused). The active pilot can't be removed, and an admin can't remove their own account.
- **Queue order:** join order (sign-in / connection order). A reconnect joins at the back. After a
  handover the old pilot, if still connected, goes to the back and isn't ready.
- **Standby:** the first *ready* queued page after the active pilot. The gateway sends `STANDBY` on
  every change (including `STANDBY 0`).
- **UI copy (Spanish, exact):**
  - `Iniciar sesión como piloto`
  - `Listo para tomar el control`
  - `Estás en espera. Si {pilot} pierde la conexión, el control pasa a ti al instante.`
  - `TIENES EL CONTROL`
  - `Perdiste el control: ahora vuela {pilot}`
  - `Inicia sesión para pilotar` (spectator who asked for the pilot role)
  - `Piloto: {pilot} · En espera: {standby}`, with `—` for none
  - Admin: `Pilotos`, `Agregar piloto`, `Cambiar contraseña`, `Quitar`, `Salir`, `Está volando: no se puede quitar`
- **Relay pilots** appear as `remoto` in names.
- **Commits:** on the branch `feat/pilot-auth-handover`. Every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Before calling the work done, run all five suites** (`docs/HANDOFF.md` §5). Browser tests run one
  at a time; check `vcgencmd measure_temp` first.

## Review Focus

1. **A ready standby whose page has just been promoted sends a throttle of 0.** A pilot expects the
   drone to stay in the air. Pinned in Task 7 (`takeover seeds every input mode from the last
   command, raising the throttle limit when needed`).
2. **The old pilot's page keeps sending after a `cmd_timeout` handover** (its socket is still open).
   Its commands must never reach the core, and its DISARM must not stop the new pilot's drone.
   Pinned in Task 1 (`old session's disarm and failsafe are ignored after a handover`) and Task 5
   (`after a handover the old pilot is queued, not ready, and its commands are refused`).
3. **The standby stops being ready (switches app) at the same moment the pilot drops.** The core must
   end in FAILSAFE, not hand over to a page that sends nothing. Pinned in Task 1 (`handover pending:
   no command in 300 ms fails safe`) and Task 5 (`not-ready standby is withdrawn with STANDBY 0`).
4. **A removed user is the standby or in the queue.** Their socket drops out of the queue and the
   STANDBY is updated. Pinned in Task 6 (`removing a queued user drops them and updates STANDBY`).
5. **A forged or stale cookie, or a WebSocket from another origin, asks for the pilot role.** It gets
   a spectator seat. Pinned in Task 4 (`unknown or expired cookie is a spectator`) and the existing
   Origin test.

---

### Task 1: Handover in the safety state machine

**Files:**
- Modify: `core/src/safety.h`, `core/src/safety.c`
- Test: `core/tests/test_safety.c`

**Interfaces:**
- Produces:
  - new `safety_t` fields: `uint32_t standby;` (0 = none), `bool handover_pending;`,
    `uint32_t handover_to;` and `fs_reason_t handover_reason;` (a report waiting to be taken; `handover_to` 0 = none)
  - `void safety_set_standby(safety_t *s, uint32_t session);`: ignored while `handover_pending`, and
    when `session == s->session`
  - `bool safety_take_handover(safety_t *s, uint32_t *to, fs_reason_t *reason);`: returns true once
    per handover and clears the report
  - changed: `void safety_pilot_lost(safety_t *s, uint32_t session, int64_t now);` (it needs the time
    for the new session's timer)
  - changed: `void safety_disarm(safety_t *s, uint32_t session);` and new
    `void safety_manual_failsafe(safety_t *s, uint32_t session);`. Both do nothing unless
    `session != 0 && session == s->session`.

- [ ] **Step 1: Write the failing tests** (add them to `RUN` in `main`)

```c
static void test_timeout_with_standby_hands_over_and_keeps_flying(void)
{
    safety_t s;
    armed(&s);                                   /* session 7, cmd at t=0 */
    stick_cmd_t c = { .throttle = 400, .roll = 120 };
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    safety_set_standby(&s, 9);
    safety_tick(&s, 311 * MS);                   /* 301 ms after the last command */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK_EQ_INT(s.session, 9);
    CHECK_EQ_INT(s.standby, 0);
    CHECK_EQ_INT(s.out.throttle, 400);           /* last sticks kept */
    CHECK_EQ_INT(s.out.roll, 120);
    CHECK(s.out.arm);
    uint32_t to; fs_reason_t why;
    CHECK(safety_take_handover(&s, &to, &why));
    CHECK_EQ_INT(to, 9);
    CHECK_STR(safety_reason_name(why), "cmd_timeout");
    CHECK(!safety_take_handover(&s, &to, &why));
    CHECK(safety_control(&s, 9, 1, &LOW, 320 * MS));  /* new session starts at seq 1 */
    CHECK(!s.handover_pending);
}

static void test_pilot_lost_with_standby_hands_over(void);        /* ARMED: no FAILSAFE, session 9, reason pilot_lost */
static void test_handover_pending_no_command_in_300ms_fails_safe(void);  /* after handover at t, tick at t+301 ms with no cmd from 9 → FAILSAFE cmd_timeout */
static void test_no_chained_handover(void);                      /* during pending: set_standby(11) ignored; pilot_lost(9) → FAILSAFE pilot_lost */
static void test_without_standby_timeout_still_fails_safe(void); /* existing behaviour, reason cmd_timeout */
static void test_other_triggers_ignore_the_standby(void);        /* gateway_lost, manual (session 7), rf_lost, session_start(12) while armed → FAILSAFE, standby irrelevant */
static void test_handover_while_disarmed_switches_session(void); /* pilot_lost(7) disarmed with standby 9 → DISARMED, session 9, report taken */
static void test_handover_in_failsafe_keeps_it_latched(void);    /* FAILSAFE, pilot_lost(7) with standby 9 → still FAILSAFE, session 9; ack from 9 works per existing rules */
static void test_old_session_disarm_and_failsafe_ignored_after_handover(void); /* after handover to 9: disarm(7), manual_failsafe(7) → still ARMED; disarm(9) → DISARMED */
static void test_standby_equal_to_active_is_ignored(void);       /* set_standby(7) on session 7 → standby stays 0 */
```

Each one-line test is written out in the same style as the first, with the values in its comment.
Update the existing callers of `safety_disarm(&s)` in this file to `safety_disarm(&s, 7)`, and
change `test_manual_failsafe_from_disarmed` to use `safety_manual_failsafe(&s, 7)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `make -C core test`
Expected: compile errors: `safety_set_standby`, `safety_take_handover`, `safety_manual_failsafe`
are undeclared, and `safety_disarm` has too many arguments.

- [ ] **Step 3: Implement it in `safety.c`**

Write one static `bool try_handover(safety_t *s, fs_reason_t why, int64_t now)`, used by
`safety_tick` (instead of `enter_failsafe(FS_CMD_TIMEOUT)`) and by `safety_pilot_lost` (before its
current body). It returns false when `standby == 0` or `handover_pending`. Otherwise it:
- sets `session = standby`, `standby = 0`, `last_seq = 0`;
- keeps `have_cmd = true` and sets `last_cmd_ns = now` (the fresh 300 ms timer);
- leaves `state`, `cmd` and `out` untouched;
- sets `handover_pending = true` and the `handover_to` / `handover_reason` report.

`safety_pilot_lost` has no `now`: give it a new `int64_t now` parameter
(`void safety_pilot_lost(safety_t *s, uint32_t session, int64_t now)`) and update its callers (Task 2).
`safety_control` clears `handover_pending` when it applies a fresh command. `safety_session_start`
and `safety_gateway_lost` clear `standby` and `handover_pending`.
Update the header's rules comment: one sentence on the standby.

- [ ] **Step 4: Run them and watch them pass**

Run: `make -C core test`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/safety.h core/src/safety.c core/tests/test_safety.c
git commit -m "core: a registered standby takes over on cmd_timeout or pilot_lost instead of FAILSAFE"
```

### Task 2: STANDBY and handover over IPC, in the event log

**Files:**
- Modify: `core/src/ipc_proto.h`, `core/src/mailbox.h`, `core/src/ipcserver.c`, `core/src/rtloop.c`,
  `core/src/evlog.c`, and the `crsf-ctl` source if it calls `safety_disarm` or `safety_pilot_lost`
  (`grep -rn "safety_disarm\|safety_pilot_lost" core/src`)
- Test: `core/tests/test_evlog.c`, `core/tests/integration/core_client.py`, `core/tests/integration/test_core.py`

**Interfaces:**
- Consumes: Task 1's functions.
- Produces:
  - `#define IPC_STANDBY 0x08  /* u32 session; 0 = no standby */` (gw → core)
  - `#define IPC_EVENT_HANDOVER 3  /* detail = fs_reason_t; session = the new active session */`
  - `CMD_STANDBY` in `cmd_kind_t`; `EV_HANDOVER` in `event_kind_t` (a = reason, session = new session)
  - an evlog line `{"ev":"handover","to":<session>,"reason":"cmd_timeout"|"pilot_lost","cmd_age_ms":n}`
  - Python: `STANDBY = 0x08` in `core_client.py`, and `CoreClient.events` collecting decoded IPC_EVENT messages

- [ ] **Step 1: Write the failing tests**

`test_evlog.c`: `test_handover_line`: an `EV_HANDOVER` with a=`FS_PILOT_LOST`, session 9 is written as
`"ev":"handover","to":9,"reason":"pilot_lost"`.

`test_core.py`, new class `HandoverTest(CoreHarness)`:
- `test_standby_takes_over_when_the_pilot_stops_sending`: Pilot A (session 21) arms with throttle 300.
  `client.send(STANDBY, 22)`. A pauses. A second `Pilot(client, session=22, throttle=300)` starts after
  0.35 s. Assert:
  - no `failsafe_on` channels at any point during 1.5 s (`tx.wait_for(self.failsafe_on, timeout=1.5)` is None);
  - ARM stays HIGH;
  - `client.events` gets `{"kind": 3, "detail": cmd_timeout, "session": 22}`;
  - the event log has one `handover` line and no `state` line to FAILSAFE.
- `test_without_a_standby_the_drone_still_disarms`: the same with no STANDBY sent: ARM LOW within 0.45 s.
- `test_standby_that_never_sends_fails_safe_after_the_handover`: STANDBY 22, A pauses, nobody sends
  as 22. Failsafe within 0.75 s of A's last command, `reason_name == "cmd_timeout"`.

- [ ] **Step 2: Run them and watch them fail**

Run: `make -C core test && make -C core integration`
Expected: the evlog test fails (no handover line). The integration tests fail: the core drops the
gateway on the unknown type 0x08 (`bad_msg`), so the channels fail safe.

- [ ] **Step 3: Implement it**

- `ipcserver.c on_msg`: map `IPC_STANDBY` to `CMD_STANDBY`.
- `drain_events`: an `EV_HANDOVER` sends `ipc_encode_event(..., IPC_EVENT_HANDOVER, reason, session)`.
- `rtloop.c apply`:
  - `CMD_STANDBY` → `safety_set_standby`;
  - `CMD_DISARM` → `safety_disarm(s, c->session)`;
  - `CMD_FAILSAFE` → `safety_manual_failsafe(s, c->session)`;
  - `CMD_PILOT_LOST` passes `l->now_ns`.
- After `apply` and after each `safety_tick` call, `if (safety_take_handover(...)) push(l, EV_HANDOVER, reason, ...)`.
- Document 0x08 and event kind 3 in `ipc_proto.h`.

- [ ] **Step 4: Run them and watch them pass**

Run: `make -C core test && make -C core integration`
Expected: `ALL TESTS PASSED`, and `Ran 36 tests ... OK`

- [ ] **Step 5: Commit**

```bash
git add core/src core/tests
git commit -m "core: STANDBY message, handover event to the gateway and in the evidence log"
```

### Task 3: Gateway twin of the new IPC

**Files:**
- Modify: `gateway/src/ipc.js`
- Test: `gateway/test/ipc.test.js`

**Interfaces:**
- Produces:
  - `MSG.STANDBY = 0x08`;
  - `CoreClient#standby(session: number): void` (sends `encodeSessionMsg(MSG.STANDBY, session)`, 0 allowed);
  - `decodeEvent(p)` returns `{ what: 'arm'|'ack'|'handover', refused?: string, reason?: string, session }`.
    For kind 3 that is `{ what: 'handover', reason: REASONS[detail], session }`.

- [ ] **Step 1: Write the failing tests**: `standby is encoded as a session message 0x08`, and
  `a handover event decodes to {what: "handover", reason: "pilot_lost", session: 9}`. Also adjust the
  existing arm/ack decode test if its shape changed: `refused` is kept for arm/ack.

- [ ] **Step 2: Run them and watch them fail**: `npm --prefix gateway test`. Expected: the two new tests FAIL.

- [ ] **Step 3: Implement it** in `ipc.js`, using a kind table `{1: 'arm', 2: 'ack', 3: 'handover'}`.

- [ ] **Step 4: Run them and watch them pass**: `npm --prefix gateway test`. Expected: all pass.

- [ ] **Step 5: Commit**: `git commit -m "gateway: STANDBY and handover in the core protocol twin"`

### Task 4: Accounts, sign-in and cookies

**Files:**
- Create: `gateway/src/users.js`, `gateway/src/auth.js`, `gateway/src/users-cli.js`
- Modify: `gateway/src/server.js`, `gateway/src/config.js`, `gateway/src/hub.js` (only the `attach`
  signature), `gateway/src/relayClient.js`, `deploy/gateway.json`, `deploy/install.sh`
- Test: `gateway/test/users.test.js`, `gateway/test/auth.test.js`, `gateway/test/server.test.js`, `gateway/test/config.test.js`

**Interfaces:**
- Produces:
  - `class UserStore { constructor(file: string); load(): Promise<void>; list(): {name, admin}[];
    verify(name, password): Promise<{name, admin} | null>; add(name, password, admin = false): Promise<void>;
    setPassword(name, password): Promise<void>; remove(name): Promise<void>; get size(): number }`.
    It throws `Error` with `code` = `'exists' | 'unknown' | 'bad_name' | 'bad_password'`.
  - `class Sessions { constructor({ ttlMs = 43_200_000, now = Date.now }); create(user): string;
    get(token): {name, admin} | null; endUser(name): void; delete(token): void }`
  - `class LoginLimiter { constructor({ max = 5, windowMs = 60_000, now }); blocked(name, addr): boolean; fail(name, addr): void; ok(name, addr): void }`
  - `cookieToken(req): string | null` (reads `gcs_session` from `req.headers.cookie`)
  - `authRoutes({ users, sessions, limiter, secure, hub }) → async (req, res) => boolean` (true = handled).
    Routes:
    - `POST /login` (JSON `{name, password}`) → 200 + `Set-Cookie`, 401, 429;
    - `POST /logout` → 204 and the cookie is cleared;
    - `GET /me` → `{name, admin}`, or 401 `{noUsers: boolean}` (true when the store is empty).
    The admin routes come in Task 5.
  - `hub.attach(client, auth = { user: null, relay: false })`, where `auth.user` is `{name, admin}`
    or null. This task only stores it. Task 5 uses it.
  - config: `auth: { usersFile: '/var/lib/gcs/users.json' }` (required: `validateConfig` rejects a
    missing or non-string `auth.usersFile`)
  - CLI: `node src/users-cli.js <usersFile> add <name> [--admin]` (asks for the password on stdin,
    twice, without echo), `list`, `remove <name>`, `passwd <name>`

- [ ] **Step 1: Write the failing tests**
  - `users.test.js`:
    - add, then verify the right password → the user; a wrong password → null;
    - the file is mode 0600 and holds no plain password;
    - bad name, short password, duplicate → the matching `code`;
    - a reload from the file keeps the users;
    - a write goes through a temp file (the original is never truncated: write, then check that the
      original survived a failing write to a read-only dir).
  - `auth.test.js`:
    - the cookie has `HttpOnly`, `SameSite=Strict`, `Max-Age=43200`, and `Secure` only when `secure`;
    - **`unknown or expired cookie is a spectator`**: `sessions.get` → null after `ttlMs` and for a random token;
    - a sixth failed login in 60 s → 429, even with the right password; it's allowed again after the window;
    - `endUser` invalidates all of that user's tokens.
  - `server.test.js`:
    - `POST /login` then a WebSocket with the cookie → `hub.attach` got `auth.user.name === 'ana'`;
    - a WebSocket without a cookie → `auth.user === null`.
    - Update the existing `setup` helper to create a temp users file with `ana`/`correcthorse` (admin)
      and a `login()` helper.
  - `config.test.js`: the config is rejected without `auth.usersFile`.

- [ ] **Step 2: Run them and watch them fail**: `npm --prefix gateway test`. Expected: module-not-found
  for `users.js` and `auth.js`, plus the new server and config tests failing.

- [ ] **Step 3: Implement it**
  - In `server.js`:
    - load the `UserStore` at startup;
    - run `authRoutes` before the video and static handlers;
    - in `upgrade`, resolve `sessions.get(cookieToken(req))` and pass it through `handleUpgrade`, so the
      `connection` handler calls `hub.attach(client, { user, relay: false })`.
  - `relayClient.js` attaches with `{ user: null, relay: true }`.
  - `deploy/gateway.json` gains the `auth` block.
  - `install.sh`: when `/var/lib/gcs/users.json` is missing, print how to create the first admin with
    the CLI as `sudo -u gcs node /opt/gcs/gateway/src/users-cli.js /var/lib/gcs/users.json add <name> --admin`.
  - Bodies over 4 KiB → 413. Anything except `application/json` → 415.

- [ ] **Step 4: Run them and watch them pass**: `npm --prefix gateway test`. Expected: all pass.

- [ ] **Step 5: Commit**: `git commit -m "gateway: pilot accounts (scrypt, users.json), sign-in cookie, CLI"`

### Task 5: Pilot queue, standby and following the core's handover

**Files:**
- Modify: `gateway/src/hub.js`, `gateway/src/server.js` (wire the `event` for handover)
- Test: `gateway/test/hub.test.js`, `gateway/test/server.test.js` (its end-to-end pilot test now signs in with Task 4's `login()` helper)

**Interfaces:**
- Consumes:
  - `core.standby(session)` and the `{what: 'handover', reason, session}` events (Task 3);
  - the `attach` auth (Task 4).
- Produces:
  - browser messages:
    - `welcome {role: 'observer', reason: 'login_required' | null}`;
    - `welcome {role: 'queued', position: n}` (1 = next in line);
    - `welcome {role: 'pilot', session, takeover?: {r, p, y, th, m, sp, tu}}`;
    - `welcome {role: 'queued', position, lost: true}` (old pilot after a handover);
  - from the page: `{t: 'ready', on: boolean}` (queued pages only; others get the observers error);
  - `status` gains `pilotName: string | null` and `standbyName: string | null`;
  - `event {what: 'handover', reason}` broadcast;
  - `hub.activePilotName(): string | null`, `hub.dropUser(name): void` (closes that user's sockets,
    except an active pilot, which Task 6 never asks for).

Rules:
- A client may queue only if `auth.user !== null || auth.relay`.
- `hello {role: 'pilot'}` from anyone else → `welcome {role: 'observer', reason: 'login_required'}`.
- The queue is an array of clients in join order. The head is the active pilot (it gets a session and
  `SESSION` as today when the seat is free). The standby is the first queued client with `ready === true`.
- After any change, if the standby's session differs from the last one sent, call
  `core.standby(standbySession || 0)`. Every queued client has a session from the moment it joins
  (`newSession()`), but only the head's is sent with `SESSION`.
- The hub remembers the last forwarded control (`r, p, y, th, m, sp, tu`) for `takeover`.
- **Active pilot's socket closes:** remove it, then `core.pilotLost(session)`. If a standby was
  registered, wait for the core: the `handover` event with `session === standby.session` promotes that
  client (welcome pilot + takeover, a `tsync`). If the core's next `status` shows `session === 0`
  (no handover), the new queue head (if any) gets the seat with `SESSION` as today.
- **`handover` event while the old pilot is still connected** (`cmd_timeout`): move the old client to
  the back, set `ready = false`, and send it `welcome {role: 'queued', position, lost: true}`.
- `ready` from a client that isn't queued → the observers error.

- [ ] **Step 1: Write the failing tests** (the existing tests use `join(hub)`: give `join` an
  `auth` default of `{ user: { name: 'ana', admin: true }, relay: false }` so they keep passing)
  - `a spectator who asks for the pilot role is told to sign in`
  - `signed-in pilots queue in join order; the second is queued at position 1`
  - `a ready queued pilot becomes the standby and the core is told (STANDBY), not ready → STANDBY 0`
  - `not-ready standby is withdrawn with STANDBY 0`
  - `pilot socket closes with a standby: pilotLost, then the core's handover event promotes the standby with takeover of the last command`
  - `pilot socket closes with no standby: pilotLost, and the next queued pilot gets the seat once status shows session 0`
  - `after a handover the old pilot is queued, not ready, and its commands are refused` (send `ctl` and
    `disarm` from the old client → no `control`/`disarm` calls on the core)
  - `a relay client may queue without a user; it is named "remoto"`
  - `status carries pilotName and standbyName`
  - `dropUser closes a queued user's sockets and updates STANDBY`

- [ ] **Step 2: Run them and watch them fail**: `npm --prefix gateway test`. Expected: the new hub tests FAIL.

- [ ] **Step 3: Implement it in `hub.js`.** Update the header comment's rules: it currently says "no
  take-over".

- [ ] **Step 4: Run them and watch them pass**: `npm --prefix gateway test`. Expected: all pass.

- [ ] **Step 5: Commit**: `git commit -m "gateway: pilot queue, standby registration, follow the core's handover"`

### Task 6: Admin API and page

**Files:**
- Create: `web/admin.html`, `web/js/admin.js`, `web/js/adminview.js` (pure helpers)
- Modify: `gateway/src/auth.js`, `web/css/app.css`
- Test: `gateway/test/auth.test.js`, `web/test/adminview.test.js`

**Interfaces:**
- Consumes: `UserStore`, `Sessions`; from Task 5, `hub.activePilotName(): string | null` and
  `hub.dropUser(name): void` (use a fake hub in `auth.test.js`).
- Produces routes (all need an admin cookie and a same-host `Origin`, else 403):
  - `GET /admin/users` → `[{name, admin, flying}]`
  - `POST /admin/users` `{name, password, admin}` → 201 / 400 `{error: code}` / 409
  - `POST /admin/users/<name>/password` `{password}` → 204
  - `DELETE /admin/users/<name>` → 204, or 409 `{error: 'flying'}` (active pilot), or
    409 `{error: 'self'}`. On success: `sessions.endUser(name)`, then `hub.dropUser(name)`.
  - `GET /admin` serves `admin.html` to admins and redirects to `/` otherwise.
- `adminview.js`: `rowActions({name, admin, flying}, me) → {canRemove: boolean, reason: string | null}`,
  where reason is `'Está volando: no se puede quitar'` or null.

- [ ] **Step 1: Write the failing tests**
  - `auth.test.js`:
    - a non-admin cookie → 403;
    - a missing or foreign `Origin` → 403;
    - add, change password and remove work;
    - removing the flying user → 409 `flying`;
    - removing yourself → 409 `self`;
    - **`removing a queued user drops them and updates STANDBY`**: the fake hub records `dropUser('luis')`,
      and that user's token no longer resolves.
  - `adminview.test.js`: `rowActions` for a flying user, for yourself, and for an ordinary user.

- [ ] **Step 2: Run them and watch them fail**: `npm --prefix gateway test`. Expected: the new route tests 404, and `adminview.js` is missing.

- [ ] **Step 3: Implement the routes and the page.**
  - The page has the layout in spec §4.2: the pilot list, the add form with an «admin» checkbox,
    «Cambiar contraseña» through `prompt()`, and «Salir».
  - It reloads the list every 2 s, so the `flying` flag stays current.
  - It's a phone layout reusing the page's CSS variables.

- [ ] **Step 4: Run them and watch them pass**: `npm --prefix gateway test`. Expected: all pass.

- [ ] **Step 5: Commit**: `git commit -m "gateway, web: admin screen to add, change and remove pilots"`

### Task 7: The pilot page: sign-in, standby, takeover

**Files:**
- Modify: `web/index.html`, `web/css/app.css`, `web/js/app.js`, `web/js/protocol.js`, `web/js/deadman.js`,
  `web/js/sticks.js`, `web/js/keyboard.js`, `web/js/stepper.js`, `web/js/view.js`
- Test: `web/test/protocol.test.js`, `web/test/sticks.test.js`, `web/test/keyboard.test.js`,
  `web/test/stepper.test.js`, `web/test/view.test.js`, `web/test/deadman.test.js`

**Interfaces:**
- Consumes: the Task 5 messages and `POST /login`, `GET /me`, `POST /logout`.
- Produces (pure, tested):
  - `StickModel#seed({x, y})`. The left pad gets `{x: yaw/1000, y: 1 - th/500}`, as in `padPositions`.
    Sprung axes are seeded too, and spring back when the finger first lifts.
  - `KeyboardModel#seed(throttle)` and `StepModel#seed(cmd)`. When the throttle is above `cap`, both
    first raise `cap` to the smallest of `THROTTLE_CAPS` that is ≥ the throttle.
  - `seedInputs(models, cmd)` in `inputmode.js`, which calls the three.
  - `queueText({role, position, lost}, status) → string`, using the UI copy in Global Constraints.
  - `pilotLine(status) → 'Piloto: ana · En espera: luis'`.
  - `Deadman#canSend` takes `{visible, focused, wsOpen}` exactly as today. `app.js` sends only when
    `role === 'pilot'`, and passes `wsOpen: wsOpen()` (no `&& role === 'pilot'`), so a ready standby
    stays engaged.

Page behaviour:
- **No accounts yet** (`GET /me` → `noUsers: true`): instead of the sign-in button, the page shows
  «Todavía no hay cuentas de piloto: créalas en la Pi con users-cli.js (ver docs/HANDOFF.md)».
- **Spectator:** a «Iniciar sesión como piloto» button opens a small form. On success the page
  reconnects with `hello pilot`. On `login_required` it shows «Inicia sesión para pilotar».
- **Queued:** shows `queueText`, the live sticks (from `status.channels` via the existing readouts),
  and a «Listo para tomar el control» button. That button runs the existing `takeControl()` (full
  screen, orientation lock, `deadman.engage()`) and sends `{t: 'ready', on: true}`. Whenever the
  dead-man disengages while queued, the page sends `{t: 'ready', on: false}`. No arm, disarm or
  FAILSAFE buttons while queued (hide the `.pilot-only` controls as for observers).
- **Promoted** (`welcome pilot` with `takeover`):
  - `seedInputs` for the active input mode;
  - flight mode and switches from `m`, `sp`, `tu`;
  - `seq = 0`;
  - the `TIENES EL CONTROL` banner for 3 s, and `navigator.vibrate?.(300)`.
  - The dead-man is already engaged, so the 50 Hz loop starts sending on the next tick.
- **`lost: true`:** the toast «Perdiste el control: ahora vuela {pilot}», and the dead-man disengages.

- [ ] **Step 1: Write the failing tests**
  - **`takeover seeds every input mode from the last command, raising the throttle limit when needed`**:
    `seedInputs` with `th: 450`. Then:
    - touch: `sticksToCommand(...).throttle === 450`;
    - keyboard: `command().throttle === 450` and `cap === 500`;
    - step: `command().throttle === 450` and `cap === 500`.
  - `queueText` for position 1 with a pilot, and for `lost`; `pilotLine` with and without a standby.
  - `deadman stays engaged while the socket is open but the page is not the pilot`.

- [ ] **Step 2: Run them and watch them fail**: `npm --prefix gateway test`. Expected: the new web tests FAIL.

- [ ] **Step 3: Implement the pure functions, then wire `app.js` and `index.html`.**

- [ ] **Step 4: Run them and watch them pass**: `npm --prefix gateway test`. Expected: all pass.

- [ ] **Step 5: Commit**: `git commit -m "web: sign-in, standby (Listo) and takeover from the last command"`

### Task 8: Browser end-to-end tests

**Files:**
- Modify: `gateway/e2e/helpers.js`, `gateway/e2e/pilot.e2e.js`, `gateway/e2e/keyboard.e2e.js`, `gateway/e2e/layout.e2e.js`
- Create: `gateway/e2e/handover.e2e.js`

**Interfaces:**
- Produces: `helpers.js` gets `makeUsers(dir, [{name, password, admin}]) → usersFile` and
  `login(page, name, password)` (fills the form, waits for the queued or pilot view).

- [ ] **Step 1: Update the existing e2e tests** to create a users file and sign in before «Tomar control».
- [ ] **Step 2: Write `handover.e2e.js`**: real crsf-core against the fake TX module (as in
  `pilot.e2e.js`), with two Firefox pages, ana and luis.
  1. ana arms with throttle about 30 %. luis presses «Listo».
  2. ana's page is closed. Assert luis shows `TIENES EL CONTROL`, and the fake TX never sees ARM low.
     The CRSF throttle channel never drops below ana's last value minus 5 % during the first 500 ms.
  3. Then a second run: luis «Listo», and ana presses Esc (A9). The same assertions hold.
- [ ] **Step 3: Run them**: `make -C core && npm --prefix gateway run e2e` (Pi cool, one at a time).
  Expected: 7 tests pass.
- [ ] **Step 4: Commit**: `git commit -m "e2e: sign in before flying; handover on a closed page and on Esc"`

### Task 9: Documentation and the bench checklist

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§5.5, §6.1, §7.4 state diagram + bullet, §8.1/8.2 tables, §12.4 config),
  `docs/HANDOFF.md` (§5 test counts, §6: the login item is resolved for the local gateway and the tunnel; relay still token-only),
  `docs/procedures/m4-pilot-checklist.md`, `deploy/install.sh` comments

- [ ] **Step 1: Update the docs** to describe what was built, including one line in §7.4: "with a
  standby, letting go hands over: Desarmar is the way to stop".
- [ ] **Step 2: Add checklist steps** to `m4-pilot-checklist.md`, propellers off:
  - 15: sign in on the phone as luis, «Listo»; turn off Wi-Fi on the pilot PC → the phone shows
    `TIENES EL CONTROL` and the motors keep spinning;
  - 16: with no standby, the same → FAILSAFE and the motors stop;
  - 17: as admin, «Quitar» on the flying pilot is disabled.
- [ ] **Step 3: Run all five suites** (HANDOFF §5) and record the counts in HANDOFF.
- [ ] **Step 4: Commit**: `git commit -m "docs: accounts, queue and handover in the architecture, handoff and M4 checklist"`
