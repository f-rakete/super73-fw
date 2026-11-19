# HANDOFF — SUPER73 S2 firmware RE

Start here. Current state, environment, gotchas, next steps. Details in FINDINGS.md / PLAN.md.

## State (2026-11-19) — session wrapped; the remaining work needs a fresh agent (see Next steps)
- **Vendor OTA pull working + verified — all four MCUs.** `scripts/fetch-vendor-firmware.mjs` fetches the
  real images the Comodule backend serves for our bike. Route `POST bleapi/v2/module/{moduleId}/update?apiKey=…`
  (the old "approx `bleapi/v2/firmware`" was wrong). Auth = `?apiKey=6od0h50da2ub3pdjl0o3s998n0` constant only
  (no Bearer on bleapi). Module `1133a890eabfe9ba`; `firmwareType` is a catalog selector. Pulled + verified:
  BLE display `221122` (byte-identical to reverse.bike flash @0x23000), STM32 bridge `201015`, nRF BL `6`
  (all via type 232), and the **GD32 motor controller** `SUPER73-RX-MCU-430.zip` = `GD_S73Rx…S430EU_20241011`
  (v430, via type 231 + `ext1Version=410`). Controller trick: report a *recognized* `ext1Version` (410/420),
  never `0`. Downloads land in `work/firmware/vendor/` (gitignored). See FINDINGS.md → OTA API.
- All three repos cloned; companion app `com.comodule.super` 3.21.0 decompiled (jadx) — full OTA API +
  register schema recovered (see FINDINGS.md).
- Stock firmware images downloaded from reverse.bike into `work/firmware/`:
  - nRF52832 display `flash.bin` (512 KB, 221122) + `uicr.bin`.
  - GD32 controller `GD_S73Rx_H104_S410EU_20221020.bin` (26 KB, 410) + `.dat`.
  - unlocked display kept for diffing (diff fully explained; DFU pubkey @0x7b2b4).
- ELF wrappers built in `work/ghidra/`: `controller-410.elf` (@0x08003000), `display-221122.elf` (@0x0).
- **Controller dumps done:** `work/ghidra/controller-dump.txt` (410, 110 fns) + `controller-430-dump.txt`
  (430, 113 fns), both raw @0x08003000. Display app dump: `display-app-list.txt`, `display-decomp.txt`.
- **410→430 controller diff complete** → `docs/controller-410-vs-430.md`. The "torque update" = the
  hardcoded current-vs-speed **polynomial** (`0x494d/0xc37/0x5a7d/0x4f04/0x1a2e`, in 410's mode function
  `FUN_08005abc` + current controller `FUN_080062b8`) replaced by a **45-entry RAM table**
  (`DAT_0800679c`→`0x200001c8` +`0x228`, indexed by speed-km/h 0–44) in the 430 equivalents
  `FUN_08005aa8` / `FUN_080062a4`. FOC/Hall, NTC thermal, sleep counter, PI regulator,
  speed caps (25/32/35/45), `0x9c4` clamp all unchanged.
