# Software control latency

Approved conversational design: measure network (browser send to gateway handler), gateway
(handler to core socket submission), and core (including socket transit, mailbox scheduling,
encoding and successful full serial write). Endpoint is kernel serial submission, not radio
module reception. No additional hardware. Local and tunnel results must remain separate.

Correlate browser manifest, gateway JSONL and core JSONL by session and sequence. Browser
timestamps use performance.now(); gateway estimates offset from existing clock exchange and
records RTT/2 as uncertainty with the age of that sample. Pi timestamps use CLOCK_MONOTONIC
(Node process.hrtime.bigint()). Missing, duplicate, unsynchronised, stale, suppressed and
superseded commands cannot silently disappear from the denominator. Qualification requires
10,000 sent commands, local routing, complete trace integrity and at least 90% conservatively
within 50 ms. Estimated results are also shown. This does not certify the hardware endpoint.

Tracing is opt-in. Browser capture is bounded, exported as JSON through a console helper;
gateway uses its bounded asynchronous connection logger. Core uses its bounded event mailbox
and IPC writer, never file I/O in the real-time loop. A full serial write is logged once per
new active command; failsafe/disarmed outputs do not count as command delivery. Existing safety
and IPC wire formats remain unchanged. Do not change live services until checks pass.

Approaches: software tracing alone (selected by user); software plus wire capture (declined).
