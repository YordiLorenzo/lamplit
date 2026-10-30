// Just enough SQLite to read whole tables from the databases two store apps keep their installs in: the Amazon Games
// app's GameInstallInfo.sqlite and the itch app's butler.db. Lamplit reads the database and its write-ahead log
// (`-wal`) as plain files, the way the file format describes them (https://www.sqlite.org/fileformat2.html). So it
// takes no lock the store app could wait on, writes nothing (a SQLite reader would write the `-shm` index), and needs
// no C library. Anything it doesn't understand reads as no table.

use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// One row of a table, its values by column name.
#[derive(Debug)]
pub struct Row(HashMap<String, Value>);

impl Row {
    pub fn get(&self, column: &str) -> &Value {
        self.0.get(&column.to_lowercase()).unwrap_or(&Value::Null)
    }

    /// The column's text; None for NULL or another type.
    pub fn text(&self, column: &str) -> Option<&str> {
        match self.get(column) {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn int(&self, column: &str) -> Option<i64> {
        match self.get(column) {
            Value::Int(n) => Some(*n),
            _ => None,
        }
    }
}

/// A database as it stood at its last commit: the file's pages, with newer copies from the write-ahead log on top.
pub struct Db {
    file: Vec<u8>,
    wal: Vec<u8>,
    /// Page number to where the page's latest committed copy starts in `wal`.
    from_wal: HashMap<u32, usize>,
    page_size: usize,
    /// The part of each page that holds data (the rest is reserved for extensions).
    usable: usize,
    /// 1 UTF-8, 2 UTF-16LE, 3 UTF-16BE.
    encoding: u32,
}

const MAGIC: &[u8] = b"SQLite format 3\0";

impl Db {
    pub fn open(path: &Path) -> Option<Db> {
        let file = std::fs::read(path).ok()?;
        let mut wal_path = path.as_os_str().to_owned();
        wal_path.push("-wal");
        let wal = std::fs::read(wal_path).unwrap_or_default();
        Db::from_bytes(file, wal)
    }

    fn from_bytes(file: Vec<u8>, wal: Vec<u8>) -> Option<Db> {
        let (wal_page_size, from_wal) = committed_frames(&wal).unwrap_or_default();
        let mut db = Db { file, wal, from_wal, page_size: wal_page_size, usable: 0, encoding: 1 };
        if db.page_size == 0 {
            let size = u16::from_be_bytes([*db.file.get(16)?, *db.file.get(17)?]);
            db.page_size = if size == 1 { 65536 } else { usize::from(size) };
        }
        if !db.page_size.is_power_of_two() || !(512..=65536).contains(&db.page_size) {
            return None;
        }
        // The header is the start of page 1, which the log may hold a newer copy of.
        let header = db.page(1)?.get(..100)?;
        if &header[..16] != MAGIC {
            return None;
        }
        let usable = db.page_size - usize::from(header[20]);
        let encoding = match be32(&header[56..]) {
            0 => 1, // a database without a single table yet
            n => n,
        };
        (db.usable, db.encoding) = (usable, encoding);
        (usable >= 480 && (1..=3).contains(&encoding)).then_some(db)
    }

    fn page(&self, n: u32) -> Option<&[u8]> {
        if let Some(&at) = self.from_wal.get(&n) {
            return self.wal.get(at..at + self.page_size);
        }
        let at = (n as usize).checked_sub(1)? * self.page_size;
        self.file.get(at..at + self.page_size)
    }

    /// Every row of a table; None when there is no such table, or it isn't one this reader can read.
    pub fn rows(&self, table: &str) -> Option<Vec<Row>> {
        let schema = self.records(1)?;
        let (root, sql) = schema.iter().find_map(|(_, r)| match r.as_slice() {
            [Value::Text(kind), Value::Text(name), _, Value::Int(root), Value::Text(sql)]
                if kind == "table" && name.eq_ignore_ascii_case(table) =>
            {
                Some((*root, sql))
            }
            _ => None,
        })?;
        let (names, rowid_column) = columns(sql)?;
        let rows = self.records(u32::try_from(root).ok()?)?;
        let row = |(rowid, mut values): (i64, Vec<Value>)| {
            // A column added after the row was written is missing from it.
            values.resize(names.len(), Value::Null);
            if let Some(i) = rowid_column {
                values[i] = Value::Int(rowid);
            }
            Row(names.iter().map(|n| n.to_lowercase()).zip(values).collect())
        };
        Some(rows.into_iter().map(row).collect())
    }

    /// The rowid and values of each record in the table b-tree that starts at page `root`.
    fn records(&self, root: u32) -> Option<Vec<(i64, Vec<Value>)>> {
        let mut out = Vec::new();
        let mut stack = vec![root];
        // A page can't be visited twice in a sound tree; the limit keeps a damaged one from looping.
        let mut budget = self.file.len() / self.page_size + self.from_wal.len();
        while let Some(n) = stack.pop() {
            budget = budget.checked_sub(1)?;
            let page = self.page(n)?;
            let start = if n == 1 { 100 } else { 0 };
            let header = page.get(start..start + 12)?;
            let cells = usize::from(u16::from_be_bytes([header[3], header[4]]));
            let (pointers, leaf) = match header[0] {
                0x0D => (start + 8, true),
                0x05 => (start + 12, false),
                _ => return None, // an index or a WITHOUT ROWID table
            };
            let mut children = Vec::new();
            for i in 0..cells {
                let at =
                    usize::from(u16::from_be_bytes([*page.get(pointers + 2 * i)?, *page.get(pointers + 2 * i + 1)?]));
                let cell = page.get(at..)?;
                if leaf {
                    let (len, a) = varint(cell)?;
                    let (rowid, b) = varint(&cell[a..])?;
                    let payload = self.payload(&cell[a + b..], usize::try_from(len).ok()?)?;
                    out.push((rowid as i64, self.record(&payload)?));
                } else {
                    children.push(be32(cell.get(..4)?));
                }
            }
            if !leaf {
                children.push(be32(&header[8..]));
                // Reversed, so the leftmost child comes off the stack first and the rows come out in rowid order.
                stack.extend(children.into_iter().rev());
            }
        }
        Some(out)
    }

    /// A cell's whole payload: the part on the page, then the overflow pages it continues on.
    fn payload(&self, local: &[u8], len: usize) -> Option<Vec<u8>> {
        let u = self.usable;
        let max_local = u - 35;
        if len <= max_local {
            return local.get(..len).map(<[u8]>::to_vec);
        }
        // A payload can't be longer than the database, nor its overflow chain come back to a page: either is damage,
        // which would otherwise grow the payload until memory runs out.
        if len > self.file.len() + self.from_wal.len() * self.page_size {
            return None;
        }
        let min_local = (u - 12) * 32 / 255 - 23;
        let k = min_local + (len - min_local) % (u - 4);
        let on_page = if k <= max_local { k } else { min_local };
        let mut out = local.get(..on_page)?.to_vec();
        let mut next = be32(local.get(on_page..on_page + 4)?);
        let mut seen = HashSet::new();
        while out.len() < len {
            if !seen.insert(next) {
                return None;
            }
            let page = self.page(next)?;
            let take = (u - 4).min(len - out.len());
            out.extend_from_slice(page.get(4..4 + take)?);
            next = be32(page);
        }
        Some(out)
    }

    fn record(&self, payload: &[u8]) -> Option<Vec<Value>> {
        let (header_len, mut at) = varint(payload)?;
        let header_len = usize::try_from(header_len).ok()?;
        let mut body = header_len;
        let mut out = Vec::new();
        while at < header_len {
            let (kind, n) = varint(payload.get(at..header_len)?)?;
            at += n;
            let int = |len: usize| {
                let bytes = payload.get(body..body + len)?;
                // Big-endian two's complement in 1 to 8 bytes: sign-extend from the first byte.
                let first = i64::from(bytes[0] as i8);
                Some(bytes[1..].iter().fold(first, |v, &b| (v << 8) | i64::from(b)))
            };
            let (value, len) = match kind {
                0 => (Value::Null, 0),
                1..=4 => (Value::Int(int(kind as usize)?), kind as usize),
                5 => (Value::Int(int(6)?), 6),
                6 => (Value::Int(int(8)?), 8),
                7 => (Value::Real(f64::from_bits(int(8)? as u64)), 8),
                8 => (Value::Int(0), 0),
                9 => (Value::Int(1), 0),
                10 | 11 => return None,
                _ => {
                    let len = usize::try_from((kind - 12) / 2).ok()?;
                    let bytes = payload.get(body..body + len)?;
                    let value = if kind % 2 == 0 { Value::Blob(bytes.to_vec()) } else { Value::Text(self.text(bytes)) };
                    (value, len)
                }
            };
            body += len;
            out.push(value);
        }
        Some(out)
    }

    fn text(&self, bytes: &[u8]) -> String {
        let units =
            |order: fn([u8; 2]) -> u16| -> Vec<u16> { bytes.chunks_exact(2).map(|c| order([c[0], c[1]])).collect() };
        match self.encoding {
            2 => String::from_utf16_lossy(&units(u16::from_le_bytes)),
            3 => String::from_utf16_lossy(&units(u16::from_be_bytes)),
            _ => String::from_utf8_lossy(bytes).into_owned(),
        }
    }
}

fn be32(b: &[u8]) -> u32 {
    b.get(..4).map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// SQLite's variable-length integer: big-endian, 7 bits a byte, the ninth byte taking all 8.
fn varint(b: &[u8]) -> Option<(u64, usize)> {
    let mut v = 0u64;
    for i in 0..9 {
        let c = *b.get(i)?;
        if i == 8 {
            return Some(((v << 8) | u64::from(c), 9));
        }
        v = (v << 7) | u64::from(c & 0x7f);
        if c < 0x80 {
            return Some((v, i + 1));
        }
    }
    None
}

/// The pages the write-ahead log holds as of its last commit, and its page size. A frame counts only while its salt
/// matches the log's header (frames from before the last reset don't) and its checksum chain holds (a frame being
/// written doesn't); frames after the last commit frame belong to a transaction still under way.
fn committed_frames(wal: &[u8]) -> Option<(usize, HashMap<u32, usize>)> {
    let header = wal.get(..32)?;
    let big_endian = match be32(header) {
        0x377f_0682 => false,
        0x377f_0683 => true,
        _ => return None,
    };
    let page_size = be32(&header[8..]) as usize;
    let mut sum = checksum(big_endian, &header[..24], (0, 0));
    if sum != (be32(&header[24..]), be32(&header[28..])) {
        return None;
    }
    let (mut committed, mut pending) = (HashMap::new(), Vec::new());
    let mut at = 32;
    while let Some(frame) = wal.get(at..at + 24 + page_size) {
        let (head, page) = frame.split_at(24);
        if head[8..16] != header[16..24] {
            break;
        }
        sum = checksum(big_endian, page, checksum(big_endian, &head[..8], sum));
        if sum != (be32(&head[16..]), be32(&head[20..])) {
            break;
        }
        pending.push((be32(head), at + 24));
        // A commit frame records the database's size after the commit; other frames leave it 0.
        if be32(&head[4..]) != 0 {
            committed.extend(pending.drain(..));
        }
        at += 24 + page_size;
    }
    Some((page_size, committed))
}

/// The log's running checksum, over 32-bit words in the byte order its magic number names.
fn checksum(big_endian: bool, data: &[u8], (mut s0, mut s1): (u32, u32)) -> (u32, u32) {
    let word = |b: &[u8]| {
        let b = [b[0], b[1], b[2], b[3]];
        if big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
    };
    for pair in data.chunks_exact(8) {
        s0 = s0.wrapping_add(word(&pair[..4])).wrapping_add(s1);
        s1 = s1.wrapping_add(word(&pair[4..])).wrapping_add(s0);
    }
    (s0, s1)
}

/// The column names of a `CREATE TABLE` statement, and which column is the rowid under another name (the only
/// primary key column, declared `INTEGER`): its value isn't stored in the record. None for a WITHOUT ROWID table,
/// whose rows this reader doesn't read.
fn columns(sql: &str) -> Option<(Vec<String>, Option<usize>)> {
    let body = &sql[sql.find('(')? + 1..];
    let mut defs = Vec::new();
    let (mut depth, mut quote, mut start) = (0, None, 0);
    for (i, c) in body.char_indices() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (None, '\'' | '"' | '`') => quote = Some(c),
            (None, '[') => quote = Some(']'),
            (None, '(') => depth += 1,
            (None, ')') if depth == 0 => {
                defs.push(&body[start..i]);
                if body[i + 1..].to_ascii_uppercase().contains("WITHOUT ROWID") {
                    return None;
                }
                break;
            }
            (None, ')') => depth -= 1,
            (None, ',') if depth == 0 => {
                defs.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    let mut names = Vec::new();
    let (mut integer, mut keys) = (Vec::new(), Vec::new());
    for def in defs {
        let def = def.trim();
        let (name, rest) = identifier(def);
        let upper = def.to_ascii_uppercase();
        if ["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"].contains(&name.to_ascii_uppercase().as_str())
            && !def.starts_with(['"', '`', '['])
        {
            // A table constraint; PRIMARY KEY (a, b) names the key's columns.
            if let Some(list) = upper.find("PRIMARY KEY").and_then(|i| def[i..].split_once('(')).map(|(_, l)| l) {
                let list = list.split(')').next().unwrap_or_default();
                keys.extend(list.split(',').map(|k| identifier(k.trim()).0.to_lowercase()));
            }
            continue;
        }
        if upper.contains("PRIMARY KEY") {
            keys.push(name.to_lowercase());
        }
        if rest.split_whitespace().next().is_some_and(|t| t.eq_ignore_ascii_case("INTEGER"))
            && !upper.contains("KEY DESC")
        {
            integer.push(name.to_lowercase());
        }
        names.push(name);
    }
    let rowid = match keys.as_slice() {
        [key] if integer.contains(key) => names.iter().position(|n| n.to_lowercase() == *key),
        _ => None,
    };
    Some((names, rowid))
}

/// An identifier at the start of `s`, unquoted (`"a""b"`, `` `x` ``, `[x]`, `'x'` or bare), and the text after it.
fn identifier(s: &str) -> (String, &str) {
    let close = match s.chars().next() {
        Some(q @ ('"' | '`' | '\'')) => q,
        Some('[') => ']',
        _ => {
            let end = s.find(|c: char| c.is_whitespace() || c == '(').unwrap_or(s.len());
            return (s[..end].to_string(), &s[end..]);
        }
    };
    let mut out = String::new();
    let mut chars = s.char_indices().skip(1).peekable();
    while let Some((i, c)) = chars.next() {
        if c == close {
            // A doubled quote is a quote inside the name.
            if close != ']' && chars.next_if(|&(_, n)| n == close).is_some() {
                out.push(c);
                continue;
            }
            return (out, &s[i + 1..]);
        }
        out.push(c);
    }
    (out, "")
}

/// A database the Amazon Games app could have written, and the itch app's database with its write-ahead log, both
/// made up by tests/stores/make.mjs. Read at build time, as the test exe runs on a PC without the repository.
#[cfg(test)]
pub mod fixtures {
    pub const AMAZON: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/stores/amazon.sqlite"));
    pub const BUTLER: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/stores/butler.db"));
    pub const BUTLER_WAL: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/stores/butler.db-wal"));
}

#[cfg(test)]
mod tests {
    use super::fixtures::{AMAZON, BUTLER, BUTLER_WAL};
    use super::*;

    #[test]
    fn reads_a_table() {
        let db = Db::from_bytes(AMAZON.to_vec(), Vec::new()).unwrap();
        let rows = db.rows("dbset").unwrap();
        let ids: Vec<&str> = rows.iter().filter_map(|r| r.text("Id")).collect();
        assert_eq!(
            ids,
            ["amzn1.adg.product.0001", "amzn1.adg.product.0002", "amzn1.adg.product.0003", "amzn1.adg.product.0004"]
        );
        // Columns by name in any case, text in UTF-8.
        assert_eq!(rows[0].text("ProductTitle"), Some("Fennel™"));
        assert_eq!(rows[0].int("installed"), Some(1));
        assert_eq!(rows[2].int("Installed"), Some(0));
        assert_eq!(rows[0].get("Missing"), &Value::Null);
        assert!(db.rows("Nothing").is_none());
    }

    #[test]
    fn reads_the_log_on_top_of_the_file() {
        // The file alone: only what was checkpointed.
        let file_only = Db::from_bytes(BUTLER.to_vec(), Vec::new()).unwrap();
        let caves = file_only.rows("caves").unwrap();
        assert_eq!(caves.len(), 1);
        // With the log: the caves committed since. The rows of a transaction still under way stay out.
        let db = Db::from_bytes(BUTLER.to_vec(), BUTLER_WAL.to_vec()).unwrap();
        let caves = db.rows("caves").unwrap();
        let ids: Vec<&str> = caves.iter().filter_map(|r| r.text("id")).collect();
        assert_eq!(ids, ["cave-fennel", "cave-tool", "cave-web", "cave-custom", "cave-fennel-beta", "cave-share"]);
        // Enough games to need interior pages, and a verdict long enough to continue on overflow pages.
        let games = db.rows("games").unwrap();
        assert_eq!(games.len(), 205);
        assert!(games.iter().all(|g| g.text("title").is_some()));
        let verdict = caves[0].text("verdict").unwrap();
        assert!(verdict.len() > 3000 && verdict.ends_with('}'), "{}", verdict.len());
    }

    #[test]
    fn an_integer_primary_key_is_the_rowid() {
        let db = Db::from_bytes(BUTLER.to_vec(), BUTLER_WAL.to_vec()).unwrap();
        let games = db.rows("games").unwrap();
        assert_eq!(games[0].int("id"), Some(1001));
        assert_eq!(games[0].text("title"), Some("Fennel"));
    }

    #[test]
    fn a_damaged_log_counts_up_to_the_damage() {
        let mut wal = BUTLER_WAL.to_vec();
        // Break the checksum chain in the first frame: nothing from the log counts.
        wal[32 + 24 + 100] ^= 0xFF;
        let db = Db::from_bytes(BUTLER.to_vec(), wal).unwrap();
        assert_eq!(db.rows("caves").unwrap().len(), 1);
        assert!(Db::from_bytes(b"not a database".to_vec(), Vec::new()).is_none());
        assert!(Db::from_bytes(Vec::new(), Vec::new()).is_none());
    }

    #[test]
    fn column_lists() {
        let (names, rowid) = columns(
            r#"CREATE TABLE "caves" ("id" TEXT NOT NULL, "game_id" INTEGER, "verdict" TEXT, PRIMARY KEY ("id"))"#,
        )
        .unwrap();
        assert_eq!((names, rowid), (vec!["id".into(), "game_id".into(), "verdict".into()], None));
        let (names, rowid) =
            columns(r#"CREATE TABLE "games" ("id" INTEGER NOT NULL, "title" TEXT, PRIMARY KEY ("id"))"#).unwrap();
        assert_eq!((names, rowid), (vec!["id".into(), "title".into()], Some(0)));
        let sql = "CREATE TABLE t ([a b] VARCHAR(10, 2), `c` INTEGER PRIMARY KEY AUTOINCREMENT, \"d\"\"e\" TEXT \
            DEFAULT 'x,y)', CONSTRAINT pk CHECK (c > 0))";
        let (names, rowid) = columns(sql).unwrap();
        assert_eq!((names, rowid), (vec!["a b".into(), "c".into(), "d\"e".into()], Some(1)));
        assert_eq!(columns("CREATE TABLE t (a INTEGER PRIMARY KEY DESC, b)").unwrap().1, None);
        assert_eq!(columns("CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))").unwrap().1, None);
        assert!(columns("CREATE TABLE t (a TEXT PRIMARY KEY, b) WITHOUT ROWID").is_none());
    }

    /// SQLite's varint, for values below 2^56.
    fn put_varint(mut n: u64) -> Vec<u8> {
        let mut out = vec![(n & 0x7f) as u8];
        n >>= 7;
        while n > 0 {
            out.push((n & 0x7f) as u8 | 0x80);
            n >>= 7;
        }
        out.reverse();
        out
    }

    /// A database of three 512-byte pages: page 1 holds the header and the schema of table t, whose one leaf is page
    /// 2; page 2 holds one row `len` bytes long, which continues on page 3; page 3 points on to page `next`.
    fn crafted(len: usize, next: u32) -> Vec<u8> {
        const SIZE: usize = 512;
        let mut file = vec![0u8; SIZE * 3];
        file[..16].copy_from_slice(MAGIC);
        file[16..18].copy_from_slice(&(SIZE as u16).to_be_bytes());
        file[56..60].copy_from_slice(&1u32.to_be_bytes());
        // A leaf page whose header starts at `start`, with one cell at the page's end.
        let leaf = |page: &mut [u8], start: usize, cell: &[u8]| {
            let at = SIZE - cell.len();
            page[start] = 0x0D;
            page[start + 3..start + 5].copy_from_slice(&1u16.to_be_bytes());
            page[start + 5..start + 7].copy_from_slice(&(at as u16).to_be_bytes());
            page[start + 8..start + 10].copy_from_slice(&(at as u16).to_be_bytes());
            page[at..].copy_from_slice(cell);
        };
        // The schema's row: ("table", "t", "t", 2, "CREATE TABLE t (a)").
        let sql = b"CREATE TABLE t (a)";
        let mut record = vec![6, 13 + 2 * 5, 15, 15, 1, 13 + 2 * sql.len() as u8];
        record.extend_from_slice(b"tablett\x02");
        record.extend_from_slice(sql);
        let mut cell = vec![record.len() as u8, 1];
        cell.extend(record);
        leaf(&mut file[..SIZE], 100, &cell);
        // The row: its length, rowid 1, the 39 bytes a 512-byte page keeps of a payload this long, then page 3.
        let mut cell = put_varint(len as u64);
        cell.push(1);
        cell.extend([0u8; 39]);
        cell.extend(3u32.to_be_bytes());
        leaf(&mut file[SIZE..2 * SIZE], 0, &cell);
        file[2 * SIZE..2 * SIZE + 4].copy_from_slice(&next.to_be_bytes());
        file
    }

    #[test]
    fn a_damaged_overflow_chain_reads_as_nothing() {
        let rows = |file: Vec<u8>| Db::from_bytes(file, Vec::new()).unwrap().rows("t").map(|r| r.len());
        // Sound: a row that continues on one overflow page.
        assert_eq!(rows(crafted(489, 0)), Some(1));
        // A chain that comes back to its own page.
        assert_eq!(rows(crafted(997, 3)), None);
        // A length far past the database, on that same loop.
        assert_eq!(rows(crafted(39 + 508 * 100_000 + 450, 3)), None);
    }

    #[test]
    fn varints() {
        assert_eq!(varint(&[0x05]), Some((5, 1)));
        assert_eq!(varint(&[0x81, 0x00]), Some((128, 2)));
        assert_eq!(varint(&[0xFF; 9]), Some((u64::MAX, 9)));
        assert_eq!(varint(&[0x81]), None);
    }
}
