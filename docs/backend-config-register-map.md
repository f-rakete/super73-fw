# Backend config / register map (authoritative)

Pulled live from the Comodule backend for our module — the machine-readable source the app uses to
decode the BLE registers, i.e. the authoritative form of `super73-puck/docs/protocol.md`.

- Endpoint: `GET https://analytics.comodule.com/bleapi/v2/module/{moduleId}/config`
  `?type=231&stmVersion=201015&bleVersion=221122&apiKey=…`
  (`type` = our `firmwareType`; apiKey = the public app constant — see `FINDINGS.md`.)
- Saved: `work/firmware/vendor/config-231.json` (doc id `231-nrf-8`).
- A sibling form (`type=231` alone → id `231-nrf-260120`) returns the same decoders under
  `configuration_version_1` with `value_multiplier`/`value_offset`/`value_signed`.

## Metrics decoders (`configuration_version_1` / `characteristics`)

| identifier | reg | calculation (byte order) | ×mult | unit |
|---|---|---|---|---|
| `speed` | `0201` | `[1]<<8 + [0]` | 0.01 | km/h |
| `total_distance` | `0202` | `[7]<<24 + [6]<<16 + [5]<<8 + [4]` | 0.1 | km |
| `range` | `0203` | `([7]&0x0F)<<8 + [6]` | 1 | km |
| `voltage` | `0401` | `[3]<<24 + [2]<<16 + [1]<<8 + [0]` | 0.001 | V |
| `state_of_charge` | `0402` | `[0]` | 1 | % |
| `assist_level` | `0300` | `[2]` (states enum) | — | 0–4 |
| `display_navigation` | write `F0AA` | bytes 0..7 (raw) | — | — |
| bike model | `0210` | 5-byte string | — | — |
| bike serial | `0211` | `[3]<<24 + [2]<<16 + [1]<<8 + [0]` | — | — |

These match `docs/can-protocol.md` (BLE reg IDs mirror the CAN IDs: MOTION `0x0201`, POWER `0x0401`, …).

## User-facing setting: the class slider

`vehicleSettings[0]` — the only exposed writable:
- read `0300` (`[3]`), **write `00D1` (`[2]`)** — the same `00 D1` command the display's settings-write
  handler decodes (see `FINDINGS.md` → display handlers).
- `type: slider`, `minValue 1`, `maxValue 4`, `defaultValue 1`, **`valueOffset 4`**.
- So app **"Class 1–4" → firmware mode 5–8** (value + 4). The EU/off-road modes (0–4 vs 5–8) and the
  controller's 0–7 mode table line up with this offset.

## Not here: the current/torque curve

The config document is **only** the register decoders + the class/assist *enums* — it carries **no**
current-vs-speed array. So the 430 controller's 45-entry torque table (`docs/controller-410-vs-430.md`) is
**not** backend-config-delivered. Open question (see that doc): the update must populate the table itself —
most likely a precompute at init inside the 430 image — not read it from data the DFU doesn't ship.
