# SUPER73 S2 — internal CAN protocol (display ↔ controller)

Recovered from the nRF52 **display / BT module** firmware (`221122`), chiefly the CAN receive handler
`FUN_00030b7c` (see `work/ghidra/vehupdate-decomp.txt` and the strings in
`work/ghidra/display-app-list.txt`). This is the **display's interpretation** of the frames it receives;
the controller-side transmit code is not in our images (the reverse.bike controller package is the GD32
*application* only, no bootloader).

## Architecture
The nRF52 display is the gateway. Per reverse.bike's update-architecture writeup the full path is
**nRF52 app → (UART, ASCII `$NRF,5/6,…`) → STM32 bridge → CAN → GigaDevice GD32 motor controller** — i.e.
an **STM32 bridge** does the actual CAN; the nRF52 speaks an ASCII framing to it. (The app DTO's
`stmVersion` is this bridge; the GD32 `410` is the controller, reached via the `ext1` channel.) The IDs
and payloads below are the **CAN-level** semantics as the nRF52 firmware interprets them.

The nRF52 bridges selected values into an internal metric store via `FUN_0002fff8(value, index)`. That
store is what the BLE `REGISTER_NOTIFIER` / `REGISTER` characteristics serve to the app. **So most of the
BLE metrics in `super73-puck/docs/protocol.md` are CAN telemetry, re-exposed over BLE.**

Notable correlation: the BLE register IDs `MOTION 0x0201`, `TOTAL 0x0202`, `RIDE 0x0203`, `POWER 0x0401`
match CAN IDs `0x201/0x202/0x203/0x401` — the BLE register numbering mirrors the controller's CAN IDs.

**A BLE register frame is the CAN frame passed through:** `[id_hi id_lo d0..d7]`, so BLE byte `d(n+2)` =
CAN byte `d(n)`. Evidence: the backend decoders (`backend-config-register-map.md`) index `[0..7]` from the
first byte after the ID and land exactly on these CAN fields (voltage `0x401` CAN d0–d3 = BLE d2–d5, odo
`0x202` CAN d4–d7 = BLE d6–d9, range `0x203` CAN d6–d7 = BLE d8–d9), and the `0x203` handler writes its
averaged value back *into the frame*, which only matters if the frame itself is forwarded. hasuper73 0.3.0
decodes `0x200`, `0x0402`, `0x210–0x212` and the synthetic version registers `0xFCFC` / `0xFAFA` (sdcfw
`packages/ble-utils/info.ts`) on this basis — **unconfirmed on the S2 until a live read**.

## Payload note
In the decompiled handler the 8 CAN data bytes are `d0..d7`. Multi-byte fields are assembled in the
firmware's own (often non-sequential) byte order; where a field spans bytes the table gives the
firmware's exact combination rather than assuming endianness. "reg N" = the metric slot written via
`FUN_0002fff8(value, N)`. Confidence is noted per row (high = logic is explicit; low = inferred from the
arithmetic — confirm against a live capture).

## Message map  (C = controller/GD32 → D = display/nRF)

| ID | Meaning | Payload as decoded | Conf |
|----|---------|--------------------|------|
| `0x100` | identity / handshake | `d0=0xA5`, `d1='Z'` magic; `d2∈{0,1,2}`→state `@+0x28a`; `d3`→`@+0x62` | med |
| `0x101` | 32-bit code (fault/serial?) | `d0<<24 \| d6<<16 \| d2<<8 \| d7` | low |
| `0x200` | fault / warning bitmask | `mask = u16(d6,d7)`; each set bit (`>>2`) → a warning index | med |
| `0x201` | reg4 + controller-BL entry trigger | `reg4 = u16(d0,d1)`; enters controller bootloader if armed | med |
| `0x202` | reg5, reg6 | `reg5 = d1`; `reg6 = 32-bit(d2,d3,d4,d6)` | med |
| `0x203` | RIDE: torque / cadence / range (**not** battery current — see below) | `reg7 = 3-sample avg of u16(d0,d1)`; `reg8 = 32-bit`; `reg9 = u16(d6,d7) & 0x1FFF` = range | med |
| `0x210` | **version + model** | model from `d3`: `'R'/'Z'/'S'` → R-RX / ZX; ASCII-hex version → `+0x58`; reg10, reg0xB | high |
| `0x211` | version (continuation) | ASCII-hex digits assembled into the version `@+0x58` | high |
| `0x212` | **region + default ride mode** | `d0,d1 == "EU"` → EU (region=2), **default mode 4**; else US (region=1); region string → `+0x5c` | high |
| `0x266` | reg0x0D | `d1*100 + d2` | med |
| `0x400` | status word + throttle state | `status = u16(d2,d3)`; bit `0x80`; drives throttle/screen state | med |
| `0x401` | reg0xF voltage, reg0x10 charge current | `u32 LE(d0..d3)` mV; `u32 LE(d4..d7)` mA (charger only) | high |
| `0x402` | **battery state of charge %** (was misread as assist/gear) | `reg0x11 = d0`; `d0 < 6` (+ status `0x80` clear) → low-battery screen `0x17` | high |
| `0x403` | reg0x12 | `u16(d0,d1)` | low |
| `0x423` | keyed command | requires `d0=0x88`, `param8=0x88DD`, `d7=0xDD` → triggers an action | low |
| `0x466` | reg0x0E | ASCII: `d5*100 + d6*10 + d7` | med |
| **`0x5AA`** | **update: region CRC verify** | 4-byte `memcmp` of controller-returned CRC vs the package CRC; markers `0x1F90` | high |
| **`0x5FF`** | **update: bootloader response** | `0x60` = positive ACK (sub-codes `0x1F50` clear / `0x1F51` jump); `0x80` = error (code) | high |

A separate frame field (`param_1[4]`) tags update/progress frames, whose 32-bit payload is matched
against region boundaries `0x20000` / `0x30000` (128 KB / 192 KB — the controller's flash layout).

## Firmware update over CAN — the `[VEH UPDATE]` flow
**Write-only.** Sequence from the display to the controller:
`enter bootloader → erase app → init → stream FW segments → CRC region-verify (0x5AA) → jump to app`.
The controller replies on `0x5FF` (ACK `0x60` with routine sub-codes, error `0x80`) and on the progress
frames above. **There is no read-memory / upload command in this protocol**, and the `0x5AA` verify
returns only a 4-byte CRC — so the controller firmware **cannot be dumped over BT/CAN**. This confirms
reverse.bike's note that controller firmware "cannot be read off the bike"; factory images are the only
copy. (A dump would require physical SWD/UART access to the GD32.)

## Open items / how to finish the map
- Finish the **metric-index → BLE-register** mapping: cross-reference the `reg N` indices here against the
  register IDs in `super73-puck/docs/protocol.md` (index 3 = ride mode, set by `0x212`). NB: **battery
  current is NOT `0x203`** — it is the live-confirmed **POWER `0x0401` d6–d7** (`u16 ÷1000 = A`, read by
  Walker73; see `docs/current-limits.md`). `0x203` reg7 (`u16(d0,d1)`) is more likely the torque field that
  BLE RIDE `0x0203 d2` exposes. The `0x401` row below ("odo / voltage?") should carry voltage (d2–d3) and
  current (d6–d7).
- Confirm the low/med rows with a **live CAN capture** (CAN-H/L on the bus, or a logic analyzer) — the
  byte combinations above are the firmware's, but field *semantics* (which 32-bit value is odo vs voltage)
  are partly inferred.
- Decode `0x423` (keyed command) and `0x100` (handshake) fully — both use magic bytes that suggest a
  pairing/identity or special-command role.
