// Steam's client settings as `SteamClient.Settings.SetSetting` takes them: a CMsgClientSettings protobuf message,
// base64-encoded. Only bool fields are needed, so this writes just those.

/// A bool setting of Steam's client.
pub struct Setting {
    /// Its field in Steam's CMsgClientSettings (SteamDatabase/Protobufs, steammessages_clientsettings.proto).
    pub field: u32,
    /// Its name in Steam's settings store, which reads it back.
    pub name: &'static str,
}

pub const GUIDE_BUTTON_FOCUSES_STEAM: Setting = Setting { field: 14002, name: "controller_guide_button_focus_steam" };
pub const DISABLE_ALL_TOASTS: Setting = Setting { field: 6000, name: "disable_all_toasts" };
pub const DISABLE_TOASTS_IN_GAME: Setting = Setting { field: 6001, name: "disable_toasts_in_game" };

/// A CMsgClientSettings with only these bool fields, base64 as SetSetting takes it.
pub fn message(fields: &[(u32, bool)]) -> String {
    let mut bytes = Vec::new();
    for &(field, value) in fields {
        varint(&mut bytes, u64::from(field) << 3);
        varint(&mut bytes, u64::from(value));
    }
    base64(&bytes)
}

fn varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let byte = (n & 0x7F) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | (u32::from(b) << (16 - 8 * i)));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 0x3F) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_settings_like_steam() {
        // Guide button off, all toasts off, toasts in game off: a message a running Steam client accepted.
        let fields = [(14002, false), (6000, true), (6001, true)];
        assert_eq!(message(&fields), "kOsGAID3AgGI9wIB");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }
}
