# Throttle dead-start ramp — calculation & patch notes (GD32 controller `410` stock & `430`)

Scope: the throttle-from-standstill "start curve" in the **unlimited/off-road** modes (3 US / 7 EU).
Pedal-assist is intentionally left alone. **Project-wide this is the only modification scope: unlimited
mode, throttle-only** — EPAC/mode 4 and PAS are never patched, and no speed-cap changes. Source:
`work/ghidra/controller-dump.txt` (`FUN_08005abc` mode logic + the rate limiter) and
`work/ghidra/controller-insn.txt` (exact immediate offsets).

## The ramp model
The applied current/torque demand `ramp = *(ctx_0x08006778 + 0x14)` chases the instantaneous throttle
target `T` by a bounded step **each control cycle**:

```
if (ramp < T)      ramp += step_up        // per-mode (iVar18), or the base +0x14 (20) far from target
else if (ramp > T) ramp -= step_down      // 2 (normal) / 50 (speed<4) / 100 (mode-flag)
```
- Off-road throttle target: `T = throttle_raw - throttle_min - 250` (deadzone `0xfa` = 250).
- `T` is in internal current-command units: operational ceiling ≈ **1250** (`0x4e2`, gated by a status
  bit), thermal/battery foldback moves it `1875 / 1250 / 450 / 300`, hard saturation **`0x7fff`**.
- A secondary pedal-path ramp (`+5`/cycle, ≤2000) also exists but is not on the throttle path.
- **Up-ramp always uses the per-mode step.** The code is `if (ramp < target+step) ramp += step; else
  ramp += 20`, but the outer guard already requires `ramp < target` with `step > 0`, so the inner test
  is always true for a non-negative demand → the `+20` base branch is effectively dead on the off-road
  throttle path. The "step 20 (base/far)" rows in the tables below are reference only, not an operative
  regime; the stock accelerate step is always 110 (standstill) / 70 (rolling).

### Step constants (the knobs) + patch offsets (image base `0x08003000`; file off = addr − 0x3000)
| what | value | instr addr | file off | bytes |
|---|---|---|---|---|
| mode 3 standstill step | 110 (`0x6e`) | `0x08005e4e` | `0x2e4e` | `6e 22` |
| mode 3 rolling step | 70 (`0x46`) | `0x08005e52` | `0x2e52` | `46 22` |
| mode 7 standstill step | 110 (`0x6e`) | `0x080060f0` | `0x30f0` | `6e 22` |
| mode 7 rolling step | 70 (`0x46`) | `0x080060f4` | `0x30f4` | `46 22` |
| deadzone (+250) | `0xfa` | `0x08005bb8` | `0x2bba` | `…fa…` |
| deadzone (−250) | `0xfa` | `0x08005bde` | `0x2bde` | `fa 3b` |
Each step/deadzone is a single imm8 (first byte of a `movs #imm`). On deploy the `.dat` **cannot** be
recomputed — it is a Nordic signed init packet (SHA-256 + 64-byte ECDSA P-256) matching the *stock*
image and can't be re-signed. Flash via a path that does not verify it against the image (reverse.bike
flasher / SWD confirmed; stock-display `ext1`/CAN push unconfirmed); the controller's own CAN-level
check is a 4-byte CRC the transport recomputes. See FINDINGS "Update authenticity" / GD32 image.

## Time = cycles × loop-period
The ramp updates in the main control step `FUN_080090f0`, which runs the chain
`… → FUN_08005abc(ramp) → …` **only when a control flag (`ctx[1]`) is set by an ISR** — so the ramp
advances once per **control-loop tick**, not once per CPU cycle.

Cycles to climb 0 → operational full (`≈1250`):
| step | cycles (0→1250) | cycles (0→1875 peak) |
|---|---|---|
| 110 (standstill) | ≈ 11 | ≈ 17 |
| 70 (rolling) | ≈ 18 | ≈ 27 |
| 20 (base/far) | ≈ 63 | ≈ 94 |

Wall-clock, for 0→1250, across the plausible control-loop rate (the unknown — see below):
| loop rate | period | step 110 | step 70 | step 20 |
|---|---|---|---|---|
| 500 Hz | 2 ms | 23 ms | 36 ms | 125 ms |
| 1 kHz | 1 ms | 11 ms | 18 ms | 63 ms |
| 2 kHz | 0.5 ms | 5.7 ms | 9 ms | 31 ms |
| 8 kHz | 125 µs | 1.4 ms | 2.2 ms | 7.8 ms |
| 16 kHz | 62.5 µs | 0.7 ms | 1.1 ms | 3.9 ms |

