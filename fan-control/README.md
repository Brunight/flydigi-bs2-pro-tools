# Flydigi cooler fan control

A single executable that keeps the cooler connected over Bluetooth and sets its fan speed
from the hotter of the CPU and GPU. Below the curve's first temperature (55 °C by default) it
turns the cooler off by disconnecting, and reconnects once it's warmer. On battery it leaves
the cooler off and stops looking for it. A tray icon shows where the temperature sits on the curve. When it exits (Ctrl+C, SIGTERM, SIGHUP), it puts
the cooler to sleep and disconnects.

Bun · TypeScript · [webbluetooth](https://github.com/thegecko/webbluetooth-rs) (BlueZ on Linux, WinRT on Windows).
Runs on Linux and Windows (x64).
The protocol and Bluetooth code are cut down from [`../debug-dashboard`](../debug-dashboard/README.md).

## Build

`--aot` and `--trim` are only in Bun canary for now (1.4.4 stable doesn't have them):

```sh
bun upgrade --canary
bun install
bun run build        # bun build --compile --aot --trim → dist/flydigi-fan (.exe on Windows)
```

`bun run start` runs it from source without building. `bun test` covers the curve and frames.

Build on the platform you're building for: `--aot` can't cross-compile. Each build only holds
its own platform's code. `--compile --target` replaces `process.platform` with the target's
value (same as `--define process.platform:'"win32"'`), the bundler folds the checks, and drops
the other platform's `import()`. So the Windows executable has no dbus-next, and the Linux one
has no Win32 code. To keep it that way, write platform checks inline next to a dynamic
`import()` (as in `src/tray/index.ts` and `src/sensors/index.ts`). A `const isWindows = …`
in between isn't folded through.

## Run

```sh
./dist/flydigi-fan
./dist/flydigi-fan --curve 60:1300,70:2400,85:4000 --save   # save it, then run
./dist/flydigi-fan                                          # uses the saved curve
./dist/flydigi-fan --help
```

Pair the cooler first on Linux (see [`../debug-dashboard`](../debug-dashboard/README.md#pair-the-cooler-first)).
Windows connects to it without pairing.

On Windows, the CPU temperature needs administrator rights (see [Sensors](#how-it-works)).
Without them it runs on the GPU temperature alone and says so. To start it elevated at
logon without a UAC prompt, add a scheduled task from an elevated PowerShell. Use these
settings rather than plain `schtasks /create`. By default a task only starts on AC power,
stops when the laptop switches to battery, and is killed after 72 hours:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\path\to\flydigi-fan.exe'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName 'Flydigi fan control' -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -RunLevel Highest
```

The task runs whatever file is at that path, so it can point at `dist\flydigi-fan.exe`.
Windows locks a running executable, so quit it (tray → Quit) before `bun run build`, then
`schtasks /run /tn "Flydigi fan control"` starts the new build without logging out again.
After a tray Restart, Task Scheduler no longer tracks the process: it only watches the one it
started, which has exited. Running the task again then finds it already running and exits.

| Option | Default | |
|---|---|---|
| `--curve` | saved curve, else `55:1300,65:2500,75:3200,85:4000` | °C:RPM points, straight lines between them, 1300–4000 RPM. Below the first point the cooler is off |
| `--save` | | Save `--curve` to `~/.config/flydigi-fan/config.json` (`$XDG_CONFIG_HOME` if set; `%APPDATA%\flydigi-fan\config.json` on Windows), then run. The tray's Gear LEDs setting is kept there too |
| `--interval` | `2` | Seconds between reads |
| `--down-delay` | `10` | Seconds a lower speed must hold before the fan slows down. Speeding up is immediate |
| `--off-delay` | `30` | Seconds it has to stay below the curve before turning off |
| `--name` / `COOLER_NAME` | anything like `FlyDigi BS2PRO` | Exact Bluetooth name |
| `--cpu`, `--gpu` | auto | Comma-separated temperature files in millidegrees, like sysfs (any file works, on Windows too) |
| `--verbose` | off | Print every reading |
| `--no-tray` | | No tray icon |

## Tray icon

A fan inside a ring. The ring fills clockwise from the curve's first temperature to its last
(full), and shifts green → amber → red. While the fan runs there's always a short green arc,
even at the lowest speed; the ring is empty only when the cooler is off. The fan is greyed out while the cooler is off
or not connected. The tooltip shows the CPU and GPU temperatures and the speed.

In a gear mode the ring shows the gear's speed on the cooler's 1300–4000 RPM range instead.

The menu (left or right click):

- **Mode**: **Smart** follows the curve (the default at every start). **Gear 1–4** hand the
  speed to the cooler's own gears, labelled with their RPM once connected. A gear ignores the
  temperature, so it also turns on a cooler that was off for being cold. Gears faster than the
  power supply allows (5 V: 2700 RPM, 9 V: 3300 RPM) are greyed out, and a gear the cooler
  refuses falls back to Smart. The chosen gear is resent every 30 s, in case the cooler's
  button changed it.
- **Light strip**: on or off. Its state is read from the cooler on connect.
- **Gear LEDs**: on or off. The cooler can't report this one, so it's saved to
  `config.json` (`gearLeds`) and applied on every connect.
- **Force off**: turns the cooler off and keeps it off until unchecked, whatever the
  temperature or mode.
- **Run on battery**: drives the cooler on battery too, for when the laptop is on the cooler
  without its charger.
- **Open config file**: opens `config.json` in the default app, creating it with the
  current curve if it doesn't exist. Edits apply on restart.
- **Restart**: turns the cooler off, then starts the program again with the same options.
- **Quit**: same as Ctrl+C, turns the cooler off and exits.

Not saved: the mode, Force off and Run on battery. Every start begins in Smart, with both
unchecked.

On Linux it's a StatusNotifierItem over D-Bus ([`dbus-next`](https://github.com/dbusjs/node-dbus-next)),
which KDE, XFCE, Cinnamon and others show. GNOME needs the AppIndicator extension. With no
tray available it logs that and keeps running. The fan is light grey, made for dark panels.

On Windows it's `Shell_NotifyIconW` on a hidden window, through `bun:ffi` (`src/tray/win32.ts`),
with a native popup menu. The fan is dark grey on a light taskbar and follows theme changes.
New icons start in the taskbar's overflow; drag it out to keep it visible. Bun's event loop
doesn't run a Windows message loop, so the window's messages are pumped every 100 ms. While
the menu is open, Windows runs its own loop and the program waits for the menu to close.

Both draw the same icon, in code (`src/tray/icon.ts`) as plain pixels.

## How it works

- **Sensors**: the CPU uses `coretemp` "Package id 0", `k10temp`/`zenpower` "Tdie"/"Tctl",
  any hwmon labelled "CPU", or the `x86_pkg_temp` thermal zone. For the GPU it reads every
  source it finds and uses the hottest: `amdgpu`, `nouveau`, and hwmon labelled "GPU" (laptop
  EC drivers such as `legion_hwmon`). `nvidia-smi` is only a fallback when no EC sensor reports
  the GPU: each call costs about 1% of a core, and polling can keep the dGPU awake. Even then,
  it's skipped while the dGPU is runtime-suspended, because running it would wake the GPU.
- **Sensors on Windows**: Lenovo Legion laptops report the CPU and GPU from the EC over WMI,
  the same readings as `legion_hwmon`: `LENOVO_OTHER_METHOD.GetFeatureValue` on 2024+ models
  (IDs `0x05040000`/`0x05050000`, about 5 ms each), else `LENOVO_GAMEZONE_DATA.GetCPUTemp`/`GetGPUTemp`.
  That needs administrator rights. The WMI calls go over COM through `bun:ffi` (`src/win32/wmi.ts`), with no
  PowerShell. Other machines have no CPU temperature on Windows without a kernel driver.
  When the EC doesn't report the GPU, an NVIDIA GPU is read through NVML (`nvml.dll`,
  installed with the driver). NVML is opened and shut down for each read, about 12 ms, and
  skipped while the dGPU isn't in D0. The power state comes from the PnP manager, which
  doesn't wake the GPU.
- **Speed**: enters custom-speed mode (`0x23`) and sets the RPM (`0x21`), rounded to 100.
  If the cooler refuses because it left custom mode (button press, reconnect), it enters
  custom mode again. The speed is resent every 30 s anyway, and capped at what the power
  supply allows (5 V: 2700, 9 V: 3300).
- **Cold**: below the curve's first temperature for `--off-delay` seconds, it turns the cooler
  off the same way it does on exit (below), then stays disconnected. At or above that
  temperature it reconnects and follows the curve again. If it's already cold at startup, it connects once
  and turns the cooler off right away, so a cooler left running gets switched off too.
- **Battery**: on battery the laptop is normally off the cooler. A Bluetooth scan for a cooler
  that isn't there would only drain the battery, and so would the sensor reads. So on battery
  it turns the cooler off if it's still connected, then reads nothing and scans for nothing.
  Within one interval of mains power coming back, it carries on as after a cold spell. Power
  comes from `GetSystemPowerStatus` on Windows. On Linux it comes from `/sys/class/power_supply`:
  on battery when a system battery exists and no charger (Mains, USB-C…) is online.
- **No readings**: runs the fan at full speed.
- **Disconnects**: it reconnects on its own, retrying every 5 s.
- **One instance**: two would fight over the cooler, so a second start says it's already
  running and exits. `--save` still saves the curve first, and Restart in the running one's
  tray applies it. On Windows it's a mutex in the session, held by the running instance and
  freed if it crashes. On Linux it's a PID file in `$XDG_RUNTIME_DIR`, replaced when the
  process in it is gone. Restart releases it before starting the new process.
- **Exit**: sets the lowest speed (1300 RPM), then auto standby to "when disconnected"
  (`0x0D 01`), which is saved on the cooler, then disconnects. The cooler wakes at the speed
  it had when it went to sleep, and the laptop's Bluetooth stack can reconnect to it on boot
  before this program starts, so this keeps that wake-up quiet. The cooler sleeps once no host is connected, so a USB host or
  another Bluetooth connection keeps it running. Press Ctrl+C a second time to quit at once.

## Tested with

- **Cooler**: Flydigi BS2 Pro.
- **Laptop**: Lenovo Legion Pro 5i 16IAX10H (2025, Gen 10), Intel Core Ultra 9 275HX and
  NVIDIA GeForce RTX 5070 Ti Laptop GPU.
- **Linux**: CachyOS with KDE Plasma, and
  [LenovoLegionLinux](https://github.com/johnfanv2/lenovolegionlinux) for the EC sensors
  (`legion_hwmon`).
- **Windows**: Windows 11, alongside
  [Lenovo Legion Toolkit](https://github.com/LenovoLegionToolkit-Team/LenovoLegionToolkit).

## Notes

- Tested on Linux: connected, read sensors, set the speed, turned off when cold and back on
  when warm (tested with `--cpu`/`--gpu` pointed at a fake temperature file), and disconnected
  cleanly on SIGINT/SIGTERM.
- Tested on Windows, from source and as the `--aot --trim` executable: connected without
  pairing, read NVML, set the speed, turned off when cold, and turned off and disconnected
  on Ctrl+C. About 70 MB of memory and 1% of a core at the default interval. Elevated, the
  executable picked the Lenovo EC for both the CPU and the GPU.
- `patches/webbluetooth@7.1.0.patch` adds the missing `dist/uuid.js`, like in `../debug-dashboard`, and
  `dist/native.js`. `native.js` loads the native addon with a plain `require`. The stock
  napi-rs loader `require()`s a path from an env var, which stops `--trim` from removing
  unused APIs. The patched loader only covers Linux x64 (glibc) and Windows x64.
- `patches/dbus-next@0.10.2.patch` drops the optional `usocket` native addon (plain Unix
  sockets are enough), and `patches/xmlbuilder@11.0.1.patch` replaces a
  `Function.prototype.toString` check. Both stopped `--trim` from removing unused APIs.
- `--trim` still keeps some APIs, because the program loads the Bluetooth native addon.
