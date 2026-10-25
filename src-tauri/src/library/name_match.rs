// Matching a game from another store to its page on Steam's public store by name: what to search for, and which
// search result is the game. art.rs makes the requests.

/// What to search the store for: the name, then the name without its edition when that differs.
pub fn queries(name: &str) -> Vec<String> {
    let mut queries = vec![name.to_string()];
    let stripped = strip_edition(name);
    if stripped != norm(name) {
        queries.push(stripped);
    }
    queries
}

/// The same name (editions aside: "Tomb Raider: Definitive Edition" is Steam's "Tomb Raider Game of the Year"),
/// else the longest store title the game's name starts with, never "Shadow of the Tomb Raider".
pub fn best_match(name: &str, items: &[(u32, String)]) -> Option<u32> {
    let wanted = [norm(name), strip_edition(name)];
    if let Some((id, _)) = items.iter().find(|(_, n)| wanted.contains(&norm(n)) || wanted.contains(&strip_edition(n))) {
        return Some(*id);
    }
    items
        .iter()
        .map(|(id, n)| (*id, norm(n)))
        .filter(|(_, n)| !n.is_empty() && wanted.iter().any(|w| w.starts_with(&format!("{n} "))))
        .max_by_key(|(_, n)| n.len())
        .map(|(id, _)| id)
}

fn norm(s: &str) -> String {
    let mapped: String = s.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { ' ' }).collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_edition(name: &str) -> String {
    const SUFFIXES: &[&str] = &[
        "definitive edition", "pc edition", "game of the year edition", "game of the year", "goty edition", "goty",
        "deluxe edition", "complete edition", "ultimate edition", "standard edition", "gold edition",
    ];
    let mut n = norm(name);
    for s in SUFFIXES {
        if let Some(rest) = n.strip_suffix(s) {
            n = rest.trim_end().to_string();
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_store_titles() {
        let shadow = vec![(750_920, "Shadow of the Tomb Raider: Definitive Edition".to_string())];
        assert_eq!(best_match("Tomb Raider: Definitive Edition", &shadow), None);
        let tr = vec![
            (391_220, "Rise of the Tomb Raider™".to_string()),
            (750_920, "Shadow of the Tomb Raider: Definitive Edition".to_string()),
            (203_160, "Tomb Raider Game of the Year".to_string()),
            (8000, "Tomb Raider: Anniversary".to_string()),
        ];
        assert_eq!(best_match("Tomb Raider: Definitive Edition", &tr), Some(203_160));
        let skate = vec![(1_263_240, "Skate Story".to_string()), (3_354_750, "skate.".to_string())];
        assert_eq!(best_match("Skate", &skate), Some(3_354_750));
        let cities = vec![(949_230, "Cities: Skylines II".to_string())];
        assert_eq!(best_match("Cities: Skylines II - PC Edition", &cities), Some(949_230));
        let ghost = vec![(460_930, "Tom Clancy's Ghost Recon® Wildlands".to_string())];
        assert_eq!(best_match("Tom Clancy's Ghost Recon Wildlands", &ghost), Some(460_930));
    }

    #[test]
    fn searches_without_the_edition_too() {
        assert_eq!(queries("Tomb Raider: Definitive Edition"), vec!["Tomb Raider: Definitive Edition", "tomb raider"]);
        assert_eq!(queries("Skate"), vec!["Skate"]);
    }

    #[test]
    fn strips_editions() {
        assert_eq!(strip_edition("Some Game GOTY Edition"), "some game");
        assert_eq!(strip_edition("Some Game: Game of the Year Edition"), "some game");
        // Suffixes stack, in the order SUFFIXES lists them.
        assert_eq!(strip_edition("Some Game PC Edition: Definitive Edition"), "some game");
        assert_eq!(strip_edition("Edition"), "edition");
    }
}
