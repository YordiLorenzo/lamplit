// Just enough of Valve's KeyValues text format for libraryfolders.vdf, appmanifest_*.acf, loginusers.vdf and
// localconfig.vdf.

pub enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        self.entries().iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Vdf::Str(s) => Some(s),
            Vdf::Map(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Map(items) => items,
            Vdf::Str(_) => &[],
        }
    }
}

enum Tok {
    Str(String),
    Open,
    Close,
}

/// Steam's files nest three or four maps deep. Each level costs stack, and every account on the PC can write these
/// files, so reading stops at this depth: a file nested deeper would otherwise crash Lamplit at every start.
const MAX_DEPTH: usize = 16;

pub fn parse(text: &str) -> Vdf {
    let mut tokens = tokenize(text).into_iter();
    Vdf::Map(parse_map(&mut tokens, 0))
}

fn parse_map(tokens: &mut impl Iterator<Item = Tok>, depth: usize) -> Vec<(String, Vdf)> {
    let mut items = Vec::new();
    while let Some(Tok::Str(key)) = tokens.next() {
        match tokens.next() {
            Some(Tok::Str(value)) => items.push((key, Vdf::Str(value))),
            Some(Tok::Open) if depth < MAX_DEPTH => items.push((key, Vdf::Map(parse_map(tokens, depth + 1)))),
            // Too deep: the rest of the file is skipped, so every level above ends here too.
            Some(Tok::Open) => tokens.by_ref().for_each(drop),
            Some(Tok::Close) | None => break,
        }
    }
    items
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => {}
                        },
                        '"' => break,
                        _ => s.push(c),
                    }
                }
                out.push(Tok::Str(s));
            }
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_library_folders() {
        let text = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps"
		{
			"228980"		"297968558"
		}
	}
	// A second library on another drive.
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}
"#;
        let vdf = parse(text);
        let libraries = vdf.get("libraryfolders").unwrap();
        let paths: Vec<&str> = libraries.entries().iter().filter_map(|(_, lib)| lib.str("path")).collect();
        assert_eq!(paths, vec![r"C:\Program Files (x86)\Steam", r"D:\SteamLibrary"]);
        let apps = libraries.get("0").and_then(|l| l.get("apps")).unwrap();
        assert_eq!(apps.str("228980"), Some("297968558"));
    }

    #[test]
    fn keys_match_in_any_case() {
        let vdf = parse(r#""AppState" { "appid" "1091500" "StateFlags" "4" }"#);
        let app = vdf.get("appstate").unwrap();
        assert_eq!(app.str("AppID"), Some("1091500"));
        assert_eq!(app.str("stateflags"), Some("4"));
        // A map is no string, and a string has no entries.
        assert_eq!(vdf.str("AppState"), None);
        assert!(app.get("appid").unwrap().entries().is_empty());
    }

    #[test]
    fn unescapes_strings() {
        let vdf = parse(r#""a" "say \"hi\"\tthen\nbye" "b" "back\\slash""#);
        assert_eq!(vdf.str("a"), Some("say \"hi\"\tthen\nbye"));
        assert_eq!(vdf.str("b"), Some(r"back\slash"));
    }

    #[test]
    fn stops_reading_a_file_nested_too_deep() {
        let deep = format!("{}\"key\" \"value\"", "\"a\" { ".repeat(100_000));
        let vdf = parse(&deep);
        let mut level = &vdf;
        let mut depth = 0;
        while let Some(inner) = level.get("a") {
            level = inner;
            depth += 1;
        }
        assert_eq!(depth, MAX_DEPTH);
        assert!(level.entries().is_empty());
    }

    #[test]
    fn keeps_what_it_read_of_a_cut_off_file() {
        let vdf = parse(r#""AppState" { "appid" "70" "name" "Half-Li"#);
        let app = vdf.get("AppState").unwrap();
        assert_eq!(app.str("appid"), Some("70"));
        assert_eq!(app.str("name"), Some("Half-Li"));
        // A key with no value before a closing brace is dropped, and its map ends there.
        let vdf = parse(r#""outer" { "lonely" } "after" "1""#);
        assert!(vdf.get("outer").unwrap().entries().is_empty());
        assert_eq!(vdf.str("after"), Some("1"));
    }
}
