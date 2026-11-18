# GD32 motor controller: stock 410 vs vendor 430 — what changed

Diff of the two **GD32** motor-controller images, both loaded raw @`0x08003000`
(`ARM:LE:32:Cortex`, reset `0x08003901`):

- **410** — `work/firmware/controller-410-stock/GD_S73Rx_H104_S410EU_20221020.bin` (26,200 B, 2022-10-20)
- **430** — `work/firmware/vendor/SUPER73-RX-MCU-430/GD_S73Rx_H104_S430EU_20241011.bin` (26,608 B, 2024-10-11), pulled from the vendor OTA

Dumps: `work/ghidra/controller-dump.txt` (410) and `work/ghidra/controller-430-dump.txt` (430).
Functions: **410 = 110, 430 = 113** (+3). IRQ vector table: 55 populated handlers in both → **no new
peripheral/ISR** (the "torque" change reuses the existing ADC/timer/Hall paths, not new hardware).

## Headline: the "torque update" = a polynomial replaced by a lookup table

The low-level current/torque-vs-speed curve was **hardcoded as a piecewise polynomial** in 410 and is a
**runtime table** in 430. This shows up identically in both the ride-mode function and the current
controller.

**410** (`FUN_08005abc` mode table, `FUN_080062b8` current ctrl) — piecewise polynomial of the
throttle/speed input `x`:
```
x < 100          -> 0x494d
100 <= x < 0x146 -> (x*0xc37)/-0x46 + 0x5a7d
0xaa <= x <0x1f4 -> (x*0x22e8)/K    + 0x4f04
else             -> 0x1a2e
```
**430** (`FUN_08005aa8`, `FUN_080062a4`) — the polynomial is **gone**, replaced by a 45-entry table:
```
idx = unaff_r7 (0..0x2c)         // speed/throttle step, bounded at 45
curve = *(int*)(struct + idx*4 + 0x228)   // fallback entry at +0x2dc for idx>=45
```
The table lives at **`struct+0x228`** where `struct` = `DAT_0800679c` → **`0x200001c8` (RAM)**, i.e. it is
populated at runtime (per ride mode / from config), not a constant in this image. Marker counts confirm the
swap: polynomial constants (`0x494d/0xc37/0x5a7d/0x4f04/0x1a2e`) appear **8× in the 410 mode table, 0× in
430**; the `idx*4 + 0x228` table read appears **0× in 410, 6× in 430** (same story in the current
controller). The `×0x22e8`, `/0x9c4` (2500 = 25.00 km/h) normalization and the `×0x5a`/`×0x55` (90%/85%)
throttle scaling are **unchanged** — only the *shape source* of the curve changed (fixed → tunable table).

**Why this matters for tuning:** the assist/torque curve is now **per-index data**. The low-index entries
(low speed) set launch/low-speed torque directly, where 410 forced the fixed `0x494d` floor. This is the
cleanest lever for torque feel, including off-the-line.

## The start/throttle ramp was re-tuned and is now per-mode

The dead-start ramp (see `docs/throttle-ramp.md`) is the step written to the mode struct `+0x14`, toward
which the throttle demand climbs each control tick. Larger step = faster/snappier launch.

- **410**: one mechanism — step **`0x6e` (110) at standstill / `0x46` (70) rolling**, field incremented by
  `0x14` (20); two write sites.
- **430**: per-mode / per-condition steps written to `+0x14` — observed immediates **`100` (standstill)**,
  **`0x50` (80)** and **`0x46` (70)** (rolling, mode-dependent), and **`0x6e` (110)** for others; ~10 write
  sites. So some modes now launch *softer* than 410 (100 vs 110 standstill) and roll-on differs by mode.

**Where to adjust the start ramp on 430:** same place as the 410 patch (`scripts/patch-controller-ramp.mjs`
targets the `0x6e`/`0x46` imm8s) — but on 430 the relevant immediates are the per-mode `100`/`0x50`/`0x46`/
`0x6e` `movs` values in `FUN_08005aa8` that feed `+0x14`. The **new torque table** (above) is the second,
finer lever: its first few entries govern the current commanded at low speed.

## Structural changes (not behavioural)

- **Battery/thermal foldback inlined** into the current controller: `FUN_080062b8` (1072 B) → `FUN_080062a4`
  (1286 B, **+214 B**). The front of 430's function now does the battery-current foldback directly (reads
  `DAT_08006368`; thresholds −200 / +200 / `0x32` / 500 / 699 → targets `400`/`0x1c2`(450)/`0x4e2`(1250)/
  `0x753`(1875)), which in 410 lived separately. Same targets, same `0x7fff` full-scale clamp.
- **+3 functions net** (110→113), incl. a new ~142 B function (`~0x08006a68`) right after the current
  controller — likely the extracted foldback/table helper (not yet named).
- Mode table `FUN_08005abc`→`FUN_08005aa8` grew only +2 B.

## Unchanged (same function, shifted address)

- **FOC / Hall** angle+velocity (`FUN_08005854`→`FUN_08005840`, 592 B, identical size).
- **NTC thermal** linearisation (`FUN_08006834`→`FUN_08006810`, 438 B).
- **Standstill/sleep** zero-current counter → driver disable (`FUN_08008192`→`FUN_080081e2`): same 5/99-cycle
  logic, same enable/disable calls.
- **Speed caps** 25 (`0x19`) / 32 (`0x20`) / 35 (`0x23`) / 45 (`0x2d`) and the `0x9c4` (2500) speed clamp are
  all still present; the per-mode cap wiring moved toward the RAM config struct but the values are the same.
- **PI regulator** (`FUN_08006b24`→`FUN_08006b00`) and the over-current trip (`>0x5dc` while slow) unchanged.

## Next steps

1. Find where the `0x200001c8+0x228` torque table is **populated** (init memcpy from flash, or filled from the
   CAN/BLE config): that flash source is the persistent tuning target for the whole current-vs-speed curve.
2. Dump the table live (or from the RAM init image) for each ride mode and compare the launch region to 410's
   polynomial-evaluated values.
3. Confirm the `unaff_r7`/`uVar46` index units (km/h vs throttle step) from the Hall-speed feed at `MC+0x12c`.
