// ---------------------------------------------------------------------------
// Allocation-free case-insensitive helpers
// ---------------------------------------------------------------------------

/// Case-insensitive ordering of two `&str`, equivalent to
/// `a.to_lowercase().cmp(&b.to_lowercase())` but WITHOUT allocating a lowercased
/// copy of each operand. Called millions of times while building a column index
/// / sorting, so avoiding the per-comparison `String` allocation is a large win.
pub(crate) fn cmp_str_ci(a: &str, b: &str) -> std::cmp::Ordering {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let n = ab.len().min(bb.len());
    // ASCII fast path, mirroring `str_contains_ci`. For ASCII, Unicode lowercasing IS ASCII
    // lowercasing, so folded bytes compare exactly like the folded char streams below. This
    // path is the one that matters: the Unicode fold costs a UTF-8 decode plus a table lookup
    // per char, and a 1M-row sort runs ~20M comparisons through here — measured at ~3–7s for a
    // text column against ~70ms for a numeric one of identical cardinality.
    for i in 0..n {
        let (x, y) = (ab[i], bb[i]);
        if !x.is_ascii() || !y.is_ascii() {
            return cmp_str_ci_unicode(a, b);
        }
        let (lx, ly) = (x.to_ascii_lowercase(), y.to_ascii_lowercase());
        if lx != ly {
            return lx.cmp(&ly);
        }
    }
    // The shared prefix folded equal and one side ended there. No char folds to nothing, so
    // the shorter string is a strict prefix of the longer — byte length decides.
    ab.len().cmp(&bb.len())
}

/// Exact Unicode-folding comparison, for the rare cell that is not pure ASCII.
fn cmp_str_ci_unicode(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    // char::to_lowercase yields the same char sequence as String::to_lowercase,
    // and UTF-8 byte order matches Unicode scalar order, so comparing the folded
    // char streams is identical to comparing the folded strings.
    let mut ai = a.chars().flat_map(char::to_lowercase);
    let mut bi = b.chars().flat_map(char::to_lowercase);
    loop {
        match (ai.next(), bi.next()) {
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => {}
                ord => return ord,
            },
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
}

/// Case-insensitive substring test. `needle` is assumed already lowercased
/// (FilterExpr lowercases every term at parse time). For the overwhelmingly
/// common all-ASCII haystack this is allocation-free; only genuinely non-ASCII
/// cells fall back to the allocating `to_lowercase()` path, preserving the exact
/// Unicode-folding behaviour of the original code.
pub(crate) fn str_contains_ci(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.is_ascii() {
        // For ASCII text, Unicode lowercasing == ASCII lowercasing, so a byte-wise
        // ASCII-insensitive scan is exactly equivalent and needs no allocation.
        let h = haystack.as_bytes();
        let n = needle.as_bytes();
        if n.len() > h.len() {
            return false;
        }
        h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
    } else {
        haystack.to_lowercase().contains(needle)
    }
}

#[cfg(test)]
mod cmp_str_ci_tests {
    use super::{cmp_str_ci, cmp_str_ci_unicode};

    /// The ASCII fast path must be indistinguishable from the exact Unicode fold.
    #[test]
    fn fast_path_matches_unicode_path() {
        let samples = [
            "", "a", "A", "ab", "aB", "Ab", "abc", "abd", "b", "B",
            "User_1", "User_10", "user_2", "USER_2", "IDX-2026-00000001",
            "usr_uuid_abc_1", "usr_uuid_abc_2", "Tax Strategy", "tax strategy",
            "Accounting", "accounting ", " accounting",
            "café", "CAFÉ", "cafe", "Café", "é", "E", "e",
            "Straße", "STRASSE", "strasse", "İstanbul", "istanbul", "I", "i",
            "日本語", "にほんご", "ﬁ", "FI", "fi",
        ];
        for a in samples {
            for b in samples {
                assert_eq!(
                    cmp_str_ci(a, b),
                    cmp_str_ci_unicode(a, b),
                    "mismatch for {a:?} vs {b:?}"
                );
            }
        }
    }
}
