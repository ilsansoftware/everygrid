use js_sys::Uint8Array;
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Allocation-free case-insensitive helpers
// ---------------------------------------------------------------------------

/// Case-insensitive ordering of two `&str`, equivalent to
/// `a.to_lowercase().cmp(&b.to_lowercase())` but WITHOUT allocating a lowercased
/// copy of each operand. Called millions of times while building a column index
/// / sorting, so avoiding the per-comparison `String` allocation is a large win.
fn cmp_str_ci(a: &str, b: &str) -> std::cmp::Ordering {
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
fn str_contains_ci(haystack: &str, needle: &str) -> bool {
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

// ---------------------------------------------------------------------------
// FieldVal — lightweight typed cell value (avoids serde_json::Value overhead)
// ---------------------------------------------------------------------------
#[derive(Clone)]
enum FieldVal {
    /// `Rc<str>` so repeated cell values share one allocation (see `Interner::value`) and
    /// `cmp` can settle equal ones by pointer instead of by bytes.
    Str(Rc<str>),
    Num(f64),
    Bool(bool),
    /// Nested object/array, held as its compact JSON text so it survives the
    /// round-trip verbatim. `Rc` keeps row clones cheap.
    Json(Rc<str>),
    Null,
}

impl FieldVal {
    fn from_value(v: &Value, interner: &mut Interner) -> Self {
        match v {
            Value::String(s) => FieldVal::Str(interner.value(s)),
            Value::Number(n) => FieldVal::Num(n.as_f64().unwrap_or(0.0)),
            Value::Bool(b) => FieldVal::Bool(*b),
            Value::Null => FieldVal::Null,
            // Object/Array: preserve the source JSON instead of flattening it away.
            nested => FieldVal::Json(Rc::from(
                serde_json::to_string(nested)
                    .unwrap_or_else(|_| "null".to_string())
                    .as_str(),
            )),
        }
    }

    fn contains_term(&self, term: &str) -> bool {
        match self {
            FieldVal::Str(s) => str_contains_ci(s, term),
            FieldVal::Json(t) => str_contains_ci(t, term),
            FieldVal::Num(n) => {
                let s = if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                };
                s.contains(term)
            }
            FieldVal::Bool(b) => b.to_string().contains(term),
            FieldVal::Null => false,
        }
    }

    /// Numeric view of a cell for comparison filters. Numbers pass through; numeric strings
    /// (e.g. a salary stored as "550000") are parsed; everything else is not comparable.
    fn as_f64(&self) -> Option<f64> {
        match self {
            FieldVal::Num(n) => Some(*n),
            FieldVal::Str(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    /// Lowercased string view for equality / ordered (e.g. date) comparisons against a text
    /// operand. Only string cells qualify — dates are stored as ISO strings, which compare
    /// correctly lexicographically.
    fn as_cmp_string(&self) -> Option<String> {
        match self {
            FieldVal::Str(s) => Some(s.to_lowercase()),
            // Enables operator compares on booleans: `active(==true)`, `active(!=false)`.
            FieldVal::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    /// String form for regex matching (`~pattern`); nested JSON matches against its raw text.
    fn regex_str(&self) -> String {
        match self {
            FieldVal::Str(s) => s.to_string(),
            FieldVal::Num(n) => num_to_str(*n),
            FieldVal::Bool(b) => b.to_string(),
            FieldVal::Json(t) => t.to_string(),
            FieldVal::Null => String::new(),
        }
    }

    /// Evaluate a comparison against this cell. Scalars compare directly; a nested object/array
    /// (Json) matches if ANY leaf value satisfies the comparison (so `role(=frontend)` hits a
    /// nested `subRole: "Frontend"`). NOTE: nested cells are re-parsed per row here.
    fn cmp_matches(&self, op: CmpOp, val: &CmpVal) -> bool {
        match self {
            FieldVal::Json(t) => serde_json::from_str::<Value>(t)
                .ok()
                .is_some_and(|v| json_leaf_cmp(&v, op, val)),
            _ => match val {
                CmpVal::Num(n) => {
                    if let Some(x) = self.as_f64() {
                        // Numeric field (incl. numeric strings) vs numeric operand → numeric.
                        x.partial_cmp(n).is_some_and(|o| op.test_ord(o))
                    } else {
                        // Non-numeric string vs a numeric operand only means anything for a date
                        // field (year search, e.g. `joined(>2024)`). Plain text never matches a
                        // numeric compare.
                        self.as_cmp_string()
                            .is_some_and(|fs| is_date_like(&fs) && range_cmp(&fs, &num_to_str(*n), op))
                    }
                }
                // A date-like operand only compares meaningfully against a date-like field.
                CmpVal::Str(s) if is_date_like(s) => self
                    .as_cmp_string()
                    .is_some_and(|fs| is_date_like(&fs) && date_cmp(&fs, s, op)),
                CmpVal::Str(s) => self.as_cmp_string().is_some_and(|fs| text_cmp(&fs, s, op)),
            },
        }
    }

    fn cmp_key(&self) -> (u8, f64, &str) {
        match self {
            FieldVal::Num(n) => (0, *n, ""),
            FieldVal::Str(s) => (1, 0.0, s.as_ref()),
            FieldVal::Bool(b) => (2, if *b { 1.0 } else { 0.0 }, ""),
            FieldVal::Json(t) => (3, 0.0, t.as_ref()),
            FieldVal::Null => (4, 0.0, ""),
        }
    }
}

impl PartialOrd for FieldVal {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FieldVal {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Interned values that are the same allocation are equal without reading a byte. This
        // is what rescues a column repeating one long value on every row: those comparisons
        // otherwise run the full text every time, and a 1M-row sort makes ~20M of them.
        if let (FieldVal::Str(a), FieldVal::Str(b)) = (self, other) {
            if Rc::ptr_eq(a, b) {
                return std::cmp::Ordering::Equal;
            }
        }
        let (ta, na, sa) = self.cmp_key();
        let (tb, nb, sb) = other.cmp_key();
        if ta != tb {
            return ta.cmp(&tb);
        }
        if ta == 0 {
            return na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal);
        }
        // Tag 1 = Str, tag 3 = Json — both order by their text.
        if ta == 1 || ta == 3 {
            return cmp_str_ci(sa, sb);
        }
        na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl PartialEq for FieldVal {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}

impl Eq for FieldVal {}

// Direct JSON serialization — avoids materialising an intermediate serde_json::Value
// per cell. serde_json guarantees correct string escaping and number formatting, so
// output is byte-identical to the previous `to_json_value()` + `to_string()` path.
impl Serialize for FieldVal {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            FieldVal::Str(v) => s.serialize_str(v),
            // Whole numbers within i64-exact range render without a decimal point,
            // matching the old to_json_value() behaviour; others fall through to f64
            // (serde_json emits `null` for NaN/Infinity, matching the old None → Null).
            FieldVal::Num(n) if n.fract() == 0.0 && n.abs() < 1e15 => s.serialize_i64(*n as i64),
            FieldVal::Num(n) => s.serialize_f64(*n),
            FieldVal::Bool(b) => s.serialize_bool(*b),
            // Re-emit as real structure, not as a JSON-encoded string, so the grid
            // receives the original object/array back.
            FieldVal::Json(t) => {
                let v: Value = serde_json::from_str(t)
                    .map_err(<S::Error as serde::ser::Error>::custom)?;
                v.serialize(s)
            }
            FieldVal::Null => s.serialize_none(),
        }
    }
}

// ---------------------------------------------------------------------------
// RowData — compact row representation
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct RowData {
    /// Column names and values in insertion order.
    /// Column-name keys are interned as `Rc<str>` so the (heavily repeated) name
    /// text is stored once and shared across every row instead of being cloned
    /// per row — a major memory saving on multi-million-row datasets.
    fields: Vec<(Rc<str>, FieldVal)>,
}

impl RowData {
    /// Builds a row, interning each column name through `interner` so identical
    /// names across rows share a single allocation. Returns None for non-objects.
    fn from_value(v: &Value, interner: &mut Interner) -> Option<Self> {
        if let Value::Object(map) = v {
            let fields = map
                .iter()
                .map(|(k, v)| (interner.key(k), FieldVal::from_value(v, interner)))
                .collect();
            Some(RowData { fields })
        } else {
            None
        }
    }

    fn get(&self, col: &str) -> Option<&FieldVal> {
        self.fields
            .iter()
            .find(|(k, _)| k.as_ref() == col)
            .map(|(_, v)| v)
    }

    /// Case-insensitive column lookup (used by the filter so `role` matches a `Role` column).
    fn get_ci(&self, col: &str) -> Option<&FieldVal> {
        self.fields
            .iter()
            .find(|(k, _)| k.as_ref().eq_ignore_ascii_case(col))
            .map(|(_, v)| v)
    }

    /// Position of `col` within this row's fields, if present.
    fn col_pos(&self, col: &str) -> Option<usize> {
        self.fields.iter().position(|(k, _)| k.as_ref() == col)
    }

    /// O(1) column access when `hint` is the column's position (uniform schema —
    /// the common case, since all rows come from the same JSON source). Falls back
    /// to a linear scan when the row's layout differs from the hint.
    fn get_at(&self, col: &str, hint: usize) -> Option<&FieldVal> {
        if let Some((k, v)) = self.fields.get(hint) {
            if k.as_ref() == col {
                return Some(v);
            }
        }
        self.get(col)
    }

    fn contains_term(&self, term: &str) -> bool {
        self.fields.iter().any(|(_, v)| v.contains_term(term))
    }
}

// Serializes a row as a JSON object, streaming keys/values straight to the output
// with no intermediate serde_json::Map/Value allocation.
impl Serialize for RowData {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.fields.len()))?;
        for (k, v) in &self.fields {
            map.serialize_entry(k.as_ref(), v)?;
        }
        map.end()
    }
}

// ---------------------------------------------------------------------------
// Row ingestion
// ---------------------------------------------------------------------------

/// Deserializes a JSON document straight into `rows`, one element at a time.
///
/// Deliberately avoids `Deserializer::into_iter::<Value>()`: for a top-level array that
/// builds the WHOLE document as a Value tree before a single row exists. The tree is
/// several times the size of the JSON text, and on wasm32 the resulting allocator
/// pressure is superlinear — 200k rows (76MB) took ~30s that way versus ~1.3s when the
/// same rows arrive in chunks. Streaming each element keeps peak memory at one row and
/// makes ingest cost linear regardless of how the caller batches it.
struct RowSink<'a> {
    rows: &'a mut Vec<RowData>,
    interner: &'a mut Interner,
}

impl<'a> RowSink<'a> {
    fn push(&mut self, value: &Value) {
        if let Some(row) = RowData::from_value(value, self.interner) {
            self.rows.push(row);
        }
    }
}

impl<'de, 'a> Visitor<'de> for RowSink<'a> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON array of row objects, or a single row object")
    }

    // Scalars at the top level carry no rows; ignore them rather than fail, matching the
    // previous `Ok(_) => {}` arm. (Ordered to match the Visitor trait's member order.)
    fn visit_bool<E>(self, _v: bool) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_i64<E>(self, _v: i64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_u64<E>(self, _v: u64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_f64<E>(self, _v: f64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_str<E>(self, _v: &str) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<Self::Value, A::Error> {
        // Each element is dropped before the next is parsed, so the tree never outgrows one row.
        while let Some(value) = seq.next_element::<Value>()? {
            self.push(&value);
        }
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(mut self, map: A) -> Result<Self::Value, A::Error> {
        let value = Value::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
        self.push(&value);
        Ok(())
    }
}

impl<'de, 'a> DeserializeSeed<'de> for RowSink<'a> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_any(self)
    }
}

/// Cap on distinct interned cell values. A column carrying a unique value per row (a uuid, an
/// id) would otherwise make the table retain a copy of all of them forever — strictly worse
/// than not interning at all. Once full, values already in the table keep deduplicating, which
/// is exactly what the low-cardinality columns interning exists for need.
const VALUE_INTERN_CAP: usize = 1 << 16;

/// Shared string tables for one ingest: column names, and the cell values worth sharing.
#[derive(Default)]
struct Interner {
    /// Column names — a small, bounded set repeated on every row.
    keys: HashMap<Box<str>, Rc<str>>,
    /// Cell values. `HashSet<Rc<str>>` rather than a `HashMap<Box<str>, _>` because
    /// `Rc<str>: Borrow<str>` allows lookup by `&str` without storing the text twice.
    values: HashSet<Rc<str>>,
}

impl Interner {
    /// Returns the shared `Rc<str>` for a column name, inserting it on first sight.
    fn key(&mut self, key: &str) -> Rc<str> {
        if let Some(rc) = self.keys.get(key) {
            return rc.clone();
        }
        let rc: Rc<str> = Rc::from(key);
        self.keys.insert(Box::from(key), rc.clone());
        rc
    }

    /// Returns a shared `Rc<str>` for a cell value. Repeated values collapse onto one
    /// allocation, which both shrinks the heap and lets `FieldVal::cmp` settle them by pointer.
    fn value(&mut self, s: &str) -> Rc<str> {
        if let Some(rc) = self.values.get(s) {
            return rc.clone();
        }
        let rc: Rc<str> = Rc::from(s);
        if self.values.len() < VALUE_INTERN_CAP {
            self.values.insert(rc.clone());
        }
        rc
    }

    fn clear(&mut self) {
        self.keys.clear();
        self.values.clear();
    }
}

// ---------------------------------------------------------------------------
// FilterExpr — global text search plus per-column groups, combined with '&&'/'||'.
//   - bare term        → substring match across all columns (case-insensitive)
//   - `col(subexpr)`   → subexpr applied to one column only (single level, no nesting)
// A column subexpr (ColExpr) supports substring terms and numeric comparisons
// (`<40`, `>=30`, or value-first `30<=`), also combined with '&&'/'||'.
// ---------------------------------------------------------------------------

/// Split `input` on `sep`, but only at parenthesis depth 0, so '&&'/'||' inside a `col(...)`
/// group are not treated as top-level separators. `sep`, '(' and ')' are all ASCII, so byte
/// scanning never lands mid-UTF-8-char.
/// Split an expression on AND boundaries at paren depth 0: both `&&` and a `.` that immediately
/// follows a `)` (the sibling-key chain, e.g. `subRole(front).years(=1)`). A `.` inside a value or
/// parens (e.g. `email(a.b)`, `salary(>3.14)`) is NOT a boundary.
fn split_and(input: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => { depth += 1; i += 1; }
            b')' => { if depth > 0 { depth -= 1; } i += 1; }
            _ if depth == 0 && bytes[i..].starts_with(b"&&") => {
                parts.push(input[start..i].to_string());
                i += 2;
                start = i;
            }
            b'.' if depth == 0 && i > 0 && bytes[i - 1] == b')' => {
                parts.push(input[start..i].to_string());
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    parts.push(input[start..].to_string());
    parts
}

/// Split on `.` directly following a `)` at depth 0 — the CORRELATED and: `subRole(front).years(3)`
/// must hold for one and the same array element, where `&&` lets each side match a different one.
fn split_dot(input: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => { depth += 1; i += 1; }
            b')' => { if depth > 0 { depth -= 1; } i += 1; }
            b'.' if depth == 0 && i > 0 && bytes[i - 1] == b')' => {
                parts.push(input[start..i].to_string());
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    parts.push(input[start..].to_string());
    parts
}

fn split_top_level(input: &str, sep: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let sep_bytes = sep.as_bytes();
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => { depth += 1; i += 1; }
            b')' => { if depth > 0 { depth -= 1; } i += 1; }
            _ if depth == 0 && bytes[i..].starts_with(sep_bytes) => {
                parts.push(input[start..i].to_string());
                i += sep_bytes.len();
                start = i;
            }
            _ => i += 1,
        }
    }
    parts.push(input[start..].to_string());
    parts
}

#[derive(Clone, Copy)]
enum CmpOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

impl CmpOp {
    fn test_ord(self, ord: std::cmp::Ordering) -> bool {
        use std::cmp::Ordering::{Equal, Greater, Less};
        match self {
            CmpOp::Lt => ord == Less,
            CmpOp::Le => ord != Greater,
            CmpOp::Gt => ord == Greater,
            CmpOp::Ge => ord != Less,
            CmpOp::Eq => ord == Equal,
            CmpOp::Ne => ord != Equal,
        }
    }
}

/// A comparison operand: a number (numeric compare) or a lowercased string (dates/text compare).
#[derive(Clone)]
enum CmpVal {
    Num(f64),
    Str(String),
}

/// Format a numeric operand as its plain string (integers without a decimal point).
fn num_to_str(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Exact/ordered comparison for plain text operands: `=` is exact, the rest are lexicographic.
fn text_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
    match op {
        CmpOp::Eq => field == operand,
        _ => op.test_ord(field.cmp(operand)),
    }
}

/// Prefix-range comparison: the operand is a prefix defining a period `[operand, operand+ε)`
/// (e.g. `2024` = the whole year, `2026-01-05` = that whole day). `=` matches the period;
/// `>`/`<=` are relative to its END, `>=`/`<` to its START. This makes `>2026-01-05` exclude
/// Jan 5 while `>=2026-01-05` includes it.
fn range_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
    match op {
        CmpOp::Eq => field.starts_with(operand),
        CmpOp::Ge => field >= operand,
        CmpOp::Lt => field < operand,
        CmpOp::Le => field < operand || field.starts_with(operand),
        CmpOp::Gt => field > operand && !field.starts_with(operand),
        CmpOp::Ne => !field.starts_with(operand),
    }
}

