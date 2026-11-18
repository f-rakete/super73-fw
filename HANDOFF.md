# HANDOFF — SUPER73 S2 firmware RE

Start here. Current state, environment, gotchas, next steps. Details in FINDINGS.md / PLAN.md.

## State (2026-11-18)
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
- Ghidra headless dump of the controller in progress → `work/ghidra/controller-dump.txt`.

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

## Next steps
1. Read `work/ghidra/controller-dump.txt`: find the speed/assist/mode-limit logic (compare to the mode
   table in super73-puck/docs/protocol.md) and the EXT1 DFU/update path.
2. Run the same headless dump on `display-221122` (import full `flash.bin` @0x0, or the app region @0x23000);
   recover the GATT register handlers, the `00002554` security-service verify routine, and the DFU pubkey use.
3. Cross-check register decoders against the backend schema (`df/g.java`: multiplier/offset/byte-range).
   `GET module/{moduleId}/config?type=231&stmVersion=201015&bleVersion=221122&apiKey=…` returns the live
   decoders (`characteristics[]` with `readInfo.registryId`/`calculation`) — `type` = the firmwareType. Pull
   and diff against `protocol.md` / `docs/can-protocol.md`.
4. Diff the pulled **GD32 v430** (`work/firmware/vendor/SUPER73-RX-MCU-430/`) against the stock **410**
   (`work/firmware/controller-410-stock/`): what changed in the speed/current limiter between 2022 and 2024.
   Same load base (`0x08003000`, reset `0x08003901`); headless-dump both and compare `FUN_08005abc`.