**Takeaway:** at the stock `step=110`, dead-start throttle reaches full in ~0.7–23 ms — i.e. effectively
**instant/abrupt** at any realistic loop rate. For a *perceptible* soft launch you must cut the step hard.
A `movs` imm8 is 1…255, so:
- At a ~1 kHz loop: `step=4` → ~0.3 s to full; `step=2` → ~0.6 s; `step=1` → ~1.25 s.
- At a ~16 kHz loop: the slowest possible (`step=1`) is still only ~78 ms — this ramp alone can't make a
  slow launch, so a fast loop would need a different approach (e.g. scaling the *target* rise).

The **change is deterministic and linear regardless of the loop rate**: halving the step doubles the
ramp time. So the handoff session can patch `0x2e4e`/`0x30f0` to a chosen value and the rider feel scales
proportionally; only the *absolute* seconds depend on the loop rate.

## The one open value: control-loop frequency
Not pinned from static analysis — it's set by TIMER0 (`0x40012C00`, advanced/PWM timer) ARR/prescaler and
the RCU PLL system clock, which are obscured by register-pointer indirection and a stretch of timer-init
code that didn't cleanly disassemble. Two ways to nail it:
1. **Bench measure (recommended, 5 min):** scope the motor PWM (→ PWM freq) and/or log throttle-step →
   current-rise time; or toggle a GPIO in the control ISR and measure its period.
2. **More RE:** extract the GD32 RCU PLL config + TIMER0 ARR/PSC (resolve the timer-init DAT pointers),
   and confirm which ISR sets `ctx[1]` (candidates: ADC `IRQ18`, TIMER0-update `IRQ25`, or a slower
   general timer `IRQ28/29`).

ISR map (GD32F103-style, from the vector table): `IRQ18`=ADC, `IRQ20`=CAN-RX, `IRQ23`=EXTI (halls),
`IRQ24-26`=TIMER0 brk/up/trg, `IRQ28/29`=TIMER1/2.

## 430 (`S430EU_20241011`) — same slew limiter, softer low-speed step, data-driven target

Confirmed in `work/ghidra/controller-430-dump.txt` (current controller `FUN_080062a4`, mode function
`FUN_08005aa8`). The **mechanism is unchanged** — the same bounded slew on the commanded current:
```
applied = *(0x20000094 + 0x18)                  // DAT_0800677c / DAT_08005eb4 struct
if (applied < target)  applied += step(+0x14)   // far from target; +0x14 / +2 near it
else                   applied -= 2 / 50 / 100  // normal / speed<4 / mode-flag
*(ctx + 0x10) = -applied                          // → FOC current PI regulator → motor
```
What changed vs 410:
- **Up-step is per-mode and softer at low speed.** Written in `FUN_08005aa8` to `0x20000094+0x14`:
  low speed (speed index `< 0x10`) → **100**; rolling → **80** (`0x50`) or **70** (`0x46`), mode-dependent
  — vs 410's **110 / 70**. (A separate `step = 3` branch exists for a low-demand/creep condition.) So 430
  launches a touch gentler from a stop (100 vs 110) and roll-on differs by mode.
- **Target moved from a polynomial to a data table.** 410 computed the current ceiling the ramp chases
  from a piecewise polynomial; 430 reads it from a 45-entry current-vs-speed table in `.data` whose LMA
  sits *past* the app `.bin` (needs an SWD dump — see `docs/controller-410-vs-430.md`). This sets the
  target *magnitude/shape*, **not** the ramp *rate*.

Not yet pinned: the exact imm8 file offsets of the 430 step constants (a `DumpInsn` pass on the 430 image,
as `controller-insn.txt` gives for 410). The values and RAM location (`0x20000094+0x14`) are known; only
the flash patch offsets remain.

## Net conclusion — how throttle acceleration is implemented (both builds)

Throttle acceleration is a **software slew-rate limiter on the commanded motor current**, not a direct
throttle→current map:
1. a per-mode **up-step** (`ctx+0x14`: `110/70` on 410, `100/80|70` on 430) caps how fast the applied
   current climbs toward the target each control tick — this is the launch/snappiness knob;
2. the **target** is throttle/assist run through the speed-curve (410 polynomial / 430 table), ×90–85%
   throttle scale, clamped to the per-mode speed cap (`0x9c4` = 25 km/h EU), with battery/thermal foldback;
3. the ramped value feeds the **FOC current PI regulator** → motor.

The ramp *rate* and its step constants are **fully in the firmware image** for both builds — this is what
`patch-controller-ramp.mjs` tunes. The 430 torque **table** only reshapes the *target magnitude* per speed
and is the one piece needing an SWD dump; it does **not** change the ramp dynamics.