/// True if the operand looks like a date/datetime (`YYYY-...`), so it should use prefix-range
/// comparison with separator normalization rather than plain text comparison.
fn is_date_like(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 5
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4] == b'-'
}

/// Normalize the date/time separator so `T` and a space are interchangeable. Inputs are already
/// lowercased, and the only `t` in an ISO datetime is that separator.
fn norm_sep(s: &str) -> String {
    if s.contains('t') { s.replace('t', " ") } else { s.to_string() }
}

/// Date comparison: normalize `T`/space separators, then apply prefix-range semantics.
fn date_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
    range_cmp(&norm_sep(field), &norm_sep(operand), op)
}

/// True if any leaf value inside a nested JSON value satisfies the comparison.
fn json_leaf_cmp(v: &Value, op: CmpOp, val: &CmpVal) -> bool {
    match v {
        Value::Array(a) => a.iter().any(|x| json_leaf_cmp(x, op, val)),
        Value::Object(m) => m.values().any(|x| json_leaf_cmp(x, op, val)),
        Value::Number(n) => matches!(val, CmpVal::Num(t)
            if n.as_f64().is_some_and(|x| x.partial_cmp(t).is_some_and(|o| op.test_ord(o)))),
        Value::String(s) => {
            let leaf = s.to_lowercase();
            match val {
                // A numeric/date operand matches a string leaf only when that leaf is itself a
                // date (year search inside a nested object); never a plain text leaf.
                CmpVal::Str(t) if is_date_like(t) => is_date_like(&leaf) && date_cmp(&leaf, t, op),
                CmpVal::Str(t) => text_cmp(&leaf, t, op),
                CmpVal::Num(n) => is_date_like(&leaf) && range_cmp(&leaf, &num_to_str(*n), op),
            }
        }
        Value::Bool(b) => matches!(val, CmpVal::Str(t) if text_cmp(&b.to_string(), t, op)),
        _ => false,
    }
}

