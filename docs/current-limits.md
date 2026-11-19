# Motor-current / power limits (GD32 controller `410`) and how to observe them

The real performance ceiling — unlike the throttle rise-rate (`throttle-ramp.md`, a sub-second
smoothing knob, **not** performance) and the top-end speed roll-off (`launch-limiters.md`). This is
the current the FOC regulator is *allowed to command*, i.e. torque and acceleration.

Scope reminder: unlimited mode, throttle-only. Offsets are file offsets (image base `0x08003000` for
these dumps; add `0x800` for reverse.bike's `0x08003800` convention). Evidence:
`work/ghidra/controller-410-limits-insn.txt` (full `FUN_08005abc` + `FUN_080062b8` instruction dump),
`controller-dump.txt` lines ~3006–3090.

## The limit is a battery-current-gated motor-current ceiling

In `FUN_08005abc` the motor-current command (`uVar43`, what the ramp chases and the PI regulates to) is
capped at one of `300 / 450 / 1250 / 1875`, **selected by the measured battery current** `*DAT_08006330`:

| battery current window | motor-current ceiling |
|---|---|
| `< -200` | 0 (regen/fault) |
| `< 0` (normal) | **1250** (`0x4e2`) |
| `0 .. 50` | 300 / foldback |
| `50 .. 500` | 450 (`0x1c2`) |
| **`500 .. 650`** | **1875 (`0x753`) ← peak** |
| `650 .. 700` | 450 + flag |
| **`> 700`** | **0 — hard cutoff** |

Final demand `= min(throttle-derived target, this ceiling)`, so at full throttle **this ceiling binds**.
The FOC regulator saturates far higher (`0x7fff`), so the ceiling — not the regulator — is the limit.

### The constants (exact patch sites)

| constant | value | addr | file off | bytes | role |
|---|---|---|---|---|---|
| `0x753` | **1875** | `0x0800638c` | `0x338c` | `40 f2 53 70` (`movw r0,#0x753`) | peak motor-current cmd (500–650 window) |
| `0x4e2` | **1250** | `0x080063ca` | `0x33ca` | `40 f2 e2 43` (`movw r3,#0x4e2`) | normal ceiling (foldback assignment) |
| `0x4e2` | **1250** | `0x080067f6` | `0x37f6` | `40 f2 e2 44` (`movw r4,#0x4e2`) | same ceiling, re-clamped under a status gate |
| `0x2bc` | **700** | `0x080063ae` | `0x33ae` | `b1 f5 2f 7f` (`cmp.w r1,#0x2bc`) | battery-current cutoff → demand 0 |
| `0x5dc` | **1500** | `0x08006766` | `0x3766` | `40 f2 dc 50` (`movw r0,#0x5dc`) | over-current-while-slow (stall) trip |

Battery-current window thresholds: `0x1f4`=500 (`0x08006378`), `+0x96`=150→650 (`0x0800637c`),
`0x28a`=650 (`0x08006396`). All are `movw`/`cmp.w` — 4-byte edits, not clean `imm8`.

## What raising them does, and the gating catch

- Raise `0x4e2` (both sites together, or the clamp pulls it back) → higher **sustained** motor current = more torque.
- Raise `0x753` → higher **peak** burst.
- **But** everything is gated by the `700` battery-current cutoff: command more motor current and battery
  current climbs; hit `700` and the controller cuts to **zero** (stutter/cutout, not power). Real sustained
  gain also needs raising `700` — which directly means **drawing more battery amps**.

## Risk (this is the mod that can destroy hardware)

More current = more I²R heat in the MOSFETs and motor windings. Stock `1250/1875/700` are presumably near
the hardware's safe envelope. Overrun risks: MOSFET desaturation/short (→ fire), motor overheating /
permanent **demagnetization**, BMS trip / cell stress / thermal event. The `1500` trip and `700` cutoff
**are** the protections — weakening them removes the safety net at launch/stall under load. `1250/1875` are
internal command units, not amps, so **actual headroom is unknown** (could be ~0).

**Signal:** reverse.bike (who derestrict these commercially) **do not touch current on the H104** — only
mode-unlock + speed roll-off + rise-rate. They raised baked power config on the FTEX and nudged the ZX 404
low-speed allowance, but left the H104 current ceilings alone. Likely already near the hardware limit.

**Defensible test path:** +~15% on the ceilings only (`0x4e2`→~1437, `0x753`→~2062), **leave `700` and
`1500` intact**, then a monitored ride before deciding to go further. Moving `700` is the dangerous step.

## Observing battery current over BLE (for monitoring + unit calibration)

Battery current — the same quantity the foldback gates on (`*DAT_08006330`, the `700` cutoff) — **is
broadcast over BT in the POWER register `0x0401`, and Walker73 already reports it** (our super73-puck /
hasuper73 decode the same field). Per `super73-puck/docs/protocol.md` (Walker73-based, live-confirmed on
our S2):

- **POWER `0x0401`, d6–d7: `u16 LE charge current, ÷1000 = A`** (Walker73's wiki marks d5–d6, but both
  codebases read `[6:8]`). d2–d3 of the same register is battery voltage in mV (our S2 read 53.93 V).
- The **official Comodule app does not surface current** — its backend decoder
  (`backend-config-register-map.md`) extracts only *voltage* from `0x0401`. The current bytes (d6–d7) are
  physically in the register; Walker73 / community tools read them, the stock app ignores them.

So to log battery amps live during a current-limit test: **run Walker73**, or read POWER `0x0401` and decode
`u16(d6,d7)/1000` via the super73-puck / hasuper73 BLE path — no custom firmware needed. This gives (a) a
live **monitor** of battery draw, and (b) a way to **calibrate** the `700` cutoff and the `500/650` foldback
windows to real amps. It is *battery* current (the foldback's gating variable), not the motor-command units
(`1250/1875`), which are a separate quantity.

Caveats: the field is labelled "charge current" — confirm it tracks discharge/load current (a quick
throttle-load read), not only charging; and neither of our codebases *surfaces* it yet (they decode the
location). **Corrections:** an earlier draft of this doc put current in reg `0x0203 d0–d1` — wrong; BLE
`0x0203` is RIDE (cadence/range/torque). And `docs/can-protocol.md`'s "`0x203` = battery current (reg7)" is
suspect: super73-puck reads BLE `0x0203 d2` as *torque*-related, so CAN `0x203` reg7 is probably torque; the
authoritative battery-current source is **POWER `0x0401 d6–d7`** (Walker73-confirmed).
