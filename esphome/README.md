# Flydigi BS2 Pro cooler → Home Assistant (ESPHome)

An ESP32 talks to the cooler over Bluetooth LE and exposes it to Home Assistant.
No pairing is needed: the cooler's vendor service (`0xFFF0`) accepts commands unencrypted.

Protocol source: firmware disassembly in [flydigictl](https://github.com/ElXreno/flydigictl)
(`docs/FIRMWARE.md`), done on a BS3 Pro. It documents the BS2 Pro as using the same protocol.

## Entities

| Entity | What it does |
|---|---|
| **Fan mode** (select) | Gear 1–4, or Custom speed |
| **Custom speed** (number) | 1300–4000 RPM slider. Moving it switches to custom speed |
| **Fan speed** (sensor) | Measured RPM, updated every 500 ms (100 RPM resolution) |
| **Running** (binary sensor) | Cooler awake / asleep |
| **Light strip** (switch) | RGB strip on/off |
| **Wake** (button) | Wakes the cooler if it is asleep |
| **Bluetooth link enabled** (switch) | Lets the ESP32 release the cooler (see below) |
| Gear indicator LEDs, Auto standby | Config |
| Target speed, Power supply, Connected, Bluetooth signal | Diagnostics |

## Setup

1. `cp secrets.yaml.example secrets.yaml` and fill it in. Generate the key with
   `python3 -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"`.
2. Set `board:` in `flydigi-cooler.yaml` to match your ESP32. Any ESP32 with Bluetooth works,
   but the ESP32-S2 has no Bluetooth.
3. **Disconnect the cooler from your laptop's Bluetooth** (remove/forget it). It accepts one
   Bluetooth connection, and the laptop will hold it otherwise.
4. Flash: `uvx esphome run flydigi-cooler.yaml` (USB the first time, then OTA).
5. In the logs, look for `Found Flydigi cooler '...' at AABBCCDDEEFF`. Put that address
   in `cooler_mac` as `AA:BB:CC:DD:EE:FF` and flash again.
6. Home Assistant discovers the device. Add it with the API key from `secrets.yaml`.

## Things to know

- **Power the cooler from a charger, not the laptop.** The firmware limits the fan to
  2700 RPM on laptop USB power, 3300 at 9 V, and runs unlimited only on a USB-PD supply. The
  *Power supply* sensor shows which one it detected (once per power-up).
- **Custom speed comes back after a reconnect.** The cooler drops custom-speed mode when it
  loses its last connection. The ESP32 re-applies it when it reconnects. Pressing the
  cooler's own button returns control to the gears.
- **There is no "off" command.** The only real off is the cooler's sleep state. While the ESP32
  holds the link, the cooler counts as connected and never goes to standby on its own. To
  switch it off from Home Assistant, set *Auto standby* to "When disconnected", then turn
  off *Bluetooth link enabled*. Turning the link back on wakes the cooler.
  (A 0 RPM target looks like an option, but the firmware can latch the fan as stalled, so
  this config won't send it.)
- **Commands are whitelisted** in `flydigi.h`. The protocol includes commands that erase the
  firmware (`0xDF`) or factory-reset the cooler (`0x06`), and nothing here can send them.

## Example automation

Turn the fan up when the laptop is busy (needs a CPU sensor from the laptop, e.g. via
[HASS.Agent](https://github.com/hass-agent/HASS.Agent) on Windows or
[go-hass-agent](https://github.com/joshuar/go-hass-agent) on Linux):

```yaml
automation:
  - alias: Cooler follows CPU temperature
    trigger:
      - platform: state
        entity_id: sensor.laptop_cpu_temperature
    action:
      - action: number.set_value
        target:
          entity_id: number.laptop_cooler_custom_speed
        data:
          value: >
            {% set t = states('sensor.laptop_cpu_temperature') | float(50) %}
            {{ [1300, [4000, ((t - 45) * 100) | round(-2)] | min] | max }}
```