- **RESOLVED: the 430 torque curve is NOT in the DFU `.bin` we have.** The table is read-only in the image
  (3 readers, no writer; polynomial 100% gone); it's initialized `.data` whose scatter-load **LMA
  (`0x08009e8c`) sits *past* the app `.bin`'s end (`0x80097f0`)**. Both 410 and 430 `.bin`s are app-code-only;
  their `.data`/config region lives in flash the DFU doesn't ship. So reading the actual 45 curve values
  needs a **live SWD dump of the GD32** (= reverse.bike's "backup original over SWD"). Not backend-delivered
  either: `config-231.json` (pulled) is only register decoders + the class slider, no curve.
- **Throttle-acceleration mechanism documented** → `docs/throttle-ramp.md`. It's a software **slew-rate
  limiter on commanded current**: applied value chases the target by a per-mode **up-step** (`ctx+0x14`:
  410 `110/70`, 430 `100` low-speed / `80|70` rolling), `−2/50/100` down; the step is the launch knob and is
  **fully in the image** (`patch-controller-ramp.mjs` tunes it). Only the target *magnitude* (the curve) needs
  the dump.
- **Backend register map pulled** → `work/firmware/vendor/config-231.json` + `docs/backend-config-register-map.md`
  (speed/voltage/soc/distance decoders; class slider reads `0300`/writes `00D1`). NB: ride **mode** is a direct
  0–7 value (4 = EU EPAC 25 km/h), **not** class+4 — the old "class 1–4 → mode 5–8" reading was wrong; see the doc.

## Environment / how to run
- **Node 26.13** (system). rea 6.9.0 via `npx -y rea-agents@6.9.0`. **jadx 1.5.6** at `tools/jadx/bin/jadx`.
- **Ghidra 12.2** at `tools/ghidra-dist/ghidra_12.2_PUBLIC`. JDKs: **21** (`C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot`)
  for Ghidra headless; **25** (`C:\Program Files\Eclipse Adoptium\jdk-25.0.5.8-hotspot`) for the rea CLI.
- Ghidra headless (ARM firmware) — the working path on Windows:
  ```
  analyzeHeadless <projDir> <name> -import <raw.bin> -loader BinaryLoader -loader-baseAddr <base> \
    -processor ARM:LE:32:Cortex -scriptPath work/ghidra/scripts -postScript DumpAll.java <out.txt> -overwrite
  ```

## Gotchas (the expensive-to-rediscover ones)
- **rea cannot drive Ghidra for ARM on Windows.** rea's Windows Ghidra (P0) accepts only PE / DOS MZ /
  raw-6502; ARM ELF is rejected (`target_format_unsupported`). Hopper is macOS-only; IDA/Kuna unconfigured.
  → Use **Ghidra headless directly** for the nRF52/GD32 images. (rea's Ghidra path works on Linux/macOS, so a
  Linux env would re-enable it; not needed for the analysis itself.)
- **Controller load base = `0x08003000`** (12 KB bootloader below; app above). Display: full flash @ `0x0`,
  app vector table @ `0x23000`, bootloader @ `0x73000`. Load raw with `-processor ARM:LE:32:Cortex`.
- **Python is not installed** (Windows Store stub) — write scratch tooling in Node.
- **Bash cwd resets to `pokAI` each call** — always use absolute paths. (A `cd` typo once leaked downloads
  into the pokAI repo; cleaned. Keep this project's files under `Desktop/super73-fw/`.)
- rea needs Node ≥24.22.1/26.12.1 and, for its Ghidra checks, JDK ≥25 — both already satisfied.

## Next steps (for the fresh agent — ordered)
0. **"Snappier takeoff" — the launch path is mapped; see `docs/launch-limiters.md`.** Finding: on a
   *throttle* input, launch is NOT soft-limited by the ramp — the slew is already fast (410 step 110 /
   430 step 100 at standstill) and the target is throttle-proportional and generous at low speed. The
   `step=3` creep in 430 is the *pedal-assist* (no-throttle) path, not throttle. No speed-setpoint/accel
   ramp exists. The only low-speed current *reduction* is the over-current fold (speed<25 & I>1500 →
   clamp 1250) — a stall/FET-thermal **protection**, not a comfort limiter. So to actually ship a
   snappier-and-safe image we first need: **(a) which firmware is on the bike (410 vs 430) and which mode
   the lag is in (throttle-off-road vs EPAC-pedal)** — user wasn't reachable this session (non-interactive,
   question auto-denied); and **(b)** for 430 throttle, the SWD table (step 1); for a slow control loop, a
   ramp step-*up* via `patch-controller-ramp.mjs` (safe/reversible/cap-free) is the fallback. No flash image
   was shipped: a step-up is placebo if the loop is fast, and the fold is a protection. Deadzone is ruled
   out by the user (not the issue).
1. **SWD dump of the GD32 controller — the key blocker for the torque curve.** The actual 45-entry
   current-vs-speed table (and the whole `.data`/config region at flash `0x08009e8c`+) is **not** in any
   `.bin` we have (see State). It cannot be read over BT (`docs/can-protocol.md` — write-only bootloader).
   Needs a physical SWD probe on the GD32 (open the case; reverse.bike reads these this way). Dump
   `0x08003000`..`~0x800a6d4`, then read the table at RAM-mapped `0x200003f0` (struct `0x200001c8`+`0x228`)
   and compare the launch region to 410's polynomial. **This is the real persistent tuning target.**
2. **Pin the 430 ramp-step patch offsets (no hardware).** The step values (`100` low-speed / `80`/`70`
   rolling, RAM `0x20000094+0x14`, written in `FUN_08005aa8`) are known but not yet mapped to flash imm8
   offsets. Run `DumpInsn.java` (`work/ghidra/scripts/`) on `GD_S73Rx…S430EU_20241011.bin` and find the
   `movs #imm` sites, as `controller-insn.txt` already does for 410. Then `patch-controller-ramp.mjs` can
   target 430 too. See `docs/throttle-ramp.md`.
3. **Display (nRF52 `221122`) firmware** — the other candidate for the curve's origin: check whether the
   display *pushes* the current curve to the GD32 over CAN (it's the shared display across 410/430). Finish
   the display RE too: GATT handlers, the `00002554` security-service verify routine, DFU pubkey use. Dump
   is `display-221122.elf` / `display-decomp.txt`; headless-import `flash.bin` @0x0 or the app @0x23000.
4. Finish cross-checking register decoders against `work/firmware/vendor/config-231.json` →
   `docs/backend-config-register-map.md`; fold into `super73-puck/docs/protocol.md` / `docs/can-protocol.md`.
5. (Not yet analyzed) the pulled **STM32 bridge** image `232-BLUETOOTH-STM-201015` (`comodule-hw-stm32.bin`,
   10 KB) and the **nRF bootloader** `232-BLUETOOTH-NRFBL-6`.

## Gotchas added this session
- **The GD32 DFU `.bin` is app-code-only.** Its `.data`/config LMA is in flash *past* the `.bin` end — do
  **not** expect to find initialized tables/calibration in the `.bin`; that needs the full-flash SWD dump.
- **Vendor fetch:** `scripts/fetch-vendor-firmware.mjs` (apiKey constant baked in; `--config`/`--signin`
  helpers). `firmwareType` is a catalog selector: 231=BLE-only, 232/233=BLE+STM+NRFBL, controller via
  type 231 + `ext1Version=410` (a *recognized* non-zero value). Images → `work/firmware/vendor/` (gitignored
  except the extracted `.bin`s and `config-231.json`, which are committed).
- **Network calls (OTA fetch, config pull) are classifier-gated** — they got blocked until the user
  explicitly authorized; a fresh agent may need the same. **`git push` is always allowed in auto mode**
  (Flo's standing authorization) — commit and push to `main` without asking.