/// True if any string/number/bool leaf inside a nested JSON value matches the regex.
fn json_leaf_regex(v: &Value, re: &regex_lite::Regex) -> bool {
    match v {
        Value::Array(a) => a.iter().any(|x| json_leaf_regex(x, re)),
        Value::Object(m) => m.values().any(|x| json_leaf_regex(x, re)),
        Value::String(s) => re.is_match(s),
        Value::Number(n) => re.is_match(&n.to_string()),
        Value::Bool(b) => re.is_match(&b.to_string()),
        Value::Null => false,
    }
}

/// True if any leaf value inside a nested JSON value contains `term` (already lowercased).
fn json_leaf_contains(v: &Value, term: &str) -> bool {
    match v {
        Value::Array(a) => a.iter().any(|x| json_leaf_contains(x, term)),
        Value::Object(m) => m.values().any(|x| json_leaf_contains(x, term)),
        Value::String(s) => str_contains_ci(s, term),
        Value::Number(n) => n.to_string().contains(term),
        Value::Bool(b) => b.to_string().contains(term),
        Value::Null => false,
    }
}

/// Case-insensitive object key lookup (so `engineering` matches a key stored as `Engineering`).
fn ci_get<'a>(m: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a Value> {
    m.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v)
}

/// Scope into field `name` (case-insensitive) of a JSON value, then evaluate `inner` against the
/// child. When the child is an ARRAY the two conjunctions differ: `.` is correlated (one element
/// must satisfy both sides) while `&&` is not (each side may find its own element). So
/// `engineering(subRole(front).years(3) && subRole(back))` means "one element that is front with
/// 3 years, AND some element that is back" — see `matches_array`.
fn eval_field_value(name: &str, inner: &ColExpr, v: &Value) -> bool {
    match v {
        Value::Object(m) => match ci_get(m, name) {
            Some(Value::Array(a)) => inner.matches_array(a),
            Some(child) => inner.matches_value(child),
            None => false,
        },
        // Field applied to an array (e.g. an array-of-objects) → any element that has the field.
        Value::Array(a) => a.iter().any(|e| eval_field_value(name, inner, e)),
        _ => false,
    }
}

