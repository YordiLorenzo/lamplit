// Logitech's Centurion protocol, as the PRO X 2 LIGHTSPEED receiver speaks it on its vendor HID collection: 64-byte
// frames of 0x51, length, flags, then feature index, function << 4 | software id, parameters. The headset's own
// features sit behind the receiver's bridge feature (0x0003). The protocol comes from HeadsetControl and Solaar;
// docs/accessories.md has the details and sources. The headset module does the talking.

use crate::devices::Charge;

/// Lamplit's software id, so its answers are told apart from G HUB's (0x0A) and HeadsetControl's (0x01).
const SWID: u8 = 0x0C;
/// Feature ids: the receiver's bridge to the headset, and the headset's own features.
pub const BRIDGE: u16 = 0x0003;
pub const BATTERY: u16 = 0x0104;
pub const AUTO_OFF: u16 = 0x0108;
pub const SIDETONE: u16 = 0x0604;
/// The bridge's function that passes a request on to the headset.
const BRIDGE_SEND: u8 = 1;

/// A 64-byte frame around a payload.
fn frame(payload: &[u8]) -> [u8; 64] {
    let mut f = [0u8; 64];
    f[0] = 0x51;
    f[1] = payload.len() as u8 + 1;
    f[3..3 + payload.len()].copy_from_slice(payload);
    f
}

/// Which feature a message comes from: the receiver's feature at `index`, or (`headset`) the headset's behind the
/// bridge, and the function byte (function << 4 | software id).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Source {
    pub headset: bool,
    pub index: u8,
    pub function: u8,
}

#[derive(Debug, PartialEq)]
pub enum Message<'a> {
    /// An answer, with its data.
    Answer(Source, &'a [u8]),
    /// A request was refused: by the bridge when the headset is off, by the headset when it lacks the feature.
    Refused(Source),
    /// The receiver says the headset turned on (true) or off.
    Power(bool),
    /// Acknowledgements and anything else.
    Other,
}

pub fn parse(f: &[u8], bridge: Option<u8>) -> Message<'_> {
    if f.len() < 4 || f[0] != 0x51 {
        return Message::Other;
    }
    let len = usize::from(f[1]).saturating_sub(1).min(f.len() - 3);
    let p = &f[3..3 + len];
    let is_bridge = |b: &u8| Some(*b) == bridge;
    let from_headset = |index: u8, function: u8| Source { headset: true, index, function };
    match p {
        [0xFF, index, function, ..] => Message::Refused(Source { headset: false, index: *index, function: *function }),
        [b, 0x00, 0x00, on] if is_bridge(b) => Message::Power(*on != 0),
        // The headset's refusal: 0xFF, then the feature index and function byte it refuses, as in HID++ 2.0.
        [b, outer, _, _, 0x00, 0xFF, index, function, ..] if is_bridge(b) && outer >> 4 == BRIDGE_SEND => {
            Message::Refused(from_headset(*index, *function))
        }
        [b, outer, hi, lo, 0x00, index, function, rest @ ..] if is_bridge(b) && outer >> 4 == BRIDGE_SEND => {
            // The length counts the 0x00, the index and the function before the data.
            let n = (usize::from(*hi) << 8 | usize::from(*lo)).saturating_sub(3).min(rest.len());
            Message::Answer(from_headset(*index, *function), &rest[..n])
        }
        [b, ..] if is_bridge(b) => Message::Other,
        [index, function, data @ ..] => {
            Message::Answer(Source { headset: false, index: *index, function: *function }, data)
        }
        _ => Message::Other,
    }
}

/// One of Lamplit's requests: to the receiver's feature at `index`, or through `bridge` to the headset's.
#[derive(Clone, Copy)]
pub struct Request {
    bridge: Option<u8>,
    index: u8,
    function: u8,
}

/// What a message says about a request.
#[derive(Debug, PartialEq)]
pub enum Reply<'a> {
    Answer(&'a [u8]),
    Refused,
}

impl Request {
    pub fn to_receiver(index: u8, function: u8) -> Self {
        Request { bridge: None, index, function }
    }

    pub fn to_headset(bridge: u8, index: u8, function: u8) -> Self {
        Request { bridge: Some(bridge), index, function }
    }

    /// The frame that asks this, with `params`.
    pub fn frame(self, params: &[u8]) -> [u8; 64] {
        let head = [self.index, self.function << 4 | SWID];
        match self.bridge {
            None => frame(&[&head[..], params].concat()),
            Some(bridge) => {
                let inner = 3 + params.len();
                let outer = [bridge, BRIDGE_SEND << 4 | SWID, (inner >> 8) as u8, inner as u8, 0];
                frame(&[&outer[..], &head, params].concat())
            }
        }
    }

    /// The answer to this request or its refusal; None for anything else, such as G HUB's or HeadsetControl's
    /// traffic on the same receiver, which carries their software id.
    pub fn reply<'a>(self, message: &Message<'a>) -> Option<Reply<'a>> {
        let mine = Source { headset: self.bridge.is_some(), index: self.index, function: self.function << 4 | SWID };
        // While the headset is off, the receiver refuses the bridge's own request instead.
        let bridge_refused =
            self.bridge.map(|b| Source { headset: false, index: b, function: BRIDGE_SEND << 4 | SWID });
        match *message {
            Message::Answer(from, data) if from == mine => Some(Reply::Answer(data)),
            Message::Refused(from) if from == mine || Some(from) == bridge_refused => Some(Reply::Refused),
            _ => None,
        }
    }
}

