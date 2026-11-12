# Readiness for sparse flight-mode telemetry

Status: follow-up bug fix authorized by user “continue”; user confirmed disarmed/ready and core check confirmed DISARMED.

Evidence: the reviewed actual-frame publication fix is installed, but the physical Aquila20 still sends no new mode report over10s while93core status and42link packets arrive with100%LQ. Treating a mode value as a500ms heartbeat is incompatible with this observed reporting behavior. Mode is last-confirmed state, not a heartbeat. The prior C fix stays: repeat actual reports are still forwarded when available.

New readiness contract: keep an actual Normal mode confirmation across silence in mode reports while requiring fresh (<500ms) core status AND positive RF link telemetry, the current pilot/session, ARMED, requested/on-air Normal and Turtle off. Do not invent mode telemetry or renew its received timestamp. Invalidate confirmation on RF loss/staleness, core loss/staleness/reconnect, entry to failsafe/hold/landing, and requested or observed flight-mode/Turtle changes. Fresh RF recovery alone cannot restore an invalidated mode confirmation: a new Normal report is needed. Existing core snapshot establishes last-known state on a connection, not evidence of a recent physical mode packet; it is still conditioned on live RF/core status. Browser cached telemetry replay must not independently authorize voice.

One authoritative gateway readiness computation serves HTTP pre/post checks and an additive status.voice={ready,reason}. Browser requires that flag plus its own current pilot, engagement, visibility, connection, neutral manual inputs, desired Normal/Turtle-off and fresh status checks. Missing/legacy flags fail closed. No arming, throttle or core failsafe change.

Feedback reports one short missing prerequisite with full accessible text rather than a truncated list. Reconfirmation after an RF interruption uses the existing manual mode controls while disarmed; no automatic mode cycling, arming or failsafe clearing. Other policy/input/API behavior remains unchanged.

The change is first tested with fake radio/core/provider only. Service deployment is forbidden while ARMED/HOLD/LANDING/FAILSAFE: require actual DISARMED and operator sudo. Do not read keys or make live API/aircraft commands.
