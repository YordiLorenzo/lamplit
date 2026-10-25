// Just enough XML for the files stores leave next to their games: EA's installerdata.xml and the Xbox app's
// MicrosoftGame.config and AppxManifest.xml.

/// The text between the first `start` and the `end` after it.
pub fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let len = text[from..].find(end)?;
    Some(&text[from..from + len])
}

pub fn unescape(s: &str) -> String {
    s.replace("&apos;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

pub fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        rest = rest[start..].find("-->").map_or("", |end| &rest[start + end + 3..]);
    }
    out.push_str(rest);
    out
}

/// Attribute `attr` of every `<tag ...>` element, whatever the whitespace and quote style.
pub fn tag_attrs(text: &str, tag: &str, attr: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let mut out = Vec::new();
    for (i, _) in text.match_indices(&open) {
        let rest = &text[i + open.len()..];
        // The name must end here: `<Application Id=…` yes, `<ApplicationList>` no.
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '/' || c == '>') {
            continue;
        }
        let Some(end) = rest.find('>') else { continue };
        if let Some((_, value)) = attributes(&rest[..end]).into_iter().find(|(name, _)| name == attr) {
            out.push(unescape(&value));
        }
    }
    out
}

/// The `name="value"` pairs of one element (`name = 'value'` and line breaks are valid XML too).
fn attributes(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chars = s.char_indices().peekable();
    let skip_space = |chars: &mut std::iter::Peekable<std::str::CharIndices>| {
        while chars.next_if(|(_, c)| c.is_whitespace() || *c == '/').is_some() {}
    };
    loop {
        skip_space(&mut chars);
        let Some(&(start, _)) = chars.peek() else { break };
        while chars.next_if(|(_, c)| !c.is_whitespace() && *c != '=').is_some() {}
        let name = s[start..chars.peek().map_or(s.len(), |(i, _)| *i)].to_string();
        skip_space(&mut chars);
        if chars.next_if(|(_, c)| *c == '=').is_none() {
            if name.is_empty() {
                break;
            }
            continue; // an attribute without a value
        }
        skip_space(&mut chars);
        let Some((_, quote)) = chars.next_if(|(_, c)| *c == '"' || *c == '\'') else { break };
        let from = chars.peek().map_or(s.len(), |(i, _)| *i);
        let to = chars.by_ref().find(|(_, c)| *c == quote).map_or(s.len(), |(i, _)| i);
        out.push((name, s[from..to].to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attrs_skip_comments() {
        let cfg = "<Game><!-- <Executable Name=\"old.exe\" /> --><Executable Name=\"Cities2.exe\" TargetDeviceFamily=\"PC\" />\
            <ShellVisuals DefaultDisplayName=\"Cities: Skylines II - PC Edition\" /></Game>";
        let cfg = strip_comments(cfg);
        assert_eq!(tag_attrs(&cfg, "Executable", "Name"), vec!["Cities2.exe"]);
        assert_eq!(tag_attrs(&cfg, "ShellVisuals", "DefaultDisplayName"), vec!["Cities: Skylines II - PC Edition"]);
    }

    #[test]
    fn attrs_any_formatting() {
        let manifest = "<Applications>\n  <Application\n    Id = 'Game'\n    Executable=\"GameLaunchHelper.exe\">\
            <ApplicationList Id=\"wrong\"/><Identity Name=\"A&amp;B\" Publisher=\"CN=x\"/>";
        assert_eq!(tag_attrs(manifest, "Application", "Id"), vec!["Game"]);
        assert_eq!(tag_attrs(manifest, "Application", "Executable"), vec!["GameLaunchHelper.exe"]);
        assert_eq!(tag_attrs(manifest, "Identity", "Name"), vec!["A&B"]);
        assert!(tag_attrs(manifest, "Application", "Missing").is_empty());
    }
}
