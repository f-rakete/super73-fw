# SUPER73 S2 firmware RE — findings

Consolidated facts for reverse-engineering the firmware of a SUPER73 S2. Protocol-level
facts live in the `super73-puck/docs/protocol.md` already; this file is about the **firmware**
and how to obtain and analyse it.

## The bike's compute, and which firmware lives where

| Unit | What | Firmware (our S2) | Reachable | Readable back? |
|---|---|---|---|---|
| Comodule **Diamond Display** / connectivity module | Nordic **nRF52** — the BLE brain | `221122` (a 2022-11-22 build), HW `v3.2.0`, mfr `COMODULE` | BLE (GATT); updated via Nordic **Secure DFU** (`fe59`, buttonless DFU char `8ec90003-…`) | **Yes via SWD** — reverse.bike backs the original up before flashing, so APPROTECT is not fully locked on these units |
| **Motor controller** | Speed / power / assist MCU | **`410`** (S2) | **Flashed over BLE** by a web flasher that reads the bike and fetches the matching package | **No** — "cannot be read off the bike"; the factory image is the only copy |
| Battery **BMS** | Cell management | unknown | hardware, separate | unknown |

Controller IDs across the range (from reverse.bike): ZX = 202/404, R/RX = 310, **S2 = 410**,
generic FTEX = 515xx.

## The companion app is the gateway

- **Package `com.comodule.super`** (SUPER73 Inc, white-labelled **Comodule** telematics). Latest ~3.20.0.
- In-app **Settings → Firmware Update** is the OTA path. A failed update "can corrupt the controller",
  which tells us the app pushes firmware to the controller as well as the display.
- RE'ing the app should yield: the full GATT protocol incl. the **security-service handshake**, the
  backend/API, and the **OTA package URLs** — the actual firmware images we want to analyse.

## The OTA firmware API (recovered from app 3.21.0, `com.comodule.super`)

The app is a Comodule white-label (Kotlin/Compose, Ktor HTTP, kotlinx.serialization, Nordic DFU lib,
Google Tink crypto). It is **data-driven**: the backend describes the bike's registers *and* serves
firmware. Backend hosts (from dex strings):

- `https://analytics.comodule.com/bleapi/v2/` — the **BLE API** (firmware + register config)
- `https://api.comodule.com/vehicleapi/v4/sse/vehicle/` — vehicle/IoT API (SSE telemetry, remote lock via `IotLockCommandDto`)
- Auth (**verified**): the bleapi path authenticates on a **query param** `?apiKey=<const>` only; the
  Firebase `Authorization: Bearer` token is used by the *vehicle* SSE API (`cn/d.java`), **not** bleapi.
  - `apiKey = 6od0h50da2ub3pdjl0o3s998n0` — a build constant (`ua.a.f30403v`; OkHttp interceptor `t8`
    appends it as `?apiKey=`). Not user-specific; shipped in the APK.
  - Firebase web key `AIzaSyAIM7QEIQh05cQUp5RB953puBCXg6xFViw`, app `1:589963444509:android:…`,
    project `comodule-ca`. Mint a Bearer (only if a path needs it) via
    `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<webkey>` with the account
    email/password (app logs in email/password: `com.comodule.signup.ui`).

### Firmware check: request → response — VERIFIED and PULLED
**Exact route** (Retrofit interface `defpackage/a.java`):
- `POST  bleapi/v2/module/{moduleId}/update?apiKey=…`  body `FirmwareUpdateRequestDto` → `FirmwareUpdateResponseDto`
- `GET   bleapi/v2/module/{moduleId}/config?stmVersion=&bleVersion=&type=&apiKey=…` → `ConfigDto` (register schema)

