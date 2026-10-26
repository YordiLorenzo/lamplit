# Accessories: what Lamplit talks to, and how

This page describes the hardware protocols behind the code in `src-tauri/src/devices/`: `pad/` (DualSense reports,
Xbox-style and other controllers, navigation, the touchpad as a mouse), `headset/`, `audio.rs` (sound devices) and
`accessories.rs` (where the sound goes). Read it before you change that code or add a device. Everything here comes
from public sources, listed under each part.

What has been tested:

- **DualSense:** over USB and Bluetooth.
- **DualSense Edge:** not tested. It sends the same reports as the DualSense, and Lamplit reads it the same way.
- **Xbox-style controllers (XInput) and other controllers (Windows.Gaming.Input):** not tested on real controllers;
  the mapping and navigation have unit tests.
- **Logitech G PRO X 2 LIGHTSPEED:** built from public sources only. Finding the receiver and reading the headset
  as off work; battery, sidetone, auto-off and the on and off messages are not yet confirmed on a real headset. If
  you have one, please open an issue with the `headset:` lines from `%LOCALAPPDATA%\lamplit\lamplit.log`.

## Logitech G PRO X 2 LIGHTSPEED (receiver 046D:0AF7)

The receiver doesn't speak HID++; it uses Logitech's newer **Centurion** protocol. The HID++ ids (0x1F20, 0x8300,
reports 0x10/0x11) belong to the other PRO X 2 product ids (0x0AFB, 0x0AFC), not this one.

- **Collection:** interface 3, usage page 0xFFA0, usage 0x0001. Lamplit picks it with `usage_page() == 0xFFA0`.
  hidapi opens it shared, so G HUB or HeadsetControl can run alongside.
- **Frame:** 64 bytes: `51 <len> <flags> <payload…>`, zero-padded; `len` = payload length + 1.
  Payload: `<feature index> <function << 4 | software id> <params…>`. Lamplit's software id is 0x0C (G HUB uses
  0x0A, HeadsetControl 0x01).
- **Bridge:** the headset's features sit behind the receiver's feature 0x0003. Find its index with
  `51 05 00 00 0C 00 03` (root feature, getFeature 0x0003): the answer's data starts with the index.
- **Request to the headset:** `51 <len> 00 <bridge> 1C <lenHi> <lenLo> 00 <index> <fn << 4 | 0C> <params…>`, where
  `lenHi lenLo` counts from the `00` on (3 + params).
- **Answer:** an ack (`51 03 00 <bridge> 1C 00`), then `[bridge, 0x10, lenHi, lenLo, 00, index, fn|swid, data…]`.
  The inner `fn|swid` echoes the asker's software id, so Lamplit takes only answers that carry 0x0C.
- **Refused:** `FF <bridge> 1C <code>` from the receiver means the bridge refused Lamplit's request: the headset is
  off. `[bridge, 0x10, lenHi, lenLo, 00, FF, index, fn|swid, code]` means the headset refused that feature. Both
  carry the asker's software id, and G HUB's refusals reach Lamplit too, so Lamplit takes only its own.
- **Headset on/off:** the receiver pushes `51 05 00 <bridge> 00 00 01` (on) and `…00 00 00` (off). While off, every
  bridged request is refused.
- **Feature lookup:** headset root (index 0), function 0, params `<idHi> <idLo>` → `[index, type, version]`; index 0
  = not there.

| Feature | Id | Read (function 0) | Write (function 1) |
|---|---|---|---|
| Battery | 0x0104 | `[level %, level, charge]`; charge 0 battery, 1 or 2 charging (2 = cable), 3 full | none |
| Auto-off | 0x0108 | `[minutes]` (version ≤2) or `[reserved, minutes]` (3); newer has several timers | same layout, minutes 0 = never |
| Sidetone | 0x0604 | `[mics, mic id, level]` or `[mics, mic id, reserved, level]` | `[01, level]` or `[01, FF, level]`, 0 to 100 |
| EQ | 0x020D | fn 0 info (bytes 3 and 4: min/max gain dB), fn 3 `[00]` active slot, fn 1 `[00, slot]` bands | fn 2 `[00, slot, (freqHi, freqLo, gain)×5]` |

