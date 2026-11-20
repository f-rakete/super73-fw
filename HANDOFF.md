# HANDOFF — SUPER73 S2 firmware RE

Start here. Current state, environment, gotchas, next steps. Details in FINDINGS.md / PLAN.md.

## State (2026-11-20) — session wrapped; **next session = current limiting factors** (Next steps #0)
Worked the performance angle + the reverse.bike reference. New docs this session:
- **`docs/reverse-bike-patches.md`** — cloned `reverse-bike/sdcfw` (read-only, `work/sdcfw/`, gitignored;
  Bun/TS pipeline, `apps/kitchen/patches/*` = annotated stock→custom byte diffs). Their **310 off-road**
  patch is a **byte-verified port to our 410** (force internal mode 3; disable mode 3/7 speed roll-off;
  throttle rise-rate 110/70→150; double q-axis current filter 38→76). **CORRECTION: controller load base is
  `0x08003800`, not `0x08003000`** — file offsets unaffected (our patch offsets still hold), but Ghidra
  absolute addresses were 0x800 low. **Deploy confirmed:** patched `.bin` + **stock `.dat`** over the display
  BLE DFU (GD32 doesn't verify the sig) — no SWD needed for H104. No 430 byte-patch exists (RAM-table holds).
- **310 US vs 410 EU are the same firmware** (same doc): 88/26,200 bytes differ, 4 real diffs (market string,
  default boot mode **4 EU / 3 US**, version, register-shuffle); all tuning code byte-identical → the off-road
  recipe ports with certainty, and the EU mode-4 default is what "force mode 3" overrides. Dump:
  `work/ghidra/controller-310-dump.txt`.
- **`docs/launch-limiters.md`** — throttle launch is NOT ramp-soft-limited; the rise-rate (`0x2e4e/0x2e52`) is
  **sub-second smoothing, not performance — rejected** as a perf lever by Flo.
- **`docs/current-limits.md`** — **the real performance lever** + the whole current map (see Next steps #0).
- **BLE load current is NOT available.** POWER `0x0401` d6–d7 `charge_current` (Walker73/hasuper73) is an
  **unsigned charger** current — **tested ~0 under load (2026-11-20)**. Load monitoring must use **voltage
  sag** (real pack voltage at POWER `0x0401` d2–d3, which hasuper73 does *not* read — it estimates from range),
  an external meter, or a CAN tap. "Walker" = **Walker73** (AxelFougues), the BLE groundwork puck/HA build on.

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
0. **Current limiting factors — the main thread for next session. See `docs/current-limits.md`.**
   Scope stays fixed: **unlimited (off-road) mode, throttle-only**. The throttle rise-rate and launch ramp
   were investigated and **rejected as performance levers** (sub-second smoothing — `docs/launch-limiters.md`).
   The real lever is the **battery-current-gated motor-current ceiling** in `FUN_08005abc`: `0x4e2`=1250
   normal (file `0x33ca` foldback + `0x37f6` clamp), `0x753`=1875 peak (`0x338c`), `0x2bc`=700 battery cutoff
   (`0x33ae`), `0x5dc`=1500 stall trip (`0x3766`). Open work to raise it **safely**:
   - a. **Trace the full current path, not just the foldback ladder** — every cap from throttle target →
     foldback ceiling → ramp → FOC current PI (`FUN_08006b24`) → PWM saturation (`0x7fff`). Pin the **NTC
     thermal foldback** (`FUN_08006834`): does it fold current on temperature, and does it bind before the
     ceiling? Dumps: `work/ghidra/controller-410-limits-insn.txt`, `controller-dump.txt`.
   - b. **Confirm the binding limit.** Does full throttle actually reach the foldback ceiling, or does the
     throttle-derived target (off-road = `throttle − min − 250`, no gain multiplier) bind first? If the
     target binds, raising 1250/1875 does nothing until the throttle→current scaling is raised.
   - c. **Units → amps (to judge headroom).** 1250/1875 = motor-command units, 700 = battery-current units;
     neither converts to amps without the current-sense ADC/shunt scaling. RE the current-sense path, or plan
     a bench correlation. Until then treat stock as near the hardware limit — reverse.bike did NOT raise H104
     current (signal).
   - d. **Monitoring: no BT load-amps** (POWER d6–d7 is charger-only, tested ~0 under load). Use voltage sag
     (POWER `0x0401` d2–d3, the real voltage) or an external meter / CAN tap during any test.
   - e. **Then decide + build conservatively:** likely +15% on `0x4e2` (both sites) + `0x753`, leaving `700`
     and `1500` as protections (`movw`/`cmp.w` 4-byte edits, encodings in `current-limits.md`). Real hardware
     risk (MOSFET/motor/BMS) — hold on moving `700` until (c) proves headroom.

   Separately, the **off-road derestrict** is ready whenever wanted: `docs/reverse-bike-patches.md` has the
   byte-verified 410 port (force mode 3, disable roll-off, rise-rate 150, q-axis filter). That is "unlimited",
   **not** "more current" — a different goal from this thread.
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
- **reverse.bike `sdcfw` is the key external reference — see `docs/reverse-bike-patches.md`.** Cloned
  read-only to `work/sdcfw/` (gitignored). Their `apps/kitchen/patches/230-BLUETOOTH-EXT1-310/off-road.ts`
  is a full off-road retune for the RX H104 family; **all 6 `original` byte sites verified against our 410
  image**, so it ports to 410 at identical file offsets (force mode 3; disable top-end roll-off; throttle
  rise rate 110/70 → **150**; **double the q-axis current filter coef `0x249a` 38→76** = a 2nd snappiness
  lever we'd missed). Deploy is **patched `.bin` + stock `.dat` over the display BLE DFU** (they ship the
  stock `.dat`; the GD32 doesn't verify it) — resolves the old "signature mismatch blocks flashing" caveat.
  No 430 patch is published (consistent with the RAM-table finding).
- **CORRECTION: controller load base is `0x08003800`, not `0x08003000`.** reverse.bike's descriptors say so
  (14 KB bootloader). File offsets are unaffected (our `patch-controller-ramp.mjs` is fine), but our Ghidra
  **absolute** addresses are all 0x800 low — re-import at `0x08003800` to fix cross-references.
- **The GD32 DFU `.bin` is app-code-only.** Its `.data`/config LMA is in flash *past* the `.bin` end — do
  **not** expect to find initialized tables/calibration in the `.bin`; that needs the full-flash SWD dump.
- **Vendor fetch:** `scripts/fetch-vendor-firmware.mjs` (apiKey constant baked in; `--config`/`--signin`
  helpers). `firmwareType` is a catalog selector: 231=BLE-only, 232/233=BLE+STM+NRFBL, controller via
  type 231 + `ext1Version=410` (a *recognized* non-zero value). Images → `work/firmware/vendor/` (gitignored
  except the extracted `.bin`s and `config-231.json`, which are committed).
- **Network calls (OTA fetch, config pull) are classifier-gated** — they got blocked until the user
  explicitly authorized; a fresh agent may need the same. **`git push` is always allowed in auto mode**
  (Flo's standing authorization) — commit and push to `main` without asking.
