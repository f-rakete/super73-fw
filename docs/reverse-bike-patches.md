# reverse.bike `sdcfw` — firmware version map & the off-road patch recipe

Source: `github.com/reverse-bike/sdcfw` (AGPLv3), cloned read-only to `work/sdcfw/` (gitignored).
It is an end-to-end custom-firmware pipeline: `apps/kitchen` applies byte patches to stock images and
publishes signed archives (`apps/web/public/cfw/*.zip`) that their site/CLI flash **over BLE through the
display** — no cable, nothing opened. The patch descriptors (`apps/kitchen/patches/<ver>/*.ts`) are the
authoritative, human-annotated **diffs between stock and their custom builds**. This is the single most
useful external reference for our RX H104 controller.

## The controller version landscape (`firmware/mc/`)

| folder (BLE firmwareType-ver) | image | MCU / notes |
|---|---|---|
| `230-BLUETOOTH-EXT1-310` | `GD_S73Rx_H104_S310US_20221020` | **RX H104 US** — byte-sibling of our 410 (same H104, same 2022-10-20 date, 26 200 B) |
| `231-BLUETOOTH-EXT1-410` | `GD_S73Rx_H104_S410EU_20221020` | **RX H104 EU — our stock controller** |
| `SUPER73-RX-MCU-430` | `GD_S73Rx_H104_S430EU_20241011` | **RX H104 EU 430** (2024) — still H104, newer build |
| `381-BLUETOOTH-EXT1-392` | `MCU_392` | older EXT1 |
| `406/407-…-51511 / -4169` | `DFU_pack_no_IoT_*_can_only` | different packaging (CAN-only, no IoT) |
| `SUPER73-ZX-MCU-200/201/202/202-NEW` | `GD_S73Zxl_H101_S2xx…US` | **ZX line, H101** (different controller) |
| `SUPER73-ZX-MCU-404-EU-20260612` | `GD_S73Zxl_H106_S404_EU_2026…` | **ZX H106 EU 404** (newest, 2026) |

nRF display: `5-200818`, `6-210502`, `6-221122` (ours), `8-250426`. STM bridge: `201015`, `231130`.

## CORRECTION to our RE: controller load base is `0x08003800`, not `0x08003000`

