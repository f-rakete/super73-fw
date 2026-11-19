# What limits takeoff from a standstill (GD32 controller `410` & `430`)

Goal of this note: find the mechanism behind a sluggish/"not snappy" dead-start, and separate it
from the throttle *ramp* (slew) already covered in [throttle-ramp.md](throttle-ramp.md). Two candidate
mechanisms were checked head-on: **(1) a current limit that bites when starting from zero**, and
**(2) a speed ramp / acceleration limiter**. Evidence: `work/ghidra/controller-dump.txt` (410,
`FUN_08005abc` + `FUN_080062b8`), `work/ghidra/controller-430-dump.txt` (430, `FUN_08005aa8`),
`work/ghidra/controller-insn.txt`.

## Headline: throttle launch is NOT soft-limited by the ramp

On a **throttle** input from a dead stop, the commanded-current slew is already fast on both builds:

- **410** — `FUN_08005abc` case 3/7: on throttle (`throttle_raw > min + deadzone`) the per-tick step is
  `0x6e` (110) at standstill (`speed_index < 0x10`), `0x46` (70) rolling.
- **430** — `FUN_08005aa8` case 1: on throttle the step written to `struct+0x14` is `100` at standstill
  (line 2705), `0x50` (80) rolling (line 2708).

### The `step = 3` creep is the pedal-assist path, not the throttle path
In 430 the step is written to **`3`** (a very slow creep) only on the **no-throttle** branch
(`uVar34 != 0`, throttle inactive — lines 2670/2695/2746/2765/2819/2848/2882/2994). The instant
`throttle_raw > min+deadzone`, it jumps to `100`/`80`. So PAS-without-throttle crawls; throttle does not.
If a sluggish launch is felt **while pedalling in EPAC/mode 4**, this creep + PAS engagement is the cause,
and it is a different knob set from the throttle path.

## Hypothesis 2 (speed ramp / accel limiter): NOT FOUND

No speed-setpoint ramp or d(speed)/dt limiter is present on the throttle path. The only rate limits are
**current** slews (the fast step above, plus a separate `+5/cycle ≤2000` pedal-path ramp that is not on
the throttle path). What *looks* speed-related is a set of **top-end governors**, every one of which gives
*more* headroom at low speed and tapers as speed rises — i.e. they pull current *in* as you speed up, the
opposite of a launch limiter:

| where (410) | scale `iVar17` applied as `target·iVar17/100` | at speed 0 | behaviour |
|---|---|---|---|
| off-road default (modes 3/6/7/9), throttle active | `475 − 1.25·speed` (`0x1db`, `0x7d`) | **4.75×** | max at 0, →0 at speed 380 |
| case 6 | `2300 − 5·speed` (`0x8fc`) | **23×** | decreasing |
| case 0 / mode-0 fallback | `0x172 − speed` | large | decreasing |
| 410 torque polynomial | `speed < 100 → 0x494d`; else → `0x1a2e` | **highest branch** | more torque at low speed |

So the target current at a standstill is essentially **throttle-proportional and generous**; nothing in
the speed-scaling path starves launch.

## Hypothesis 1 (current limit from zero): one real home — but it's a PROTECTION

The single place a low-speed state actively pulls current *down* is the **low-speed over-current fold** in
the tail of `FUN_08005abc`:

```
// speed < 25 AND current > 1500 -> accrue a counter, cap 300, set a status flag
if ((*DAT_080067a4 < 0x19) && (0x5dc < current)) counter[+0x11c]++;
if (300 < counter[+0x11c]) { counter = 300; status |= 0x100; }
if (current < 0x9c) { counter = 0; status &= ~0x100; }   // resets below 156
...
// elsewhere, a status bit clamps the demand to 1250 at low speed:
if ((status & bit12) && 0x4e2 < demand) demand = 0x4e2;   // line ~3088
```

Constants: `0x5dc` = **1500** (current trip), `0x19` = **25** (speed gate), `300` ticks, `0x4e2` =
**1250** (clamp), `0x9c` = **156** (reset). Under a hard dead-start pull (high current + low speed = exactly
a launch) this is what bogs the bike and then lets go as speed builds — it matches a "power held back at the
very start" feel. **It is a stall / FET-thermal protection, not a comfort limiter**, so raising it trades
launch bite against motor/MOSFET heat at stall. Do not weaken it blind.

Patchability: the trip/clamp magnitudes (`1500`, `1250`) are `movw`/literal-pool loads (multi-byte), not
clean `imm8`s; the `25` speed gate is a `movs`. These sites sit **past** the current `controller-insn.txt`
coverage (which ends at `0x080062b2`); pinning their file offsets needs a `DumpInsn.java` pass over
`0x080062b2`..end before any edit.

## The 430 launch-torque magnitude is not in the `.bin`

If the bike runs **430**, the launch *magnitude* (low-speed current the ramp chases) comes from the 45-entry
RAM table whose low-index entries set off-the-line torque. That table's init data has an LMA past the app
`.bin`'s end (see [controller-410-vs-430.md](controller-410-vs-430.md)) — it cannot be read or reshaped from
any image we have; it needs the **SWD dump** (HANDOFF next-step #1).

## Net: to make takeoff snappier, safely, the next step is one of

1. **Confirm firmware + launch mode** (410 vs 430; throttle-off-road vs EPAC-pedal). This decides the lever:
   - *410 + throttle:* already fast-slewing and throttle-proportional; the only low-speed current lever is
     the over-current fold above (a protection — raise with care, bench-watch temps) **or** raise the
     throttle→current gain, which has no clean single-byte site on the off-road path.
   - *430 + throttle:* needs the SWD table dump to touch launch magnitude.
   - *EPAC/pedal:* it's the `step=3` creep + PAS engagement, not the throttle path.
2. **Bench-measure the control-loop rate** (the open unknown in throttle-ramp.md). The "slew is near-instant"
   conclusion assumes ≥500 Hz; if the loop is slow, a ramp step-up *does* help and is the safe, reversible,
   cap-free lever (the existing `patch-controller-ramp.mjs`, run upward instead of down). If the loop is fast,
   step-up is placebo — which is why no step-up image is shipped here yet.

Nothing in this note changes any speed cap, the `0x9c4` (25 km/h) clamp, road-legal mode 4, or pedal-assist.
