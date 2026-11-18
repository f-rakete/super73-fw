# SUPER73 S2 firmware RE — plan

Goal: reverse-engineer the S2's firmware, not just the BLE protocol. Software-first, hardware later.
Driven with `rea` + Ghidra/JADX. Prior BLE work: `super73-puck`, `hasuper73` (both Walker73-based).

## Stage 0 — Companion app (`com.comodule.super`) — IN PROGRESS
Pure software, runs on this Windows box today.
- [ ] Obtain the APK (mirror, or Flo's device for the exact version the bike talks to).
- [ ] Decompile with jadx / rea Android tools.
- [ ] Recover: full GATT map, the **security-service handshake** (sign/verify), backend API + auth,
      and the **OTA firmware-update URLs** and package format.
- [ ] Download the real firmware packages the app fetches (display nRF52 `221122`, controller `410`).

## Stage 1 — Obtain firmware images
- [ ] From Stage 0 OTA URLs (preferred — mirrors the legitimate Tenways route), or
- [ ] capture the reverse.bike / app BLE-flasher traffic, or
- [ ] cross-check against reverse.bike's published factory images.
- [ ] Unpack the Nordic DFU `.zip`: `manifest.json` + `*.dat` (init packet) + `*.bin` (the image).

## Stage 2 — Static RE of the nRF52 display image (Cortex-M4, ARMv7E-M)
- [ ] Load `.bin` in Ghidra: ARM Cortex **Little Endian**; find the correct base (nRF52 app sits above
      the SoftDevice — commonly 0x1C000/0x23000/0x26000/0x27000 by SoftDevice; confirm from the vector table).
- [ ] Enable "ARM aggressive instruction finder". Map the vector table → reset handler → RAM init.
- [ ] Recover: GATT handler tables, the register map (cross-check `protocol.md`), the security-service
      verify routine + the embedded public key, the DFU/settings paths, ride-mode + speed-limit logic.
- [ ] Use rea to pull pseudocode/strings/xrefs and keep an evidence trail.

## Stage 3 — Motor controller `410`
- [ ] Identify the MCU/vendor (S2 410 is not the FTEX line the ZX uses). Get its OTA package via Stage 0.
- [ ] Static RE of the controller image (architecture TBD once we have the file). The speed/assist/mode
      limit logic lives here, not in the display.

## Stage 4 (optional, hardware) — nRF52 SWD
- [ ] Only if we need a ground-truth dump or the OTA image is encrypted/unavailable. reverse.bike reads
      these over SWD, so APPROTECT is likely open; a debug probe + opening the case is the cost.

## Deliverables
- A clean, independent writeup of the firmware internals and the update/signing scheme.
- Tooling: an OTA package fetcher/unpacker; a Ghidra project; notes cross-referenced to `protocol.md`.
- Everything road-legal-by-default (see FINDINGS.md → Legal posture).

## Open decisions (for Flo)
- Target priority: display nRF52 vs controller 410 vs both (default: both, display first).
- APK source: your on-device APK (exact version) vs a public mirror (default: mirror, swap in yours later).