#[derive(Clone)]
enum ColExpr {
    Empty,
    Contains(String),
    Cmp(CmpOp, CmpVal),
    /// Membership: `in[a,b,c]` — equals any of the listed values.
    In(Vec<CmpVal>),
    /// Regex match: `~pattern` (regex-lite; add `(?i)` for case-insensitive).
    Regex(regex_lite::Regex),
    /// Nested field scope: `name(inner)`. Recurses to any depth; arrays evaluate `inner` per element.
    Field(String, Box<ColExpr>),
    /// `a && b` — over an array, each side may be satisfied by a DIFFERENT element.
    And(Box<ColExpr>, Box<ColExpr>),
    /// `a.b` — over an array, both sides must hold for the SAME element.
    Dot(Box<ColExpr>, Box<ColExpr>),
    Or(Box<ColExpr>, Box<ColExpr>),
}

impl ColExpr {
    fn parse(input: &str) -> Self {
        let mut exprs: Vec<ColExpr> = split_top_level(input, "||")
            .iter()
            .map(|p| Self::parse_and(p))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| ColExpr::Or(Box::new(a), Box::new(b)))
            .unwrap_or(ColExpr::Empty)
    }

    fn parse_and(input: &str) -> Self {
        let mut exprs: Vec<ColExpr> = split_top_level(input, "&&")
            .iter()
            .map(|p| Self::parse_dot(p))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| ColExpr::And(Box::new(a), Box::new(b)))
            .unwrap_or(ColExpr::Empty)
    }

    /// `.` binds tighter than `&&` and keeps both sides on the same array element.
    fn parse_dot(input: &str) -> Self {
        let mut exprs: Vec<ColExpr> = split_dot(input)
            .iter()
            .map(|p| Self::parse_leaf(p))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| ColExpr::Dot(Box::new(a), Box::new(b)))
            .unwrap_or(ColExpr::Empty)
    }

    /// Operand → number if it parses as one (numeric compare), else a lowercased string
    /// (for dates like `2024-01-01` and text equality).
    fn operand(s: &str) -> CmpVal {
        let s = s.trim();
        match s.parse::<f64>() {
            Ok(n) => CmpVal::Num(n),
            Err(_) => CmpVal::Str(s.to_lowercase()),
        }
    }

    fn parse_leaf(tok: &str) -> Self {
        let t = tok.trim();
        if t.is_empty() {
            return ColExpr::Empty;
        }
        // Nested field: `name(inner)` (text followed by parens) → scope into that field.
        if t.ends_with(')') && !t.to_lowercase().starts_with("in(") {
            if let Some(open) = t.find('(') {
                if open > 0 {
                    let name = t[..open].trim().to_string();
                    let inner = &t[open + 1..t.len() - 1];
                    return ColExpr::Field(name, Box::new(ColExpr::parse(inner)));
                }
            }
        }
        // Regex: `~pattern`.
        if let Some(pat) = t.strip_prefix('~') {
            let pat = pat.trim();
            if !pat.is_empty() {
                return match regex_lite::Regex::new(pat) {
                    Ok(re) => ColExpr::Regex(re),
                    Err(_) => ColExpr::Contains(pat.to_lowercase()),
                };
            }
        }
        // Membership: `in[a,b,c]` or `in(a,b,c)`.
        let low = t.to_lowercase();
        if (low.starts_with("in[") && t.ends_with(']')) || (low.starts_with("in(") && t.ends_with(')')) {
            let inner = &t[3..t.len() - 1];
            let items: Vec<CmpVal> = inner
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(Self::operand)
                .collect();
            if !items.is_empty() {
                return ColExpr::In(items);
            }
        }
        // Operator-first: `<40` = "col < 40", `=qa` = "col == qa". Check multi-char ops first.
        for (op, cmp) in [("!=", CmpOp::Ne), ("<=", CmpOp::Le), (">=", CmpOp::Ge), ("==", CmpOp::Eq), ("<", CmpOp::Lt), (">", CmpOp::Gt), ("=", CmpOp::Eq)] {
            if let Some(rest) = t.strip_prefix(op) {
                if !rest.trim().is_empty() {
                    return ColExpr::Cmp(cmp, Self::operand(rest));
                }
            }
        }
        // Value-first: `30<=` = "30 <= col" → col >= 30 (operator reversed). `=`/`!=` are symmetric.
        for (op, cmp) in [("!=", CmpOp::Ne), ("<=", CmpOp::Ge), (">=", CmpOp::Le), ("==", CmpOp::Eq), ("<", CmpOp::Gt), (">", CmpOp::Lt), ("=", CmpOp::Eq)] {
            if let Some(pre) = t.strip_suffix(op) {
                if !pre.trim().is_empty() {
                    return ColExpr::Cmp(cmp, Self::operand(pre));
                }
            }
        }
        ColExpr::Contains(t.to_lowercase())
    }

    fn is_empty(&self) -> bool {
        matches!(self, ColExpr::Empty)
    }

    fn matches(&self, v: &FieldVal) -> bool {
        match self {
            ColExpr::Empty => true,
            ColExpr::Contains(s) => v.contains_term(s),
            ColExpr::Cmp(op, val) => v.cmp_matches(*op, val),
            ColExpr::In(items) => items.iter().any(|val| v.cmp_matches(CmpOp::Eq, val)),
            ColExpr::Regex(re) => re.is_match(&v.regex_str()),
            // Descend into a nested field: only possible when the cell holds nested JSON.
            ColExpr::Field(name, inner) => match v {
                FieldVal::Json(t) => serde_json::from_str::<Value>(t)
                    .ok()
                    .is_some_and(|root| eval_field_value(name, inner, &root)),
                _ => false,
            },
            ColExpr::And(a, b) | ColExpr::Dot(a, b) => a.matches(v) && b.matches(v),
            ColExpr::Or(a, b) => a.matches(v) || b.matches(v),
        }
    }

    /// Evaluate against an ARRAY child. `&&` and `||` distribute over the array — each operand
    /// gets the whole array and may match a different element. Everything else (including `.`)
    /// has to be satisfied by a single element, which is what makes `.` the correlated and.
    fn matches_array(&self, a: &[Value]) -> bool {
        match self {
            ColExpr::And(x, y) => x.matches_array(a) && y.matches_array(a),
            ColExpr::Or(x, y) => x.matches_array(a) || y.matches_array(a),
            _ => a.iter().any(|e| self.matches_value(e)),
        }
    }

    /// Same as `matches` but against a resolved JSON value (nested-field / dotted-path lookup).
    fn matches_value(&self, v: &Value) -> bool {
        match self {
            ColExpr::Empty => true,
            ColExpr::Contains(s) => json_leaf_contains(v, s),
            ColExpr::Cmp(op, val) => json_leaf_cmp(v, *op, val),
            ColExpr::In(items) => items.iter().any(|val| json_leaf_cmp(v, CmpOp::Eq, val)),
            ColExpr::Regex(re) => json_leaf_regex(v, re),
            ColExpr::Field(name, inner) => eval_field_value(name, inner, v),
            ColExpr::And(a, b) | ColExpr::Dot(a, b) => a.matches_value(v) && b.matches_value(v),
            ColExpr::Or(a, b) => a.matches_value(v) || b.matches_value(v),
        }
    }
}

