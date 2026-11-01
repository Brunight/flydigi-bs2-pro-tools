# Flydigi Cooler web control

A web page for every Bluetooth command of a Flydigi BS2 / BS2 Pro (and BS3) laptop cooler.
The Bun server owns the Bluetooth connection. The page only calls server functions, so any
browser works.

Bun · TanStack Start · React · Tailwind · TypeScript ·
[webbluetooth](https://github.com/thegecko/webbluetooth-rs) (btleplug: BlueZ on Linux,
WinRT on Windows).

## Run

```sh
bun install
bun run dev          # http://localhost:3000
```

Production:

```sh
bun run build
bun run start        # PORT / HOST env vars, localhost:3000 by default
```

Then click **Connect**. The server scans for 10 s and picks the first device named like
`FlyDigi BS2PRO`. Set `COOLER_NAME="FlyDigi BS2PRO"` to require an exact name.

## Pair the cooler first

On Linux the cooler rejected every request until it was paired: BlueZ timed out and the
cooler replied with ATT error `0x0E`. After a Just Works pairing everything worked:

```sh
bluetoothctl --agent NoInputNoOutput pair <cooler address>
```

Or pair it in your desktop's Bluetooth settings. To undo it, run `bluetoothctl remove <address>`.
If connecting times out, pairing is the first thing to check.

## What's on the page

- **Status**: fan RPM, gear or custom speed, power supply, light strip. Polled once a
  second, because the BS2 Pro doesn't push status frames over this channel. Gear LEDs,
  auto standby and auto-start have no query command, so they show the last value sent from here.
- **Quick controls**: gear 1–4, a custom-speed slider (sends `0x23` then `0x21`), wake.
- **Every command**, grouped (fan, lighting, settings, queries, raw lighting upload, danger
  zone), with its inputs and the decoded reply.
- **Lighting effect**: solid, breathing or rainbow, uploaded as `0x41` → `0x47` frames → `0x43`.
- **Log**: every frame sent and received, in hex. Status polling is left out.

## Safety

- `0xDF` erases the cooler's firmware and is not in the app. `frame()` refuses to build it.
- Factory reset, demo mode (stays on until you unplug the cooler) and disabling the checksum
  check need a confirmation. The server rejects them without it.
- The server checks every value against the command's allowed range before sending. Payloads
  never exceed 15 bytes, because the firmware's vendor channel copies an unchecked length
  into a 64-byte buffer.
- The server listens on localhost only by default. Anyone who can open the page can control
  the cooler.

## Notes

- Tested on Linux against a BS2 Pro (firmware 0.0.3.5): connect, queries, polling,
  custom speed and gear changes. Windows should work (webbluetooth ships WinRT binaries),
  but it hasn't been tried.
- The BS2 Pro lighting layout (10 LEDs, 306-byte buffer) comes from another project and
  hasn't been confirmed against its firmware. The BS3 (6 LEDs) layout is confirmed.
- `patches/webbluetooth@7.1.0.patch` adds `dist/uuid.js`, which is missing from the
  published package. Without it, importing the package fails.
- In dev, the connection lives on `globalThis` so it survives hot reloads. After editing
  `src/server/cooler.server.ts`, restart the dev server to load the new code.
- Protocol source: [flydigictl](https://github.com/ElXreno/flydigictl) `docs/FIRMWARE.md`.

```sh
bun test             # protocol, command validation, lighting buffer
```
