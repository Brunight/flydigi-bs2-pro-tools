#pragma once
// Flydigi BS2 / BS2 Pro / BS3 cooler protocol over the vendor GATT service 0xFFF0.
// Commands are written to 0xFFF2, replies and status frames arrive on 0xFFF1.
// Source: https://github.com/ElXreno/flydigictl docs/FIRMWARE.md (firmware disassembly).
//
// Frame: 5A A5 <cmd> <len> <payload...> <checksum>
//   len      = payload length + 2
//   checksum = (cmd + len + sum(payload)) & 0xFF
//
// Only known-safe commands are exposed on purpose. Never send:
//   0xDF erases the firmware, 0x06 factory-resets, 0x03 latches demo mode until a power cycle,
//   0x08 with a gear outside 1..4 corrupts the stored gear.

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <vector>

namespace flydigi {

constexpr uint8_t CMD_WAKE = 0x05;
constexpr uint8_t CMD_SELECT_GEAR = 0x08;
constexpr uint8_t CMD_STANDBY = 0x0D;
constexpr uint8_t CMD_SET_RPM = 0x21;
constexpr uint8_t CMD_ENTER_REALTIME = 0x23;
constexpr uint8_t CMD_EXIT_REALTIME = 0x24;
constexpr uint8_t CMD_STRIP_POWER = 0x46;
constexpr uint8_t CMD_GEAR_LEDS = 0x48;
constexpr uint8_t CMD_STATUS = 0xEF;

constexpr int MIN_RPM = 1300;
constexpr int MAX_RPM = 4000;

inline int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline std::vector<uint8_t> frame(uint8_t cmd, std::initializer_list<uint8_t> payload = {}) {
  std::vector<uint8_t> f{0x5A, 0xA5, cmd, static_cast<uint8_t>(payload.size() + 2)};
  uint8_t sum = f[2] + f[3];
  for (uint8_t b : payload) {
    f.push_back(b);
    sum += b;
  }
  f.push_back(sum);
  return f;
}

inline std::vector<uint8_t> wake() { return frame(CMD_WAKE); }
inline std::vector<uint8_t> enter_realtime() { return frame(CMD_ENTER_REALTIME); }
inline std::vector<uint8_t> exit_realtime() { return frame(CMD_EXIT_REALTIME); }

// Gear 1..4. The cooler refuses gears its power supply can't drive and keeps the old one.
inline std::vector<uint8_t> select_gear(int gear) {
  return frame(CMD_SELECT_GEAR, {static_cast<uint8_t>(clamp(gear, 1, 4))});
}

// Only takes effect after enter_realtime(). The firmware would accept 0, but a zero target
// can leave the fan stall-latched until the cooler sleeps, so it's clamped to the vendor range.
inline std::vector<uint8_t> set_rpm(int rpm) {
  int r = clamp(rpm, MIN_RPM, MAX_RPM);
  return frame(CMD_SET_RPM, {static_cast<uint8_t>(r & 0xFF), static_cast<uint8_t>(r >> 8)});
}

// 0 = never sleep, 1 = sleep when the last host disconnects, 2 = sleep 60 s after that.
inline std::vector<uint8_t> standby(int mode) {
  return frame(CMD_STANDBY, {static_cast<uint8_t>(clamp(mode, 0, 2))});
}

inline std::vector<uint8_t> strip_power(bool on) { return frame(CMD_STRIP_POWER, {on ? uint8_t{1} : uint8_t{0}}); }
inline std::vector<uint8_t> gear_leds(bool on) { return frame(CMD_GEAR_LEDS, {on ? uint8_t{1} : uint8_t{0}}); }

// Single entry point for the ESPHome `send` script. Anything outside this list yields an
// empty vector, which the script refuses to write.
inline std::vector<uint8_t> build(int cmd, int arg) {
  switch (cmd) {
    case CMD_WAKE: return wake();
    case CMD_SELECT_GEAR: return select_gear(arg);
    case CMD_STANDBY: return standby(arg);
    case CMD_SET_RPM: return set_rpm(arg);
    case CMD_ENTER_REALTIME: return enter_realtime();
    case CMD_EXIT_REALTIME: return exit_realtime();
    case CMD_STRIP_POWER: return strip_power(arg != 0);
    case CMD_GEAR_LEDS: return gear_leds(arg != 0);
    default: return {};
  }
}

// Decoded 0xEF status frame, pushed by the cooler every 500 ms.
struct Status {
  bool asleep;
  int gear;    // effective gear 1..4, after the supply clamp
  bool usb;    // a USB host is attached
  int supply;  // 0 undecided, 1 = 5 V (max 2700 RPM), 2 = 9 V (max 3300), 3 = PD 20 V (full)
  bool realtime;
  int standby;
  bool gear_leds;
  bool strip;
  int rpm;
  int target_rpm;
};

// 0xFFF1 is fed from a byte FIFO, so one notification can hold several frames or part of one.
class Parser {
 public:
  // Returns true and fills `out` when at least one valid status frame completed.
  bool feed(const std::vector<uint8_t> &data, Status &out) {
    buf_.insert(buf_.end(), data.begin(), data.end());
    bool got = false;
    for (;;) {
      size_t i = 0;
      while (i + 1 < buf_.size() && !(buf_[i] == 0x5A && buf_[i + 1] == 0xA5))
        i++;
      buf_.erase(buf_.begin(), buf_.begin() + i);
      if (buf_.size() < 4)
        break;
      uint8_t len = buf_[3];
      if (len < 2 || len > 0x40) {  // not a real header, skip the magic and resync
        buf_.erase(buf_.begin(), buf_.begin() + 2);
        continue;
      }
      size_t total = static_cast<size_t>(len) + 3;
      if (buf_.size() < total)
        break;
      uint8_t sum = 0;
      for (size_t k = 2; k + 1 < total; k++)
        sum += buf_[k];
      if (sum != buf_[total - 1]) {
        buf_.erase(buf_.begin(), buf_.begin() + 2);
        continue;
      }
      if (buf_[2] == CMD_STATUS && len == 0x0D) {
        decode_(buf_.data(), out);
        got = true;
      }
      buf_.erase(buf_.begin(), buf_.begin() + total);
    }
    if (buf_.size() > 256)
      buf_.clear();
    return got;
  }

  void reset() { buf_.clear(); }

 private:
  static void decode_(const uint8_t *f, Status &s) {
    uint8_t flags = f[4], mode = f[5], lights = f[6];
    s.asleep = flags & 0x01;
    s.gear = ((flags >> 1) & 0x03) + 1;
    s.usb = flags & 0x10;
    s.supply = (flags >> 5) & 0x03;
    s.realtime = mode & 0x01;
    s.standby = (mode >> 2) & 0x03;
    s.gear_leds = lights & 0x01;
    s.strip = lights & 0x04;
    s.rpm = f[7] | (f[8] << 8);
    s.target_rpm = f[9] | (f[10] << 8);
  }

  std::vector<uint8_t> buf_;
};

}  // namespace flydigi