#[derive(Clone)]
enum FilterExpr {
    Term(String),
    Col(String, Box<ColExpr>),
    And(Box<FilterExpr>, Box<FilterExpr>),
    Or(Box<FilterExpr>, Box<FilterExpr>),
}

impl FilterExpr {
    fn parse(input: &str) -> Self {
        let mut cleaned = input.trim();
        loop {
            let next = cleaned.trim();
            if let Some(s) = next.strip_prefix("&&").or_else(|| next.strip_prefix("||")) {
                cleaned = s;
            } else if let Some(s) = next.strip_suffix("&&").or_else(|| next.strip_suffix("||")) {
                cleaned = s;
            } else {
                break;
            }
        }
        Self::parse_or(cleaned.trim())
    }

    fn parse_or(input: &str) -> Self {
        let mut exprs: Vec<FilterExpr> = split_top_level(input, "||")
            .iter()
            .map(|p| Self::parse_and(p))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| FilterExpr::Or(Box::new(a), Box::new(b)))
            .unwrap_or_else(|| FilterExpr::Term(String::new()))
    }

    fn parse_and(input: &str) -> Self {
        let mut exprs: Vec<FilterExpr> = split_and(input)
            .iter()
            .map(|p| Self::parse_token(p))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| FilterExpr::And(Box::new(a), Box::new(b)))
            .unwrap_or_else(|| FilterExpr::Term(String::new()))
    }

    fn parse_token(tok: &str) -> Self {
        let t = tok.trim();
        if t.is_empty() {
            return FilterExpr::Term(String::new());
        }
        // `column(...)` — scope the inner expression to a single column.
        if t.ends_with(')') && !t.to_lowercase().starts_with("in(") {
            if let Some(open) = t.find('(') {
                if open > 0 {
                    let col = t[..open].trim().to_string();
                    let inner = &t[open + 1..t.len() - 1];
                    return FilterExpr::Col(col, Box::new(ColExpr::parse(inner)));
                }
            }
        }
        // Un-parenthesized field query: `path op value` (path may be dotted). Requires an operator
        // so plain text without one stays a free-text term. e.g. `role.subRole == front`, `age >= 30`.
        if let Some((col, expr)) = Self::parse_unparen(t) {
            return FilterExpr::Col(col, Box::new(expr));
        }
        FilterExpr::Term(t.to_lowercase())
    }

    /// Parse `path <op> value` (no parens). `path` must look like a bare field/dotted path.
    fn parse_unparen(t: &str) -> Option<(String, ColExpr)> {
        let is_path = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_');
        // Longest ops first so `<=`/`>=`/`==`/`!=` win over their single-char prefixes.
        for op_str in ["!=", "<=", ">=", "==", "~", "<", ">", "="] {
            if let Some(idx) = t.find(op_str) {
                let left = t[..idx].trim();
                let right = t[idx + op_str.len()..].trim();
                if left.is_empty() || right.is_empty() || !is_path(left) {
                    continue;
                }
                let expr = if op_str == "~" {
                    match regex_lite::Regex::new(right) {
                        Ok(re) => ColExpr::Regex(re),
                        Err(_) => ColExpr::Contains(right.to_lowercase()),
                    }
                } else {
                    let cmp = match op_str {
                        "!=" => CmpOp::Ne,
                        "<=" => CmpOp::Le,
                        ">=" => CmpOp::Ge,
                        "<" => CmpOp::Lt,
                        ">" => CmpOp::Gt,
                        _ => CmpOp::Eq, // "==" | "="
                    };
                    ColExpr::Cmp(cmp, ColExpr::operand(right))
                };
                return Some((left.to_string(), expr));
            }
        }
        None
    }

    fn is_empty(&self) -> bool {
        match self {
            FilterExpr::Term(t) => t.is_empty(),
            FilterExpr::Col(_, e) => e.is_empty(),
            FilterExpr::And(a, b) => a.is_empty() || b.is_empty(),
            FilterExpr::Or(a, b) => a.is_empty() || b.is_empty(),
        }
    }

    fn matches(&self, row: &RowData) -> bool {
        match self {
            FilterExpr::Term(t) => t.is_empty() || row.contains_term(t),
            // Top-level column (case-insensitive). Handles leaves, nested `field(...)` scopes, and
            // recursive leaf match on a nested Json column. (Depth is expressed by nesting parens —
            // `role(engineering(subRole(front)))` — not by dotted paths.)
            FilterExpr::Col(col, e) => match row.get_ci(col) {
                Some(v) => e.matches(v),
                None => false,
            },
            FilterExpr::And(a, b) => a.matches(row) && b.matches(row),
            FilterExpr::Or(a, b) => a.matches(row) || b.matches(row),
        }
    }
}

// ---------------------------------------------------------------------------
// SortKey
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct SortKey {
    col: String,
    asc: bool,
}

// ---------------------------------------------------------------------------
// GridEngine
// ---------------------------------------------------------------------------
#[wasm_bindgen]
pub struct GridEngine {
    /// Compact row storage — no serde_json::Value overhead at rest
    raw_data: Vec<RowData>,

    /// Filtered + sorted indices (indirect sort — only indices move, not data).
    /// Empty when is_filtered == false.
    filtered_indices: Vec<usize>,

    /// True when a filter is active and filtered_indices is meaningful.
    is_filtered: bool,

    /// True when sort is active but no filter — get_page walks col_index directly.
    is_sort_only: bool,

    /// Current filter expression
    filter_expr: Option<FilterExpr>,
    filter_text: String,