`moduleId` is per-bike (app → **Bike passport → Module data → Module ID**; our S2 = `1133a890eabfe9ba`).
`firmwareType`, `stmVersion`, `nrfVersion` are read off the bike (shown on the passport once BLE-connected):
our S2 = **firmwareType 231, STM 201015, nRF 221122** (the `231` matches reverse.bike's package prefix).

`FirmwareUpdateRequestDto` wire fields (SerialNames; note `nrfVersion` serialises as `bleVersion`):
```
firmwareType:int, bleBootloaderVersion:int?, stmVersion:int?, bleVersion:string?,
ext1Version:int?, ext2Version:int?, nrfBlVersion:int?, bleName:string   // bleName = "SUPER73"
```
`FirmwareUpdateResponseDto` — reply, **per-MCU download URLs + checksums + flash order**:
```
updateOrder:list, stmChecksum, ext1Checksum, ext2Checksum,
stmUpdateUrl, bleUpdateUrl, nrfBlUpdateUrl, ext1UpdateUrl, ext2UpdateUrl
```
The server returns the current image if you report an older version (report installed versions → empty =
"up to date"; report `0` → it serves the current image). It returns all applicable units at once with a
flash order (e.g. `updateOrder:["NRFBL","BLE","STM"]` + each `*UpdateUrl`+`*Checksum`); the app
(`defpackage/w.java`) flashes `updateOrder[0]` first, then re-queries.

**`firmwareType` is a CATALOG SELECTOR, not just our module's type.** The value picks which image set the
backend offers; object names are `{firmwareType}-BLUETOOTH-{UNIT}-{version}.zip`. Sweeping the S73 family
(apiKey only, our module, versions=0) maps it:
- `231` → `BLE 221122` only  (what the passport reports as our type)
- `232` / `233` → `NRFBL 6` + `BLE 221122` + **`STM 201015`** (STM matches our bike's reported STM exactly)
- `228` → `BLE 210706`; `230` → `BLE 221122`; `245`/`247` → `STM 230210`; `249` → `STM 230321` (other variants)
- The module's **STM32** (`stm`, `201015`) is the CAN-bridge MCU inside the Comodule module — a *different*
  MCU from the motor controller. OTA-served via type 232/233; pulled.

**The controller (EXT1) IS served — the key is a recognized `ext1Version`, not `0`.** The `ext*` units
don't appear with versions=0 (the server reads `0` as "unit absent"). Report the **real current controller
version** (the app sends `ModuleVersionInfo.controllerVersion`) and the server returns the update: with
`firmwareType 231, ext1Version 410` → `updateOrder:["EXT1"]`, `ext1UpdateUrl` → **`SUPER73-RX-MCU-430.zip`**
(note the controller's own naming `SUPER73-{model}-MCU-{version}.zip`, separate from the module units). Only
`410`/`420` are recognized "current" values and both map to the latest `430`; `430` itself returns nothing
(up to date). So the OTA serves the **latest** controller (430), not the stock 410 (we hold 410 already).
Pull it with `… --firmware-type 231 --ble 221122 --stm 201015 --ext1 410` (BLE/STM current so only EXT1 is
offered). This is exactly how the app updates the controller: read `controllerVersion` → send as `ext1Version`
→ get `ext1UpdateUrl` → flash the GD32 over the `[VEH UPDATE]` CAN state machine.

**Pulled (`scripts/fetch-vendor-firmware.mjs`, all verified Nordic-DFU packages, in `work/firmware/vendor/`):**
| unit | type | package | image | notes |
|---|---|---|---|---|
| BLE (nRF52 display) | 231/232 | `…-BLUETOOTH-BLE-221122.zip` | `comodule-sdisplay-nrf.bin` 151,468 B, 2022-11-22 | **byte-identical** (sha256 `deb8971e…`) to reverse.bike flash @`0x23000` |
| STM32 (module bridge) | 232 | `232-BLUETOOTH-STM-201015.zip` | `comodule-hw-stm32.bin` 10,168 B, 2020-10-15 | matches bike's reported STM `201015` |
| nRF bootloader | 232 | `232-BLUETOOTH-NRFBL-6.zip` | `comodule_nrf_bl_secure.bin`, Secure DFU BL | |
| **GD32 motor controller** | 231 ext1 | `SUPER73-RX-MCU-430.zip` | `GD_S73Rx_H104_S430EU_20241011.bin` 26,608 B, 2024-10-11 | **v430**, reset `0x08003901` (same base as 410); newer than stock 410 |

The nRF images flash via **Nordic DFU** (`no.nordicsemi.android.dfu.*`); the STM/ext images via Comodule's own
BLE→CAN path. Downloads are gitignored.

### Bonus: the backend also serves the full register map
Sibling serializers in the same `data.remote` layer describe the metrics protocol declaratively — the
authoritative form of `protocol.md`:
- register def (`df/g.java`): `registry_id, calculation, timestamp_calculation, value_signed,
  value_multiplier, value_offset, start_byte, end_byte, step, default_value`
- characteristic def (`df/i.java`): `identifier, unit_identifier, variant, raw_bytes, min_value,
  max_value, states, read_info, write_info`
Pulling the bike's config document from `bleapi/v2` would give exact decoders (signedness, scale,
offset, byte range) for every register — cross-check and extend `protocol.md`.

### Where the APK/decompile lives
`work/super73_3.21.0.xapk` (v3.21.0, build 2358, armeabi-v7a). Base APK + splits in `work/xapk/`,
dex in `work/dex/`, jadx output in `work/jadx-out/` (R8-obfuscated; `com.comodule.*` names retained,
single-letter helper dirs). Native SDK code is in the `config.armeabi_v7a` split (`lib/*.so`, not yet pulled).

## Firmware images in hand (reverse.bike stock) + verified memory maps

Downloaded to `work/firmware/`. reverse.bike serves packages as `https://cfw.reverse.bike/cfw/<name>.zip`;
each is an SWD/flash set (not a Nordic DFU zip) with an `sdcfw.json` describing it. Stock images pulled:

- **Display** `6-221122-0-stock-v1.0.0.zip` → `flash.bin` (512 KB), `uicr.bin` (1 KB), `sdcfw.json` (nrfVersion 221122).
- **Controller** `231-BLUETOOTH-EXT1-410-stock-v1.0.0.zip` → `GD_S73Rx_H104_S410EU_20221020.bin`
  (26,200 B) + `.dat` (142 B signed DFU init packet) + `sdcfw.json` (controllerVersion 410).
- Also kept the **unlocked display** (`…-unlocked-…`) for diffing.

### nRF52832 display flash map (verified from `flash.bin`)
```
0x00000  MBR                       (SP 0x20000400)
0x01000  SoftDevice S132           (info struct @0x3000: magic 0x51B1E5DB, SD size 0x23000, FWID 0x00A5)
0x23000  Application               (vector table; reset 0x38e1d)        <- Ghidra load base
0x73000  Bootloader (Nordic Secure DFU; reset 0x73469)
  0x7b2b4  64-byte key block the unlock swaps (reverse.bike "skeleton key"); app-level update auth
  0x7b5f4  nRF Secure-DFU ECDSA pubkey per reverse.bike's writeup (UNCHANGED by the unlock)
0x7E000  MBR parameter page
0x7F000  Bootloader settings page  (CRC/settings)
```
UICR ships separately in `uicr.bin` (maps at 0x10001000). FWID 0x00A5 → an S132 v6.x; SD size field
0x23000 is authoritative for the app base.

### GD32 controller image (`GD_S73Rx_H104_S410EU_20221020.bin`)
- `GD` = **GigaDevice GD32** (STM32-clone Cortex-M). Vector table at file start: SP `0x200008b8`,
  reset `0x08003900` → loads in the **0x08000000** flash family (confirm exact base in Ghidra via
  handler-target alignment). 26 KB bare-metal app; paired `.dat` is a Nordic Secure-DFU **signed init
  packet**: a 32-byte SHA-256 of the image (stored byte-reversed — verified `== reverse(sha256(bin))`)
  **plus a 64-byte ECDSA P-256 signature** (`1a 40` field). It is image-specific (a patched `.bin`
  invalidates it). Whether anything on the *controller/CAN* path verifies it is open — see "Update
  authenticity" below. HW 104, SW 410 EU, built 2022-10-20.

### Verified stock→unlocked display diff (74 bytes, 5 ranges — matches reverse.bike's notes exactly)
- `0x3050c` (1 B) startup mode default: stock mode 2 → unlocked US mode 4
- `0x3af07` (1 B) `versions` → `versionz` label
- `0x7b2b4`..`0x7b2f3` (64 B) reverse.bike **"skeleton key"** swap — app-level update auth, **not**
  the nRF Secure-DFU pubkey (that is at ~`0x7b5f4` and is unchanged here) and **not** the controller path
- `0x7f000`..`0x7f003` + `0x7f01c`..`0x7f01f` (8 B) bootloader-settings CRC/fields, recomputed to match

Stock "skeleton key" block (64 B @0x7b2b4): `12b4ada6 af80b973 3080bdea da6a2ae8 b46a6808 e03ad326
54f1dafb 04e4f62d 8629aa76 65d7b522 e8aa94ff 214e8d0b 2c425c53 a70d77bb fba888ec bf920327`

### Update authenticity (per reverse.bike's update-architecture writeup) — three separate domains
1. **BLE → nRF52's own firmware** = Nordic Secure DFU, **ECDSA P-256 + SHA-256** (pubkey ~`0x7b5f4`).
   Gates *display* updates over BLE only.
2. **App-level packages** = the **"skeleton key"** (`0x7b2b4`). Gates pushing custom *display/STM-bridge*
   firmware over BT.
3. **nRF52 → STM32 bridge (UART `$NRF,5/6,…`) → CAN → GD32 motor controller** = the controller-side
   region verify recovered from the CAN RX RE is a **4-byte CRC** (`0x5AA` memcmp), not a signature.
   reverse.bike's controller CFW "works with unmodified Diamond modules", indicating the *controller*
   path does not enforce a vendor signature over the image → **no display mod needed to live-test
   controller patches** via that path. **Caveat:** the controller package's paired `.dat` is itself a
   Nordic signed init packet (SHA-256 + ECDSA P-256, matching the *stock* image), so a patched image
   needs a flash path that does **not** verify that `.dat` against the image — reverse.bike flasher /
   SWD confirmed; the stock-display `ext1`/CAN push is **unconfirmed** and must be checked before an
   over-BT flash of patched controller firmware.

(Corrections: (1) an earlier draft mislabeled `0x7b2b4` as *the* DFU signing key and implied the
display gatekeeps controller updates — it does not. (2) An earlier draft called the controller `.dat`
"an 8-bit checksum, not a crypto signature" and the controller-side check an "8-bit checksum". The
`.dat` is in fact a signed init packet (SHA-256 + 64-byte ECDSA P-256), and the CAN-level controller
verify is a 4-byte CRC. The practical conclusion — a patched controller image is flashable without
forging a signature on reverse.bike's path — stands, but the mechanism was mis-stated and the
stock-display path's enforcement is unconfirmed, not "uncryptographic".)

## Tooling: Ghidra + rea (Stage 2 ready)
- Ghidra **12.2** extracted at `tools/ghidra-dist/ghidra_12.2_PUBLIC` (satisfies rea ≥12.1).
- JDK **21** at `C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot` (Ghidra 12.x needs 21+).
- Set `GHIDRA_INSTALL_DIR` to the Ghidra dir and `JAVA_HOME` to the JDK 21 for rea's headless runs.

## Controller (GD32) RE — the ride-mode speed-limit table (decompiled)

Stock `410` loaded raw @`0x08003000` as `ARM:LE:32:Cortex` via Ghidra headless (110 functions,
`work/ghidra/controller-dump.txt`). Bare-metal, ~no strings. Key functions:

- **`FUN_08005abc`** (largest, 1946 B) — the **ride-mode → limits mapping**. A `switch(mode)` over
  cases 0–7(+fallbacks) writes each mode's **max-speed cap (km/h)** to a control field `[ctx+8]`:

  | mode | byte | km/h |          | mode | byte | km/h |
  |---|---|---|---|---|---|---|
  | 0 CLASS1 US | `0x20` | 32 | | 4 **EPAC EU** | **`0x19`** | **25** |
  | 1 CLASS2 US | `0x20` | 32 | | 5 MID EU   | `0x23` | 35 |
  | 2 CLASS3 US | `0x2d` | 45 | | 6 HIGH EU  | `0x2d` | 45 |
  | 3 OFFROAD US| `0x00` | ∞  | | 7 OFFROAD EU| `0x00` | ∞ |

  Matches `super73-puck/docs/protocol.md` exactly — independent confirmation + the firmware location
  of every cap. Also sets per-mode accel ramp (`iVar18`) and current-curve coefficients (`uVar44/uVar46`).
- **`FUN_080062b8`** (1072 B) — current/torque controller. Normalizes by `/0x9c4` (**2500 = 25.00 km/h**
  in the ×100 units used by the MOTION register) and clamps assist/throttle speed to `0x9c4`; branches on
  the ride mode (`*DAT_0800679c`: `==1`, `==3`/`==7` off-road, else) for throttle current curves.
- The `0x9c4` (2500) clamp recurs in the throttle/assist paths (`FUN_080040c8`, `FUN_08004c54`, …) — the
  speed limiter proper. reverse.bike's "EU unlock" raises the per-mode cap byte / this clamp (their notes:
  mode cap → 255 km/h, throttle current 85%→100%).

Load base method, dump command and gotchas: HANDOFF.md. ELF wrapper + raw-import both work.

### Controller current/power limiting & curves (`FUN_08005abc` + `FUN_080062b8`)
Current is in internal units (~Q15; final motor-current command clamped to `0x7fff` full-scale). **Absolute
amps need the current-sense ADC scale** — not yet recovered (next step: the measurement ISR / the PI current
regulator `FUN_08006b24`). Pipeline: throttle/assist input → per-mode q-current curve → scaling → clamps /
thermal foldback → PI regulator `FUN_08006b24` → motor. Key constants:
- **Speed cap per mode** (a `movs #imm` written to the control field, km/h), used to normalize current via
  `/0x9c4` (2500 = 25.00 km/h): mode 0/1=`0x20`(32), 2=`0x2d`(45), 3/7=`0`(∞), **4=`0x19`(25)**, 5=`0x23`(35), 6=`0x2d`(45).
- **Throttle current scaling**: `*DAT_0800678c` selects `×0x5a/100` (**90%**) or `×0x55/100` (**85%**) — reverse.bike's "85%".
- **q-current field-weakening curve** (piecewise on throttle/speed `*DAT_080067a4`): `0x494d` (<100) →
  `(x·0xc37)/-0x46 + 0x5a7d` (100–325) → `(x·0x22e8)/K + 0x4f04` → `0x1a2e`; then `×speed/0x9c4 ×8/10`.
- **Current-target clamp** `0x4e2` (1250) under a status bit; **battery/thermal foldback** (input `*DAT_08006330`
  vs `-200/200/50/450/500/650/699` → target `0/300/0x1c2(450)/0x4e2(1250)/0x753(1875)`); regen floor
  `DAT_08006830/067ac/067a8`; hard clamp `0x7fff`.
- **Over-current/stall trip**: current target `>0x5dc` (1500) while speed `<0x19` (25) for `>300` cycles → fault.

### Confirmed by the ZX 404→405 EU-unlock diff (sibling controller, Rosetta stone)
88 bytes / 10 ranges, all Thumb edits to the limiter (`work/firmware/SUPER73-ZX-MCU-404-*`):
- Pedal-assist cap `movs r1,#0x18`(24) → `#0xff`(255) @`0x34fe`; throttle cap `movs r1,#6` → `#0xff` @`0x353e`
  (+ ramp consts `0x1e`→4, `0x0a`→`0x14`).
- Limit guards neutralised: `@0x3526` → `nop.w`, `@0x3854` `cmp` → unconditional branch.
- Current-envelope math rewritten (`@0x39de` 32 B, `@0x3b7c` 39 B) — the "2× envelope / 85%→100%".
→ On our **410** the same knobs are the per-mode `movs #imm` speed caps and the `0x55/0x5a` throttle scale.

### Control topology + current-sense scaling (corrected)
- **FOC, speed-primary.** Hall sensors → electrical angle + angular velocity (`FUN_08005854`, 6-sector
  interpolation). Speed → `×48000` → IIR low-pass `new=(15·old+raw)/16` → stored at **`MC+0x12c`** (this is
  the **speed** feedback — *not* current, correcting the earlier note). `FUN_08006b24` is the **speed PI loop**
  (Kp/Ki with integrator clamp) whose output is the torque/current command; `FUN_08006b88` is the Park/αβ
  transform for the FOC output.
- **ADC = 12-bit, 3.3 V ref** (proven: temp path `raw·0xce4>>0xc` = `raw·3300/4096` mV). The thermal-foldback
  input is an **NTC** piecewise-linearised to °C (`FUN_08006834`).
- **Current/torque-command limits are internal (~Q15) units**: full-scale `±0x7fff`; foldback targets
  `1875/1250/450/300/0`; stall trip `>1500`. **Absolute amperes need the board current-sense gain
  (shunt × amp gain) — a hardware constant not in firmware.** Two ways to calibrate: read the board, or use
  the controller's reported battery current (POWER reg, mA) as a one-point anchor. The exact phase-current
  ADC→command multiply lives in the sampling ISR (not yet located — next dig).

### Per-mode current curves (from `FUN_08005abc`, both switch blocks)
`cap` = hard speed limit (km/h); **taper window** = speed band (×0.1 km/h) over which assist ramps full→0
(the soft cutoff around the cap); `curve` = current-coefficient vs speed `f` (`*DAT_08006320`):

| mode | cap | assist taper (km/h) | current-coef curve |
|---|---|---|---|
| 0 CLASS1 US | 32 | 27.0–37.0 | `0x172 − f` |
| 1 CLASS2 US | 32 (0 w/throttle) | 32.0–37.0 (thr 33.0–38.0) | `740 − 2f` |
| 2 CLASS3 US | 45 | 45.0–47.5 | `1900 − 4f` |
| 3 OFFROAD US | ∞ | 32.0–34.0 | `125·f/100 − 475` |
| **4 EPAC EU** | **25** | **24.0–29.0** | `580 − 2f` (throttle disabled) |
| 5 MID EU | 35 | 33.0–38.0 | `780 − 2f` |
| 6 HIGH EU | 45 | 44.0–46.0 | `2300 − 5f` |
| 7 OFFROAD EU | ∞ | config bytes | direct |

Throttle q-current (by mode class `*DAT_0800679c`): piecewise `0x494d → (x·0xc37)/−0x46+0x5a7d →
(x·0x22e8)/K+0x4f04 → 0x1a2e`, then `×speed/0x9c4 ×0.8`, then throttle scale `×0x5a/100` (90%) or `×0x55/100` (85%).

## Display (nRF52) architecture — from the app's retained debug strings

App region (`0x23000`–`0x73000`) analyzed in Ghidra: **663 functions**, and Nordic SDK debug logging was
left in, so the architecture reads straight off the strings (`work/ghidra/display-app-list.txt`):

- **The display↔controller link is CAN bus.** `$NRF,CAN,READY|BAUD|FILTER`, ASCII frames `$NRF,<n>,..*`
  and `$STM,FW,..`. CAN filter IDs incl. `0x400-0x403,0x423,0x466` and `0x200-0x203,0x210-0x212,0x266,
  0x67f,0x5ff,0x5aa`. Real-time mode/assist/speed between nRF and GD32 ride on CAN (not just the BLE regs).
- **Controller firmware update = a `[VEH UPDATE]` CAN state machine** (`STARTING UPDATE PROCESS` →
  `Trying to enter bl` → `erase app` → `ACK INIT` → stream FW → `5AA resp checking region matching` +
  `memcmp==0, regions match` → `JUMP/CLEAR/FW/END RESP`). This is the app's **ext1** path:
  BLE → nRF → CAN → GD32 bootloader. Confirms why controller FW "can't be read off the bike" (write-only push).
- **Auth / security service**: `$NRF_DEVICE_AUTH_SUCCESSFUL`, `Request security setup or disconnect`
  (the `00002554` service).
- **Region/mode default**: `EU CONF; CLASS 4 AS DEFAULT` / `US CONF; CLASS 1 AS DEFAULT` — the startup-mode
  logic; the diff byte `0x3050c` flips this (stock EU mode 2→? ; reverse.bike → US mode 4).
- **Diff bytes string-confirmed**: `versions` lives at `0x3af00`; its final char is `0x3af07`
  (reverse.bike's `versionz`). `BLE control handler`, `[APP] GPREGRET2`, DFU via
  `Power management wants to reset to DFU mode` (buttonless `fe59`).
- Settings/persistence: Nordic **FDS** (`[FDS]…`) + external **SPI flash** (`Ext flash SPI…`,
  `External file is valid, size:%d, fw nr:%d`); coin-cell RTC backup (`[COIN]…`).

Targeted decompiles of these handlers → `work/ghidra/display-decomp.txt`.

## Display (nRF52) key handlers — decompiled (`work/ghidra/display-decomp.txt`)

- **`FUN_0003076c` @0x3076c — BLE settings-write handler (the `00 D1` command).** Confirms + extends
  super73-puck's spec:
  ```
  if (ctx[0x26]==0 && (param[0]<<8 | param[1]) == 0x00D1) {
      light  = param[2];  if (light  < 2)    -> set via fnptr ctx[0x50]
      assist = param[3];  if (assist < 5)    -> set via fnptr ctx[0x48]
      mode   = param[4];  if (mode  < 0x0C)  -> ctx[0x289]=mode; FUN_0002fff8(mode,3)  // CAN->controller
  }
  ```
  - Field order light/assist/mode at bytes 2/3/4 ✓. Bounds: light<2, assist<5, **mode<12** (firmware
    accepts 0–11, broader than the documented 0–8; the controller's mode table only maps 0–7 meaningfully,
    with case 10≈case 4 EU-EPAC, case 9→25). Current mode is stored at `ctx+0x289`.
  - Gate: `ctx[0x26]` must be 0 for the write to apply.
- **`FUN_0002cda4` @0x2cda4 — security-service auth** (`$NRF_DEVICE_AUTH_SUCCESSFUL`): derives a **20-byte**
  (SHA-1-sized) expected value from a stored key (`DAT_0002cdf0`) and `memcmp`s (`FUN_00039548`, len 0x14)
  against the 20 bytes the app wrote; match → sets auth flag; mismatch → `FUN_0002d7d8` → disconnect
  (reason **0x13**). The `00 D1` write path does **not** require this — why Walker73/puck write unauthenticated.
- **`FUN_0002d7d8` @0x2d7d8 — security setup/disconnect**: if not set up requests setup, else disconnects.
- **`FUN_00032068` @0x32068 — CAN `[VEH UPDATE]` orchestrator**: reflashes the GD32 controller (reads the
  `ctx+0x289` mode byte, region-matches via `FUN_0003889c`, drives the bootloader handshake).

Shared RAM context accessor is `FUN_00030034()` (returns the main state struct; `+0x26` gate, `+0x289` mode,
`+0x48/+0x50` assist/light setters).

## Controller↔display CAN protocol + "can we dump the controller over BT?" → No
Decompiling the display's CAN RX handler (`FUN_00030b7c`) mapped most of the internal CAN bus: telemetry
`0x200–0x203`, version/model `0x210–0x211`, region+default-mode `0x212`, throttle/assist `0x400–0x402`,
odo `0x266/0x466`, and the update frames `0x5AA/0x5FF`. The BLE registers are largely this CAN telemetry
re-exposed (and the BLE register IDs mirror the CAN IDs: `MOTION 0x0201`, `POWER 0x0401`, …). Full map:
**[docs/can-protocol.md](docs/can-protocol.md)**.

On dumping: the controller bootloader protocol is **write-only** — `0x5FF` replies are ACK (`0x60`) /
error (`0x80`) only, and the `0x5AA` verify is a **4-byte CRC compare**, not a flash read. No read-memory
command exists on the BT/CAN path → the GD32 controller firmware **cannot be dumped over BT** (confirms
reverse.bike). A dump requires physical SWD/UART on the GD32. The nRF52 display, by contrast, is readable
over **SWD** (physical), which is what reverse.bike's "backup original" step does.

## The security service is the firmware-update signing key

The unused `00002554-1212-efde-1523-785feabcd123` service (private key W / public key R / hash W /
auth R) is the **firmware-update signature** mechanism. reverse.bike's display mod "patches in a new
public key (SuperDuper Skeleton Key)" so their own signed BT updates are accepted. So: the bike holds
a public key; update packages are signed; the display verifies before applying. This is the thing to
recover from the nRF52 image and/or the app.

## Proven methodology on a sibling device (Tenways SW102, same nRF52/Comodule family)

Source: suffix-trie.github.io (Tenways CGO600, SW102 display, nRF52).
- Firmware obtained **legitimately** from the vendor's public support portal: `sw102.bin` + `sw102.dat`.
- Ghidra: **ARM Cortex, Little Endian**, enable "ARM aggressive instruction finder (Prototype)".
- Approach: find the command id → the packet-assembly function → patch the instruction loading the limit.
- Deploy: Nordic **DFU**, recompute **CRC16** (Nordic algo), repackage `manifest.json`+`.dat`+`.bin` as `.zip`.

## Tooling status on this box (Windows 10, Flo's dev VM)

- `rea` ("Reverse Engineer Anything") 6.9.0 runs after bumping Node 24.19 → **26.13.1** (winget LTS).
  Drive it via its CLI (196 commands) — no Claude Code MCP registration/restart needed for that.
- **JDK 17** present → Android (JADX) track works on Windows. **jadx 1.5.6** unpacked at `tools/jadx/`.
- **Not installed:** Ghidra (need 12.x, set `GHIDRA_INSTALL_DIR`), Hopper, IDA, binwalk/unblob
  (Linux-only in rea — but a Nordic DFU `.bin` is a raw Cortex-M image, so binwalk isn't needed for it).
- No `adb` and no device visible from here.

## Prior art / references

- **reverse.bike** custom-firmware project — supports S2 (controller 410) + Diamond Display (nRF52 221122).
  Has factory + "unlocked" images and a BLE web flasher. Our independent source of firmware images and a
  cross-check for our own RE.
- **suffix-trie.github.io** — Tenways SW102 nRF52 RE writeup (methodology, Ghidra settings, DFU repackaging).
- Walker73 (AxelFougues) — the BLE protocol groundwork our repos build on.
- HN 23485711 — nRF52 APPROTECT glitch/readout (only if SWD on our unit turns out to be locked).

## Legal posture (carry over from super73-puck)

Mode 4 (EU EPAC, 25 km/h / 250 W) is the only road-legal mode in AT; anything that changes how the
bike behaves on public roads stays an explicit, opt-in step, exactly as `set_mode.py --allow-unrestricted`
already does. This project is about understanding the system; it keeps the same road-legal-by-default stance.