Lamplit reads and writes battery, auto-off and sidetone. EQ is not built (bands 80, 240, 750, 2200, 6600 Hz; G HUB
presets Flat `0,0,0,0,0`, Bass Boost `4,2,0,0,0`, Shooter `-1,-1,4,3,2`). Mic features seen on one PRO X 2: 0x0602
(noise reduction); Solaar lists 0x0601 (mute) and 0x0611 (gain).

Cautions:
- Polling while the headset is off has wedged a receiver on Windows (HID discovery took ~60 s; HeadsetControl PR
  #538). Lamplit reads only when the headset says it is on, the battery every 5 minutes.
- Settings live on the headset and follow it to other PCs.
- With the headset off, Windows still sees the receiver as an active sound device and sends nothing: Lamplit moves the
  sound itself on the on/off message.

Sources: HeadsetControl `lib/devices/logitech_gpro_x2_lightspeed.hpp`,
`lib/devices/protocols/logitech_centurion_protocol.hpp`, issues #477 and #539 (a Windows capture without G HUB:
TX `51 08 00 03 1A 00 03 00 04 0A`, RX `51 0B 00 03 10 00 06 00 04 0A 64 64 00` = 100 %, on battery), PR #593;
Solaar `lib/logitech_receiver/centurion.py`, `base.py`, `settings_templates.py`.

## DualSense