    /// Cache of the *unsorted* filtered row indices and the filter text that produced
    /// them. Lets a sort-only change (filter unchanged) reuse the filtered set instead
    /// of re-scanning every raw row. Invalidated whenever the data changes.
    filtered_base: Vec<usize>,
    filtered_base_text: String,
    filtered_base_valid: bool,

    /// Current sort key
    sort_key: Option<SortKey>,

    /// Per-column sorted index: col -> buckets of row indices grouped by equal value,
    /// buckets ordered ascending by value; within a bucket, row indices are ascending.
    /// Iterating buckets forward yields ascending order, `.rev()` yields descending —
    /// same traversal contract the old BTreeMap<FieldVal, Vec<usize>> provided, but
    /// contiguous (cache-friendly) and built with a single sort instead of N tree inserts.
    /// Lazily built per column on first sort request for that column.
    col_index: HashMap<String, Vec<Vec<usize>>>,

    /// Interned column names and cell values shared across all rows (see RowData.fields).
    interner: Interner,
}

impl Default for GridEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl GridEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        GridEngine {
            raw_data: Vec::new(),
            filtered_indices: Vec::new(),
            is_filtered: false,
            is_sort_only: false,
            filter_expr: None,
            filter_text: String::new(),
            filtered_base: Vec::new(),
            filtered_base_text: String::new(),
            filtered_base_valid: false,
            sort_key: None,
            col_index: HashMap::new(),
            interner: Interner::default(),
        }
    }

    // -----------------------------------------------------------------------
    // Data loading
    // -----------------------------------------------------------------------

    /// Replaces all rows with the contents of `bytes`. Shared by the three `set_data*`
    /// entry points, which differ only in how JS hands the payload over.
    fn load_bytes(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.raw_data.clear();
        self.interner.clear();
        self.parse_and_append_bytes(bytes)?;
        self.invalidate_indices();
        self.recompute();
        Ok(())
    }

    pub fn set_data(&mut self, json_str: &str) -> Result<(), JsError> {
        self.load_bytes(json_str.as_bytes())
    }

    pub fn set_data_bytes(&mut self, bytes: Uint8Array) -> Result<(), JsError> {
        self.load_bytes(&bytes.to_vec())
    }

    /// # Safety
    /// `ptr`/`len` must describe a live buffer inside this module's linear memory — i.e. one
    /// obtained from `alloc` and not yet passed to `dealloc`.
    pub fn set_data_ptr(&mut self, ptr: u32, len: u32) -> Result<(), JsError> {
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
        self.load_bytes(bytes)
    }

    pub fn alloc(&self, len: u32) -> u32 {
        let mut buf: Vec<u8> = Vec::with_capacity(len as usize);
        let ptr = buf.as_mut_ptr() as u32;
        std::mem::forget(buf);
        ptr
    }

    pub fn dealloc(&self, ptr: u32, len: u32) {
        unsafe {
            let _ = Vec::from_raw_parts(ptr as *mut u8, 0, len as usize);
        }
    }

    /// Appends rows without recomputing — the caller drives that via `finalize`, so a
    /// multi-chunk load doesn't pay for a recompute per chunk.
    fn append_bytes(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.parse_and_append_bytes(bytes)?;
        self.invalidate_indices();
        Ok(())
    }

    pub fn append_chunk(&mut self, json_str: &str) -> Result<(), JsError> {
        self.append_bytes(json_str.as_bytes())?;
        self.recompute();
        Ok(())
    }

    pub fn feed_chunk_bytes(&mut self, bytes: Uint8Array) -> Result<(), JsError> {
        self.append_bytes(&bytes.to_vec())
    }

    /// # Safety
    /// See `set_data_ptr`.
    pub fn feed_chunk_ptr(&mut self, ptr: u32, len: u32) -> Result<(), JsError> {
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
        self.append_bytes(bytes)
    }

    pub fn feed_chunk(&mut self, json_str: &str) -> Result<(), JsError> {
        self.append_bytes(json_str.as_bytes())
    }

    pub fn finalize(&mut self) {
        // Do NOT eagerly build col_index here — it is built lazily on the first
        // sort request. Eager build of 2.6M rows blocks the Worker thread for
        // several seconds (the "90% pending" freeze).
        // Just run recompute() which is a no-op when there is no active filter/sort.
        self.recompute();
    }

    pub fn clear(&mut self) {
        self.raw_data.clear();
        self.filtered_indices.clear();
        self.is_filtered = false;
        self.is_sort_only = false;
        self.filter_expr = None;
        self.filter_text.clear();
        self.filtered_base.clear();
        self.filtered_base_text.clear();
        self.filtered_base_valid = false;
        self.sort_key = None;
        self.col_index.clear();
        self.interner.clear();
    }

    /// Eagerly build all indices (called explicitly if needed).
    pub fn build_index(&mut self) {
        // Build col_index for all columns present in first row
        if let Some(first) = self.raw_data.first() {
            let cols: Vec<String> = first
                .fields
                .iter()
                .map(|(k, _)| k.as_ref().to_string())
                .collect();
            for col in cols {
                self.ensure_col_index(&col);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Filter
    // -----------------------------------------------------------------------

    pub fn filter(&mut self, text: &str) {
        self.filter_text = text.to_string();
        if text.trim().is_empty() {
            self.filter_expr = None;
        } else {
            let expr = FilterExpr::parse(text);
            self.filter_expr = if expr.is_empty() { None } else { Some(expr) };
        }
        self.recompute();
    }

    // -----------------------------------------------------------------------
    // Sort
    // -----------------------------------------------------------------------

    pub fn sort(&mut self, col: &str, asc: bool) {
        if col.is_empty() {
            self.sort_key = None;
        } else {
            self.sort_key = Some(SortKey {
                col: col.to_string(),
                asc,
            });
        }
        self.recompute();
    }

    // -----------------------------------------------------------------------
    // Combined filter + sort in a single recompute pass
    // -----------------------------------------------------------------------

    pub fn filter_and_sort(&mut self, text: &str, col: &str, asc: bool) {
        self.filter_text = text.to_string();
        if text.trim().is_empty() {
            self.filter_expr = None;
        } else {
            let expr = FilterExpr::parse(text);
            self.filter_expr = if expr.is_empty() { None } else { Some(expr) };
        }
        if col.is_empty() {
            self.sort_key = None;
        } else {
            self.sort_key = Some(SortKey {
                col: col.to_string(),
                asc,
            });
        }
        self.recompute();
    }

    // -----------------------------------------------------------------------
    // Pagination
    // -----------------------------------------------------------------------

    pub fn get_page(&self, page: usize, page_size: usize) -> Result<JsValue, JsError> {
        if page_size == 0 {
            return Ok(JsValue::from_str("[]"));
        }
        let start = page * page_size;

        // Collect borrowed row references (no per-row allocation); serialize once below.
        let rows: Vec<&RowData> = if self.is_filtered {
            let total = self.filtered_indices.len();
            if start >= total {
                return Ok(JsValue::from_str("[]"));
            }
            let end = (start + page_size).min(total);
            self.filtered_indices[start..end]
                .iter()
                .map(|&i| &self.raw_data[i])
                .collect()
        } else if self.is_sort_only {
            if let Some(ref key) = self.sort_key {
                let col = &key.col;
                let asc = key.asc;
                let total = self.raw_data.len();
                if start >= total {
                    return Ok(JsValue::from_str("[]"));
                }
                let need = page_size.min(total - start);
                let mut result: Vec<&RowData> = Vec::with_capacity(need);
                if let Some(buckets) = self.col_index.get(col) {
                    let mut skip = start;
                    if asc {
                        'outer_asc: for bucket in buckets.iter() {
                            for &ri in bucket {
                                if skip > 0 {
                                    skip -= 1;
                                    continue;
                                }
                                result.push(&self.raw_data[ri]);
                                if result.len() >= need {
                                    break 'outer_asc;
                                }
                            }
                        }
                    } else {
                        'outer_desc: for bucket in buckets.iter().rev() {
                            for &ri in bucket {
                                if skip > 0 {
                                    skip -= 1;
                                    continue;
                                }
                                result.push(&self.raw_data[ri]);
                                if result.len() >= need {
                                    break 'outer_desc;
                                }
                            }
                        }
                    }
                } else {
                    let end = (start + page_size).min(total);
                    result = self.raw_data[start..end].iter().collect();
                }
                result
            } else {
                let total = self.raw_data.len();
                if start >= total {
                    return Ok(JsValue::from_str("[]"));
                }
                let end = (start + page_size).min(total);
                self.raw_data[start..end].iter().collect()
            }
        } else {
            let total = self.raw_data.len();
            if start >= total {
                return Ok(JsValue::from_str("[]"));
            }
            let end = (start + page_size).min(total);
            self.raw_data[start..end].iter().collect()
        };

        let json_str = serde_json::to_string(&rows).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsValue::from_str(&json_str))
    }

    /// A page of the raw (unfiltered, unsorted) dataset, ignoring any active filter/sort.
    /// Used by "export all" so a filtered view can still download the complete data.
    /// Serialized as a JSON array string, same shape as get_page.
    pub fn get_raw_page(&self, page: usize, page_size: usize) -> Result<JsValue, JsError> {
        if page_size == 0 {
            return Ok(JsValue::from_str("[]"));
        }
        let start = page * page_size;
        let total = self.raw_data.len();
        if start >= total {
            return Ok(JsValue::from_str("[]"));
        }
        let end = (start + page_size).min(total);
        let rows: Vec<&RowData> = self.raw_data[start..end].iter().collect();
        let json_str = serde_json::to_string(&rows).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JsValue::from_str(&json_str))
    }

    pub fn get_page_indices(&self, page: usize, page_size: usize) -> Vec<usize> {
        if page_size == 0 {
            return Vec::new();
        }
        let start = page * page_size;
        if self.is_filtered {
            let total = self.filtered_indices.len();
            if start >= total {
                return Vec::new();
            }
            let end = (start + page_size).min(total);
            self.filtered_indices[start..end].to_vec()
        } else {
            let total = self.raw_data.len();
            if start >= total {
                return Vec::new();
            }
            let end = (start + page_size).min(total);
            (start..end).collect()
        }
    }

    pub fn get_total_count(&self) -> usize {
        if self.is_filtered {
            self.filtered_indices.len()
        } else {
            self.raw_data.len()
        }
    }

    pub fn get_raw_count(&self) -> usize {
        self.raw_data.len()
    }

    // -----------------------------------------------------------------------
    // Combined filter + sort + get_page in a single atomic call
    // Returns JSON string: { "rows": [...], "filtered": N, "raw": N }
    // -----------------------------------------------------------------------

    pub fn filter_sort_and_get_page(
        &mut self,
        text: &str,
        col: &str,
        asc: bool,
        page: usize,
        page_size: usize,
    ) -> Result<JsValue, JsError> {
        // Apply filter + sort state
        self.filter_text = text.to_string();
        if text.trim().is_empty() {
            self.filter_expr = None;
        } else {
            let expr = FilterExpr::parse(text);
            self.filter_expr = if expr.is_empty() { None } else { Some(expr) };
        }
        if col.is_empty() {
            self.sort_key = None;
        } else {
            self.sort_key = Some(SortKey {
                col: col.to_string(),
                asc,
            });
        }
        self.recompute();

        // Get page rows
        let rows_js = self.get_page(page, page_size)?;
        let rows_str = rows_js.as_string().unwrap_or_else(|| "[]".to_string());
        let filtered = self.get_total_count();
        let raw = self.raw_data.len();

        let result = format!(
            "{{\"rows\":{},\"filtered\":{},\"raw\":{}}}",
            rows_str, filtered, raw
        );
        Ok(JsValue::from_str(&result))
    }
}

