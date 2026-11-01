# flydigi-bs2-pro-tools

Tools for controlling a Flydigi BS2 Pro laptop cooler over Bluetooth, without Flydigi's software.

| Folder | What it is |
|---|---|
| [`debug-dashboard/`](debug-dashboard/README.md) | Debug dashboard: a Bun server (TanStack Start, React, Tailwind) owns the Bluetooth link and exposes every command. Linux and Windows. |
| [`fan-control/`](fan-control/README.md) | Headless executable (`bun build --compile --aot --trim`) that sets the fan speed from CPU/GPU temperature and turns the cooler off on exit. |
| [`esphome/`](esphome/README.md) | ESP32 firmware config that bridges the cooler to Home Assistant. |

Protocol source: [flydigictl](https://github.com/ElXreno/flydigictl) `docs/FIRMWARE.md`.
Commands go to GATT characteristic `FFF2` of service `FFF0`, and replies arrive on `FFF1`.

## Notes

- On Linux, the cooler only answered after it was paired (Just Works). See `debug-dashboard/README.md`.
  The ESP32 config doesn't pair yet, so it may need that too.
- There is no "off" command. The cooler sleeps when its last host disconnects while auto
  standby is on, or when you long-press its button. A paired Linux laptop keeps an HID link
  open, which counts as a host, so the dashboard's **Turn off** button probably doesn't work there yet.
