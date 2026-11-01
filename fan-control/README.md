# Flydigi cooler fan control

A single executable that keeps the cooler connected over Bluetooth and sets its fan speed
from the hotter of the CPU and GPU. Below the curve's first temperature (55 °C by default) it
turns the cooler off by disconnecting, and reconnects once it's warmer. A tray icon shows where the temperature sits on the curve. When it exits (Ctrl+C, SIGTERM, SIGHUP), it puts
the cooler to sleep and disconnects.

Bun · TypeScript · [webbluetooth](https://github.com/thegecko/webbluetooth-rs) (BlueZ on Linux).
The protocol and Bluetooth code are cut down from [`../debug-dashboard`](../debug-dashboard/README.md).

## Build

`--aot` and `--trim` are only in Bun canary for now (1.4.4 stable doesn't have them):

```sh
bun upgrade --canary
bun install
bun run build        # bun build --compile --aot --trim → dist/flydigi-fan
```

`bun run start` runs it from source without building. `bun test` covers the curve and frames.

## Run

```sh
./dist/flydigi-fan
./dist/flydigi-fan --curve 60:1300,70:2400,85:4000 --save   # save it, then run
./dist/flydigi-fan                                          # uses the saved curve
./dist/flydigi-fan --help
```

Pair the cooler first (see [`../debug-dashboard`](../debug-dashboard/README.md#pair-the-cooler-first)).

| Option | Default | |
|---|---|---|
| `--curve` | saved curve, else `55:1300,65:2500,75:3200,85:4000` | °C:RPM points, straight lines between them, 1300–4000 RPM. Below the first point the cooler is off |
| `--save` | | Save `--curve` to `~/.config/flydigi-fan/config.json` (`$XDG_CONFIG_HOME` if set), then run |
| `--interval` | `2` | Seconds between reads |
| `--down-delay` | `10` | Seconds a lower speed must hold before the fan slows down. Speeding up is immediate |
| `--off-delay` | `30` | Seconds it has to stay below the curve before turning off |
| `--name` / `COOLER_NAME` | anything like `FlyDigi BS2PRO` | Exact Bluetooth name |
| `--cpu`, `--gpu` | auto | Comma-separated sysfs temperature files (millidegrees) |
| `--verbose` | off | Print every reading |
| `--no-tray` | | No tray icon |

## Tray icon

A fan inside a ring. The ring fills clockwise from the curve's first temperature to its last
(full), and shifts green → amber → red. While the fan runs there's always a short green arc,
even at the lowest speed; the ring is empty only when the cooler is off. The fan is greyed out while the cooler is off
or not connected. The tooltip shows the CPU and GPU temperatures and the speed.

The menu (left or right click):

- **Force off**: turns the cooler off and keeps it off until unchecked, whatever the
  temperature. It's not saved: every start begins unchecked.
- **Quit**: same as Ctrl+C, turns the cooler off and exits.

On Linux it's a StatusNotifierItem over D-Bus ([`dbus-next`](https://github.com/dbusjs/node-dbus-next)),
which KDE, XFCE, Cinnamon and others show. GNOME needs the AppIndicator extension. With no
tray available it logs that and keeps running. The icon is drawn in code (`src/tray/icon.ts`)
as plain pixels, so a Windows tray can reuse it. Windows has no tray yet. The fan is light
grey, made for dark panels.

## How it works

- **Sensors**: the CPU uses `coretemp` "Package id 0", `k10temp`/`zenpower` "Tdie"/"Tctl",
  any hwmon labelled "CPU", or the `x86_pkg_temp` thermal zone. For the GPU it reads every
  source it finds and uses the hottest: `amdgpu`, `nouveau`, hwmon labelled "GPU" (laptop
  EC drivers such as `legion_hwmon`) and `nvidia-smi`. If an NVIDIA dGPU is runtime-suspended,
  `nvidia-smi` is skipped, because running it would wake the GPU and keep it awake.
- **Speed**: enters custom-speed mode (`0x23`) and sets the RPM (`0x21`), rounded to 100.
  If the cooler refuses because it left custom mode (button press, reconnect), it enters
  custom mode again. The speed is resent every 30 s anyway, and capped at what the power
  supply allows (5 V: 2700, 9 V: 3300).
- **Cold**: below the curve's first temperature for `--off-delay` seconds, it turns the cooler
  off the same way it does on exit (below), then stays disconnected. At or above that
  temperature it reconnects and follows the curve again. If it's already cold at startup, it connects once
  and turns the cooler off right away, so a cooler left running gets switched off too.
- **No readings**: runs the fan at full speed.
- **Disconnects**: it reconnects on its own, retrying every 5 s.
- **Exit**: sets auto standby to "when disconnected" (`0x0D 01`), which is saved on the
  cooler, then disconnects. The cooler sleeps once no host is connected, so a USB host or
  another Bluetooth connection keeps it running. Press Ctrl+C a second time to quit at once.

## Notes

- Tested on Linux (BS2 Pro, Intel CPU + NVIDIA laptop GPU): connected, read sensors, set the
  speed, turned off when cold and back on when warm (tested with `--cpu`/`--gpu` pointed at a
  fake temperature file), and disconnected cleanly on SIGINT/SIGTERM.
- `patches/webbluetooth@7.1.0.patch` adds the missing `dist/uuid.js`, like in `../debug-dashboard`, and
  `dist/native.js`. `native.js` loads the native addon with a plain `require`. The stock
  napi-rs loader `require()`s a path from an env var, which stops `--trim` from removing
  unused APIs. The patched loader only covers Linux x64 (glibc) and Windows x64.
- `patches/dbus-next@0.10.2.patch` drops the optional `usocket` native addon (plain Unix
  sockets are enough), and `patches/xmlbuilder@11.0.1.patch` replaces a
  `Function.prototype.toString` check. Both stopped `--trim` from removing unused APIs.
- `--trim` still keeps some APIs, because the program loads the Bluetooth native addon.
