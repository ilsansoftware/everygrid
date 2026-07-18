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

    // Scalars at the top level carry no rows; ignore them rather than fail, matching the
    // previous `Ok(_) => {}` arm.
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
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
// FilterExpr — supports AND ('&&'), OR ('||'), and plain text
// ---------------------------------------------------------------------------
#[derive(Clone)]
enum FilterExpr {
    Term(String),
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
        let parts: Vec<&str> = input.split("||").map(|p| p.trim()).collect();
        if parts.is_empty() {
            return FilterExpr::Term(String::new());
        }
        let mut exprs: Vec<FilterExpr> = parts.into_iter().map(Self::parse_and).collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| FilterExpr::Or(Box::new(a), Box::new(b)))
            .unwrap_or_else(|| FilterExpr::Term(String::new()))
    }

    fn parse_and(input: &str) -> Self {
        let parts: Vec<&str> = input.split("&&").map(|p| p.trim()).collect();
        if parts.is_empty() {
            return FilterExpr::Term(String::new());
        }
        let mut exprs: Vec<FilterExpr> = parts
            .into_iter()
            .map(|p| FilterExpr::Term(p.to_lowercase()))
            .collect();
        while exprs.len() > 1 && exprs.last().is_some_and(|e| e.is_empty()) {
            exprs.pop();
        }
        exprs
            .into_iter()
            .reduce(|a, b| FilterExpr::And(Box::new(a), Box::new(b)))
            .unwrap_or_else(|| FilterExpr::Term(String::new()))
    }

    fn is_empty(&self) -> bool {
        match self {
            FilterExpr::Term(t) => t.is_empty(),
            FilterExpr::And(a, b) => a.is_empty() || b.is_empty(),
            FilterExpr::Or(a, b) => a.is_empty() || b.is_empty(),
        }
    }

    fn matches(&self, row: &RowData) -> bool {
        match self {
            FilterExpr::Term(t) => {
                if t.is_empty() {
                    true
                } else {
                    row.contains_term(t)
                }
            }
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
