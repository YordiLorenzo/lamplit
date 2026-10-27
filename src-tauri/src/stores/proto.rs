// Just enough protobuf for Battle.net's product.db: a message's fields, read without a schema
// (https://protobuf.dev/programming-guides/encoding/).

pub enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    /// A fixed 32- or 64-bit value, which product.db has but Lamplit doesn't read.
    Fixed,
}

/// The fields of a message, by field number. Stops at the first one that doesn't parse.
pub fn fields(mut msg: &[u8]) -> impl Iterator<Item = (u64, Field<'_>)> {
    std::iter::from_fn(move || {
        let (key, rest) = varint(msg)?;
        let (field, rest) = match key & 7 {
            0 => varint(rest).map(|(v, rest)| (Field::Varint(v), rest))?,
            1 => (Field::Fixed, rest.get(8..)?),
            2 => {
                let (len, rest) = varint(rest)?;
                let len = usize::try_from(len).ok()?;
                (Field::Bytes(rest.get(..len)?), rest.get(len..)?)
            }
            5 => (Field::Fixed, rest.get(4..)?),
            _ => return None,
        };
        msg = rest;
        Some((key >> 3, field))
    })
}

/// The message or string in field `n` (the last one, as protobuf reads a field given twice).
pub fn bytes(msg: &[u8], n: u64) -> Option<&[u8]> {
    fields(msg)
        .filter(|(f, _)| *f == n)
        .filter_map(|(_, v)| if let Field::Bytes(b) = v { Some(b) } else { None })
        .last()
}

pub fn string(msg: &[u8], n: u64) -> Option<String> {
    bytes(msg, n).map(|b| String::from_utf8_lossy(b).into_owned())
}

pub fn varint_field(msg: &[u8], n: u64) -> Option<u64> {
    fields(msg)
        .filter(|(f, _)| *f == n)
        .filter_map(|(_, v)| if let Field::Varint(v) = v { Some(v) } else { None })
        .last()
}

/// Little-endian base-128: 7 bits a byte, low bits first.
fn varint(b: &[u8]) -> Option<(u64, &[u8])> {
    let mut v = 0u64;
    for (i, &c) in b.iter().enumerate().take(10) {
        v |= u64::from(c & 0x7f) << (7 * i);
        if c < 0x80 {
            return Some((v, &b[i + 1..]));
        }
    }
    None
}

/// Builds messages for tests: `msg(&[(1, s("agent")), (4, msg(&[(1, v(1))]))])`.
#[cfg(test)]
pub mod build {
    pub enum Part {
        Varint(u64),
        Bytes(Vec<u8>),
    }

    pub fn s(text: &str) -> Part {
        Part::Bytes(text.as_bytes().to_vec())
    }

    pub fn v(n: u64) -> Part {
        Part::Varint(n)
    }

    pub fn msg(fields: &[(u64, Part)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (n, part) in fields {
            match part {
                Part::Varint(value) => {
                    varint(&mut out, n << 3);
                    varint(&mut out, *value);
                }
                Part::Bytes(b) => {
                    varint(&mut out, (n << 3) | 2);
                    varint(&mut out, b.len() as u64);
                    out.extend_from_slice(b);
                }
            }
        }
        out
    }

    pub fn m(fields: &[(u64, Part)]) -> Part {
        Part::Bytes(msg(fields))
    }

    fn varint(out: &mut Vec<u8>, mut n: u64) {
        while n >= 0x80 {
            out.push((n as u8) | 0x80);
            n >>= 7;
        }
        out.push(n as u8);
    }
}

#[cfg(test)]
mod tests {
    use super::build::{m, msg, s, v};
    use super::*;

    #[test]
    fn reads_fields() {
        let data =
            msg(&[(1, s("agent")), (3, m(&[(1, s("C:/ProgramData/Battle.net/Agent"))])), (21, v(1_792_590_221_000))]);
        assert_eq!(string(&data, 1).as_deref(), Some("agent"));
        assert_eq!(string(bytes(&data, 3).unwrap(), 1).as_deref(), Some("C:/ProgramData/Battle.net/Agent"));
        assert_eq!(varint_field(&data, 21), Some(1_792_590_221_000));
        assert_eq!(string(&data, 2), None);
        // A fixed 64-bit field between the others, as product.db has, is stepped over.
        let mut fixed = vec![0x09];
        fixed.extend_from_slice(&[0; 8]);
        fixed.extend(msg(&[(2, s("bna"))]));
        assert_eq!(string(&fixed, 2).as_deref(), Some("bna"));
        // A length past the end stops the reading there.
        assert_eq!(fields(&[0x0A, 0x05, b'a']).count(), 0);
    }
}