/// The battery feature's answer, [level %, level again, charge]: charge 0 = on battery, 1 or 2 = charging (2: on
/// the cable), 3 = full.
pub fn battery(data: &[u8]) -> Option<(u8, Charge)> {
    let (&level, &charge) = (data.first()?, data.get(2)?);
    let charge = match charge {
        0 => Charge::Battery,
        1 | 2 => Charge::Charging,
        3 => Charge::Full,
        _ => Charge::NotCharging,
    };
    Some((level.min(100), charge))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 64-byte frame from hex bytes.
    fn hex(s: &str) -> Vec<u8> {
        let mut f: Vec<u8> = s.split_whitespace().map(|b| u8::from_str_radix(b, 16).unwrap()).collect();
        f.resize(64, 0);
        f
    }

    #[test]
    fn builds_requests_like_headsetcontrol() {
        // HeadsetControl (software id 1): bridge lookup, then the battery feature through bridge 03.
        let bridge = Request::to_receiver(0, 0).frame(&BRIDGE.to_be_bytes());
        assert_eq!(bridge.to_vec(), hex("51 05 00 00 0C 00 03"));
        let lookup = Request::to_headset(3, 0, 0).frame(&BATTERY.to_be_bytes());
        assert_eq!(lookup.to_vec(), hex("51 0A 00 03 1C 00 05 00 00 0C 01 04"));
        let battery = Request::to_headset(3, 4, 0).frame(&[]);
        assert_eq!(battery.to_vec(), hex("51 08 00 03 1C 00 03 00 04 0C"));
        let sidetone = Request::to_headset(3, 7, 1).frame(&[0x01, 0xFF, 40]);
        assert_eq!(sidetone.to_vec(), hex("51 0B 00 03 1C 00 06 00 07 1C 01 FF 28"));
    }

    #[test]
    fn reads_a_windows_capture() {
        // From HeadsetControl issue #539 (G HUB's software id 0x0A): an ack, then the battery at 100 %, on battery.
        assert_eq!(parse(&hex("51 03 00 03 1A 00"), Some(3)), Message::Other);
        let answer = hex("51 0B 00 03 10 00 06 00 04 0A 64 64 00");
        let message = parse(&answer, Some(3));
        let Message::Answer(Source { headset: true, index: 4, function: 0x0A }, data) = message else {
            panic!("not a headset answer: {message:?}")
        };
        assert_eq!(data, &[0x64, 0x64, 0x00]);
        assert_eq!(battery(data), Some((100, Charge::Battery)));
        // It answers G HUB, not Lamplit.
        assert_eq!(Request::to_headset(3, 4, 0).reply(&message), None);
        let ours = hex("51 0B 00 03 10 00 06 00 04 0C 64 64 00");
        assert_eq!(Request::to_headset(3, 4, 0).reply(&parse(&ours, Some(3))), Some(Reply::Answer(&[100, 100, 0])));
    }

    #[test]
    fn hears_power() {
        assert_eq!(parse(&hex("51 05 00 03 00 00 01"), Some(3)), Message::Power(true));
        assert_eq!(parse(&hex("51 05 00 03 00 00 00"), Some(3)), Message::Power(false));
    }

    #[test]
    fn takes_only_its_own_refusals() {
        let battery = Request::to_headset(3, 4, 0);
        // The bridge refuses Lamplit's request (function 1, software id 0x0C): the headset is off.
        let frame = hex("51 05 00 FF 03 1C 05");
        let refused = parse(&frame, Some(3));
        assert_eq!(refused, Message::Refused(Source { headset: false, index: 3, function: 0x1C }));
        assert_eq!(battery.reply(&refused), Some(Reply::Refused));
        // The same refusal of G HUB's request (software id 0x0A) is not Lamplit's.
        assert_eq!(battery.reply(&parse(&hex("51 05 00 FF 03 1A 05"), Some(3))), None);
        // The headset refuses a feature: Lamplit's request to it, then G HUB's.
        assert_eq!(battery.reply(&parse(&hex("51 0A 00 03 10 00 05 00 FF 04 0C 02"), Some(3))), Some(Reply::Refused));
        assert_eq!(battery.reply(&parse(&hex("51 0A 00 03 10 00 05 00 FF 04 0A 02"), Some(3))), None);
    }

    #[test]
    fn finds_the_bridge_before_knowing_it() {
        // The receiver's answer to the lookup: the bridge is at index 3.
        let frame = hex("51 06 00 00 0C 03 00 01");
        let root = parse(&frame, None);
        assert_eq!(root, Message::Answer(Source { headset: false, index: 0, function: 0x0C }, &[3, 0, 1]));
        assert_eq!(Request::to_receiver(0, 0).reply(&root), Some(Reply::Answer(&[3, 0, 1])));
    }

    #[test]
    fn charge_states() {
        assert_eq!(battery(&[55, 55, 2]), Some((55, Charge::Charging)));
        assert_eq!(battery(&[100, 100, 3]), Some((100, Charge::Full)));
        assert_eq!(battery(&[40]), None);
    }
}
