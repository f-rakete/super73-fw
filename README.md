# super73-fw — SUPER73 S2 firmware reverse engineering

Reverse-engineering the firmware of a SUPER73 S2 e-bike (Comodule Diamond Display platform),
going beyond the BLE protocol work in [hasuper73](https://github.com/f-rakete/hasuper73) and
[super73-puck](https://github.com/f-rakete/super73-puck). Driven with
[rea](https://github.com/morluto/rea) + Ghidra.

## Read first
1. **[FINDINGS.md](FINDINGS.md)** — the firmware facts: MCU map, OTA API, memory maps, verified diffs.
2. **[PLAN.md](PLAN.md)** — staged roadmap (app → images → Ghidra → controller).
3. **[HANDOFF.md](HANDOFF.md)** — current state, env setup, gotchas, next steps. Start here each session.

## Layout
```
rea/                 clone of morluto/rea (the RE toolkit; large)
hasuper73/           clone — read-only HA integration (BLE protocol reference)
super73-puck/        clone — Puck.js mode switch (docs/protocol.md = the BLE groundwork)
tools/
  jadx/              jadx 1.5.6 (APK decompiler)
  ghidra-dist/ghidra_12.2_PUBLIC/   Ghidra 12.2
work/
  super73_3.21.0.xapk, xapk/, dex/, jadx-out/   the companion app + decompile
  firmware/          reverse.bike stock + unlocked images (nRF52 display, GD32 controller)
  ghidra/            ELF wrappers of the raw images for rea/Ghidra
FINDINGS.md PLAN.md HANDOFF.md
```

## Targets (what firmware, where)
- **nRF52832 display** (Comodule, BLE brain): `work/ghidra/display-221122.elf` (full flash @0x0; app @0x23000).
- **GD32 controller** (GigaDevice, speed/power brain): `work/ghidra/controller-410.elf` (app @0x08003000).

## Running rea + Ghidra (PowerShell)
```powershell
$env:GHIDRA_INSTALL_DIR="C:\Users\Administrator\Desktop\super73-fw\tools\ghidra-dist\ghidra_12.2_PUBLIC"
$env:JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-25.0.5.8-hotspot"   # rea's Ghidra needs JDK 25+
$env:Path="C:\Program Files\nodejs;$env:JAVA_HOME\bin;"+$env:Path
npx -y rea-agents@6.9.0 inspect   <elf> --provider ghidra --json
npx -y rea-agents@6.9.0 search    <elf> <text> --kind procedures --provider ghidra --json
npx -y rea-agents@6.9.0 decompile <elf> --procedure=<name-or-0xaddr> --provider ghidra --json
```

## Legal posture
Road-legal (EU EPAC, 25 km/h / 250 W, mode 4) is the default. Understanding first; anything that
changes on-road behaviour stays an explicit opt-in, matching super73-puck's `--allow-unrestricted` gating.
