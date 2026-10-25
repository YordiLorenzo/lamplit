// Game titles from what stores and folders call them.

/// Drops trademark signs and doubled spaces: "Battlefield™ 2042" → "Battlefield 2042".
pub fn clean_name(name: &str) -> String {
    let stripped: String = name.chars().filter(|c| !matches!(c, '™' | '®' | '©')).collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Folder names to titles: "Cyberpunk2077" → "Cyberpunk 2077", "FarCry6" → "Far Cry 6". Names that already
/// have spaces are kept as they are ("F1 24" stays).
pub fn prettify(folder: &str) -> String {
    let base = folder.replace('_', " ");
    if base.contains(' ') {
        return clean_name(&base);
    }
    let chars: Vec<char> = base.chars().collect();
    let mut out = String::new();
    let mut letters_run = 0;
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let p = chars[i - 1];
            let camel = p.is_lowercase() && c.is_uppercase();
            let digit_after_word = c.is_ascii_digit() && p.is_alphabetic() && letters_run >= 3;
            if camel || digit_after_word {
                out.push(' ');
            }
        }
        letters_run = if c.is_alphabetic() { letters_run + 1 } else { 0 };
        out.push(c);
    }
    clean_name(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prettify_folder_names() {
        assert_eq!(prettify("Cyberpunk2077"), "Cyberpunk 2077");
        assert_eq!(prettify("Titanfall2"), "Titanfall 2");
        assert_eq!(prettify("FarCry6"), "Far Cry 6");
        assert_eq!(prettify("F1 24"), "F1 24");
        assert_eq!(prettify("F1_24"), "F1 24");
        assert_eq!(prettify("Skate"), "Skate");
    }

    #[test]
    fn clean_names() {
        assert_eq!(clean_name("Battlefield™ 2042"), "Battlefield 2042");
        assert_eq!(clean_name("Call of Duty®"), "Call of Duty");
    }
}