// ---------------------------------------------------------------------------
// Private impl
// ---------------------------------------------------------------------------
impl GridEngine {
    /// Streaming parse: uses serde_json streaming iterator to avoid
    /// materialising the entire JSON string as a single allocation.
    fn parse_and_append_bytes(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let mut de = serde_json::Deserializer::from_slice(bytes);
        // Loop so that back-to-back documents in one buffer still work (the streaming loader
        // may hand over several chunks' worth at once), while each document is consumed
        // element-by-element by RowSink rather than materialised whole.
        loop {
            let sink = RowSink {
                rows: &mut self.raw_data,
                interner: &mut self.interner,
            };
            match sink.deserialize(&mut de) {
                Ok(()) => {}
                // Clean end of buffer — no more documents.
                Err(e) if e.is_eof() => break,
                Err(e) => return Err(JsError::new(&e.to_string())),
            }
        }
        Ok(())
    }

    /// Invalidate all lazy indices when data changes.
    fn invalidate_indices(&mut self) {
        self.col_index.clear();
        self.filtered_base_valid = false;
    }

    /// Lazily build the sorted per-column index (buckets of row indices grouped by
    /// equal value, ascending). Built with one sort + a linear group pass rather than
    /// N incremental BTreeMap inserts (which rebalance on every insert).
    fn ensure_col_index(&mut self, col: &str) {
        if self.col_index.contains_key(col) {
            return;
        }
        // Decorate: (value, row_idx) for every row that has this column.
        let hint = self.raw_data.first().and_then(|r| r.col_pos(col));
        let mut deco: Vec<(FieldVal, usize)> = Vec::with_capacity(self.raw_data.len());
        for (row_idx, row) in self.raw_data.iter().enumerate() {
            let val = match hint {
                Some(h) => row.get_at(col, h),
                None => row.get(col),
            };
            if let Some(v) = val {
                deco.push((v.clone(), row_idx));
            }
        }
        // Sort by value; ties broken by ascending row index for a stable display order.
        deco.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        // Group consecutive equal values into buckets (deco is sorted, so equals adjoin).
        let mut buckets: Vec<Vec<usize>> = Vec::new();
        let mut cur_val: Option<FieldVal> = None;
        for (val, row_idx) in deco {
            match &cur_val {
                Some(c) if *c == val => buckets.last_mut().unwrap().push(row_idx),
                _ => {
                    buckets.push(vec![row_idx]);
                    cur_val = Some(val);
                }
            }
        }
        self.col_index.insert(col.to_string(), buckets);
    }