Both `230` and `231` descriptors declare `imageBase: 0x08003800` (14 KB bootloader, not 12 KB). Our
Ghidra imports used `0x08003000`, so **every absolute address in our dumps is 0x800 low** (e.g. our
`FUN_08005abc` is really `0x080062bc`; our ramp site `0x08005e4e` is reverse.bike's `0x0800664e`).
**File offsets are unaffected** — our `patch-controller-ramp.mjs` offsets (`0x2e4e`/`0x2e52`) are correct —
but absolute `DAT_*`/LDR-literal resolutions were off by 0x800, which explains some of the noisy decompile.
Re-import at `0x08003800` to clean up cross-references.

## reverse.bike's 310 off-road patch = the off-road recipe for our 410 (all `original` bytes verified)

`apps/kitchen/patches/230-BLUETOOTH-EXT1-310/off-road.ts` (→ archive `…-310-off-road-r311-v1.0.0`).
**All six `original` byte sites match our 410 EU `.bin` exactly** (verified against
`controller-410-stock/GD_S73Rx_H104_S410EU_20221020.bin`, sha `c8d4…34ab`), so the behavioural patches
port to 410 at **identical file offsets**. Addresses below are reverse.bike's (base `0x08003800`);
file off = addr − 0x3800.

| addr (base 0x3800) | file off | stock → new | what it does |
|---|---|---|---|
| `0x08005e3a` | `0x263a` | `1b b1 72 b6` → `03 24 02 e0` | **Force internal operating mode to 3** (off-road unlock): `movs r4,#3; b .+2` |
| `0x0800937c` | `0x5b7c` | (30-byte blob) | **Map CAN 0x300 assist-level → internal mode 1/3** (how the display selects off-road) |
| `0x08006e2c` | `0x362c` | `0c d2` → `00 bf` | **Disable mode 3/7 throttle current-ceiling speed roll-off** (`bcs`→`nop`) = removes the top-end governor we found (the `475 − 1.25·speed` scale) |
| `0x0800664e` | `0x2e4e` | `6e 22` → `96 22` | **Throttle rise rate (low-speed) 110 → 150** — our ramp "standstill step" |
| `0x08006652` | `0x2e52` | `46 22` → `96 22` | **Throttle rise rate (high-speed) 70 → 150** — our ramp "rolling step" |
| `0x08005c9a` | `0x249a` | `26 24` → `4c 24` | **Double the q-axis current-command filter coefficient** (38 → 76) = faster torque response |
| `0x08007e02` | `0x4602` | `0a 23` → `0b 23` | Report version 311 on CAN 0x266 (3XX-specific; `suffix = ver − 300`). **Not portable to 410 as-is.** |

### What this resolves for our "snappier takeoff" goal
- The **throttle rise rate** (our `patch-controller-ramp.mjs` knob) is reverse.bike's primary launch/roll-on
  lever — they raise it **110/70 → 150**, not lower it. So it is **not** placebo: it is the real off-road
  snappiness knob. (Our "near-instant, so marginal" caveat was over-stated; reverse.bike treats 150 as the
  off-road value.)
- The **q-axis current-command filter coefficient** (`0x249a`, 38→76) is a **second snappiness lever we had
  not identified** — it sharpens torque response directly in the FOC current path.
- The **speed roll-off disable** (`0x362c`) is exactly the top-end governor documented in
  `launch-limiters.md` (the `iVar17` speed scaling); this is the "unlimited" part, not the launch part.

## 430: no published patch (consistent with our RAM-table finding)

reverse.bike ships the **430 stock image** but there is **no `apps/kitchen/patches/SUPER73-RX-MCU-430/`** —
they have not published a byte-level off-road patch for 430. This matches our conclusion that 430 moved the
current-vs-speed curve into a RAM table whose init data is past the `.bin` (needs an SWD dump). Even
reverse.bike patch the H104 **310/410** by bytes, not 430.

## ZX 404 launch tuning = hypothesis #1 ("soft from zero"), on a different controller

`apps/kitchen/patches/SUPER73-ZX-MCU-404-EU-20260612/README.md` documents a rider's "accelerates fine but
**felt soft from 0–10 km/h**" and fixes it by raising a **speed-dependent current *allowance***: 50.00% at
0–2 km/h rising to 100% by ~36 km/h (`min(18+idx,36)/36` from idx 4; `(40+idx)/72` below). That is a genuine
"current limit when starting from zero" — but on the **ZX H106 404**, whose envelope is soft at launch by
design. Our **RX H104** is the opposite (generous at launch, rolls off at top), so this lever does not exist
the same way on our controller.

## Deploy path CONFIRMED: patched `.bin` + stock `.dat`, flashed over the display BLE DFU

`McPatchFile` patches the `.bin` and **ships the stock `.dat` unmodified** beside it; the published archives
are flashed by reverse.bike's own site/CLI over BLE through the display. So the GD32 bootloader does **not**
verify the `.bin` against the Nordic-signed `.dat` — resolving the open deploy caveat in `throttle-ramp.md`
(the signature mismatch does not block a display-BLE flash; SWD is not required). The `.dat` is a staging
companion, not an enforced image signature for the controller.

## Next step for our bike
If the installed controller is **410**, the full off-road retune is a direct byte-for-byte port of the table
above (drop/replace the 3XX version-report patch). For **snappier takeoff only** within our scope, the
subset is the two rise-rate bytes (`0x2e4e`/`0x2e52` → `0x96`) + the q-axis coefficient (`0x249a` → `0x4c`).
If **430**, no byte patch is available (SWD dump still required). Confirm the installed version first.