Offsets include the report id (hidapi's byte 0). Lamplit lists only Sony's HID devices (vendor 054C, products 0CE6
DualSense and 0DF2 DualSense Edge) every 2 seconds.

| Field | USB, report 0x01 (64 B) | Bluetooth, report 0x31 (78 B) | Bluetooth, report 0x01 (10 B) |
|---|---|---|---|
| Left stick x, y | 1, 2 | 2, 3 | 1, 2 |
| Buttons | 8 to 10 | 9 to 11 | 5 to 7 |
| Touch points | 33 to 40 | 34 to 41 | none |
| Battery + charging | 53 | 54 | none |
| Plugged flags | 54 | 55 | none |

- Buttons: first byte d-pad in the low nibble (0 up, 1 to 3 right, 4 down, 5 to 7 left, 8 none), 0x10 square, 0x20
  cross, 0x40 circle, 0x80 triangle; second byte 0x01 L1, 0x02 R1, 0x10 create, 0x20 options; third byte 0x01 PS,
  0x02 touchpad pressed.
- Touch points: two of 4 bytes each: a contact byte (bit 7 set when the finger is up), then 12-bit x (0 to 1919)
  and 12-bit y (0 to 1079): `x = b1 | (b2 & 0x0F) << 8`, `y = b2 >> 4 | b3 << 4`.
- Battery byte: low nibble 0 to 10 (Lamplit shows `n × 10 + 5`, at most 100 %); high nibble 0 battery, 1 charging,
  2 full, 0xA/0xB not charging (voltage or temperature), 0xF error.
- Plugged flags: bit 0 headphones, bit 1 mic, bit 2 mic muted, 0x08 USB.
- Bluetooth's reduced report 0x01 (10 bytes, sent until someone asks for full reports) has no battery. Reading
  feature report 0x09 or 0x20 switches to 0x31 for good and breaks DirectInput for non-SDL games, so Lamplit never
  does; Steam (SDL) usually has switched it already.
- Sound through the controller's jack works over USB only (4 channels: 1 and 2 speaker/jack, 3 and 4 haptics).
- Turning off: `IOCTL_BTH_DISCONNECT_DEVICE` (0x0041000C) on the first Bluetooth radio, with the controller's
  address (hidapi's serial number on Windows, e.g. `a1b2c3d4e5f6`) as a u64. The controller powers down when the
  link drops (SpecialK does the same).

Sources: Linux `drivers/hid/hid-playstation.c`, SDL `SDL_hidapi_ps5.c` and `SDL_hints.h`, SpecialK
`src/input/bluetooth.cpp`, Microsoft's IOCTL_BTH_DISCONNECT_DEVICE page.

## Xbox-style controllers (XInput)

Xbox controllers, and others that present themselves the same way, sit in XInput's four slots (xinput1_4.dll, in
every Windows from 8 on). Lamplit reads them with `XInputGetState` every 15 ms while one is connected, and looks at
empty slots every 2 seconds, since asking an empty slot is slow. It never calls `XInputSetState` (rumble) or
`XInputEnable`.

- XInput keeps working while another window is in front, unlike Windows.Gaming.Input, so View and Menu held for a
  second can bring Lamplit over a game. The Xbox button belongs to Windows' Game Bar, and XInput documents no way to
  read it (SDL reads it through the undocumented `XInputGetStateEx`, ordinal 100; Lamplit doesn't).
- Connection: `XINPUT_CAPS_WIRELESS` in `XInputGetCapabilities`; XInput doesn't say Bluetooth or the wireless
  adapter.
- Battery: `XInputGetBatteryInformation` gives only a level (empty, low, medium, full), and only for alkaline or
  NiMH batteries; a wired controller reports `BATTERY_TYPE_WIRED`.
- USB ids: `XInputGetCapabilitiesEx`, exported by ordinal 108 only, adds the vendor and product id to
  `XINPUT_CAPABILITIES` (SDL reads it the same way). Lamplit uses them to name a Microsoft controller and to tell
  Steam Input's virtual controllers apart.
- Steam Input: while a Steam game runs, Steam adds a virtual controller (Valve's ids, `28DE:11FF`) to XInput for each
  controller it handles. Lamplit leaves those slots alone: it reads the real controller already, a DualSense over HID
  or an Xbox controller in its own slot. Steam hides the real controller only from the game's own process.

## Other controllers (Windows.Gaming.Input)

Every other controller Windows knows comes through `RawGameController` (Windows.Gaming.Input), with its name
(`DisplayName`), whether it is wireless, and a battery report when it has one. Lamplit leaves out controllers it reads
another way: the DualSense, Valve's (Steam Input's own), and the Xbox-style ones, which Windows.Gaming.Input also
offers as a `Gamepad`. A driver can make another controller a `Gamepad` too, without an XInput slot, so a gamepad is
left out only while it is Microsoft's or XInput has a controller with its USB ids; otherwise Lamplit reads it as a
`Gamepad`, whose buttons have names.

- Windows hands Windows.Gaming.Input's input only to the program in front, so these controllers are read only while
  Lamplit is, and reading starts over each time it comes back, so a button already held isn't a press.
- The buttons come as a numbered list without names (`GetButtonLabel` knows only a few controllers). Lamplit takes
  the order most DirectInput controllers use, the DualShock 4's and Logitech's: 1 west (Square), 2 south (Cross), 3
  east (Circle), 4 north (Triangle), 5 L1, 6 R1, 9 view (Share), 10 menu (Options). The direction comes from the
  first hat switch, else the first two axes.
- A Sony controller other than the DualSense gets PlayStation symbols in the hints; the others get Xbox letters.

Sources: Microsoft's XInput and Windows.Gaming.Input reference; SDL `src/core/windows/SDL_xinput.c`,
`src/joystick/windows/SDL_xinputjoystick.c` and its gamecontrollerdb entries for the DualShock 4 and Logitech's
DirectInput mode; Unity's issue tracker on Windows.Gaming.Input and background input.

## Default sound device

`IPolicyConfig` (CLSID 870AF99C-171D-4F9E-AF0D-E63DF40C2BC9, IID F8679F50-850A-41CF-9C72-430F290290C8), the
undocumented interface the Settings app uses, as Sunshine, EarTrumpet and SoundSwitch do. A device the player picks
in Lamplit's Settings gets all three roles (console, multimedia, communications).

## Where the sound goes

With "Sound follows" on (the default), Lamplit moves the default output and microphone when the headset turns on or
off and when headphones go into or out of a controller:

1. Headphones in a controller on a USB cable: to the controller ("Wireless Controller" in the device's name).
2. Else the PRO X 2 while it is on: to its receiver ("PRO X 2" in the name).
3. Else back to the device Lamplit moved the sound away from. When it doesn't know one (Lamplit restarted meanwhile,
   or that device is gone), the output goes to the TV: the sound device of a screen's HDMI or DisplayPort link
   (`PKEY_AudioEndpoint_FormFactor` is `DigitalAudioDisplayDevice`), whatever the graphics card.

It never moves the sound off a device the player picked, and it doesn't guess between two that fit (two wired
controllers, or a monitor and a TV that both have sound); lamplit.log says so (`sound:` lines). Each move sets the
console and multimedia roles, and the communications role only when it was on the same device as the console one, so
a separate device for calls (a USB headset for chat, say) stays where the player set it.
