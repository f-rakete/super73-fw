# Notice on third-party content

This is a private reverse-engineering / interoperability research archive for a SUPER73 S2
owned by the repository owner.

- **Firmware images** under `work/firmware/` (nRF52 display, GD32 controller) are the property of
  SUPER73 / Comodule and were obtained from the community project **reverse.bike**. The `*-unlocked-*`
  and ZX `*-r405-*` packages are reverse.bike modifications, kept only for differential analysis.
  They are included here for the owner's own research on hardware they possess and are **not for
  redistribution**.
- **App-derived artifacts** (strings, decompiled excerpts, DTO field names) originate from the
  SUPER73 companion app `com.comodule.super`; the app itself is not included.
- **Prior protocol work** referenced here comes from Walker73 (AxelFougues), and the owner's own
  `hasuper73` and `super73-puck` repositories.
- **Analysis tools** (rea, jadx, Ghidra) are not vendored; see `HANDOFF.md` for how to obtain them.

Everything in this repo is observational analysis of software on the owner's own device. The project
keeps a road-legal-by-default posture (see `FINDINGS.md` → Legal posture).