    /// Direct comparison sort of a set of row indices by `col`, matching the column-index
    /// traversal semantics: ascending/descending by value, ties by ascending row index,
    /// rows lacking the column pushed last. Cheaper than building/scanning a full-column
    /// index when the set is small relative to the whole dataset.
    fn sort_indices_by_col(
        raw: &[RowData],
        indices: &mut [usize],
        col: &str,
        asc: bool,
        hint: Option<usize>,
    ) {
        let get = |i: usize| -> Option<&FieldVal> {
            match hint {
                Some(h) => raw[i].get_at(col, h),
                None => raw[i].get(col),
            }
        };
        indices.sort_unstable_by(|&a, &b| {
            match (get(a), get(b)) {
                (Some(x), Some(y)) => {
                    let ord = x.cmp(y);
                    let ord = if asc { ord } else { ord.reverse() };
                    ord.then(a.cmp(&b))
                }
                (Some(_), None) => std::cmp::Ordering::Less, // present values before missing
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.cmp(&b),
            }
        });
    }

    fn recompute(&mut self) {
        let has_filter = self.filter_expr.as_ref().is_some_and(|e| !e.is_empty());
        let has_sort = self.sort_key.is_some();

        if !has_filter && !has_sort {
            self.filtered_indices.clear();
            self.is_filtered = false;
            self.is_sort_only = false;
            return;
        }

        if !has_filter && has_sort {
            // Sort-only: ensure col_index exists, then walk its sorted buckets in get_page.
            // No filtered Vec<usize> materialisation for the full dataset.
            if let Some(ref key) = self.sort_key.clone() {
                self.ensure_col_index(&key.col);
            }
            self.filtered_indices.clear();
            self.is_filtered = false;
            self.is_sort_only = true;
            return;
        }

        // has_filter == true
        self.is_sort_only = false;

        // 1. Filtering — linear scan over raw_data.
        // NOTE: an inverted index was intentionally removed here. Building one over a
        // multi-GB streamed dataset allocates a second copy of every cell string plus
        // per-token index vectors, which overruns the wasm32 heap and traps with
        // "unreachable" on the first search. A substring `contains` match can't use an
        // exact-token index anyway (it must scan every key), so the index gave no speedup.
        // Reuse the cached filtered set when the filter text is unchanged (e.g. the user
        // only changed the sort column/direction). Avoids re-scanning every raw row.
        let mut indices: Vec<usize> =
            if self.filtered_base_valid && self.filtered_base_text == self.filter_text {
                self.filtered_base.clone()
            } else {
                let expr = self.filter_expr.as_ref().unwrap().clone();
                let base: Vec<usize> = self
                    .raw_data
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| expr.matches(row))
                    .map(|(i, _)| i)
                    .collect();
                self.filtered_base = base.clone();
                self.filtered_base_text = self.filter_text.clone();
                self.filtered_base_valid = true;
                base
            };

        // 2. Indirect sorting — only Vec<usize> is reordered
        if let Some(ref key) = self.sort_key.clone() {
            let col = key.col.clone();
            let asc = key.asc;

            // When the filtered set is small relative to the whole dataset, sorting just
            // those rows directly is far cheaper than building a full-column index (which
            // touches every row) and then scanning all of it to pick out the few matches.
            if indices.len() <= self.raw_data.len() / 8 {
                let hint = self.raw_data.first().and_then(|r| r.col_pos(&col));
                Self::sort_indices_by_col(&self.raw_data, &mut indices, &col, asc, hint);
            } else {
                self.ensure_col_index(&col);
                if let Some(buckets) = self.col_index.get(&col) {
                    // Membership via a flat bool bitmap (O(1) lookup, no hashing/rehash
                    // overhead of a HashSet with millions of entries). Costs raw_data.len()
                    // bytes; when we place a filtered row we flip its flag off, so any flags
                    // still set afterwards are exactly the filtered rows the column index
                    // didn't cover (null / missing values) — appended in original order.
                    let mut in_filter = vec![false; self.raw_data.len()];
                    for &i in &indices {
                        in_filter[i] = true;
                    }
                    let mut sorted: Vec<usize> = Vec::with_capacity(indices.len());
                    // Buckets are ascending by value; forward for asc, reversed for desc.
                    // Within a bucket, indices stay ascending in both directions.
                    if asc {
                        for bucket in buckets.iter() {
                            for &ri in bucket {
                                if in_filter[ri] {
                                    sorted.push(ri);
                                    in_filter[ri] = false;
                                }
                            }
                        }
                    } else {
                        for bucket in buckets.iter().rev() {
                            for &ri in bucket {
                                if in_filter[ri] {
                                    sorted.push(ri);
                                    in_filter[ri] = false;
                                }
                            }
                        }
                    }
                    // Append any filtered rows not covered by the index (e.g. null values)
                    if sorted.len() < indices.len() {
                        for &i in &indices {
                            if in_filter[i] {
                                sorted.push(i);
                            }
                        }
                    }
                    indices = sorted;
                }
            }
        }

        self.filtered_indices = indices;
        self.is_filtered = true;
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

#[cfg(test)]
mod col_expr_array_tests {
    use super::ColExpr;
    use serde_json::json;

    fn matches(query: &str, role: &serde_json::Value) -> bool {
        ColExpr::parse(query).matches_value(role)
    }

    /// `&&` over an array is NOT correlated: its sides may be satisfied by different elements.
    /// `.` is, so it constrains one element. Collapsing the two made the first case unsatisfiable.
    #[test]
    fn dot_correlates_within_an_element_and_ampersand_does_not() {
        let role = json!({"Engineering": [
            {"subRole": "Frontend", "years": 3},
            {"subRole": "Backend", "years": 2},
        ]});

        assert!(matches("Engineering(subRole(front).years(3) && subRole(back))", &role));
        assert!(matches("Engineering(subRole(front) && subRole(back))", &role));
        // Correlated: no single element is both front and back.
        assert!(!matches("Engineering(subRole(front).subRole(back))", &role));
        // Correlated with the wrong pairing: Backend has 2 years, not 3.
        assert!(!matches("Engineering(subRole(back).years(3))", &role));
        assert!(matches("Engineering(subRole(back).years(2))", &role));
        // Or still matches whichever side holds.
        assert!(matches("Engineering(subRole(front).years(3) || subRole(nope))", &role));
        assert!(!matches("Engineering(subRole(nope).years(9) || subRole(other))", &role));
    }
}
