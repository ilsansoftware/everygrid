// ---------------------------------------------------------------------------
// FieldVal — lightweight typed cell value (avoids serde_json::Value overhead)
// ---------------------------------------------------------------------------

use std::rc::Rc;

use serde::ser::{Serialize, Serializer};
use serde_json::Value;

use crate::filter::{
    date_cmp, is_date_like, json_leaf_cmp, num_to_str, range_cmp, text_cmp, CmpOp, CmpVal,
};
use crate::sink::Interner;
use crate::text::{cmp_str_ci, str_contains_ci};

#[derive(Clone)]
pub(crate) enum FieldVal {
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
    pub(crate) fn from_value(v: &Value, interner: &mut Interner) -> Self {
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

    pub(crate) fn contains_term(&self, term: &str) -> bool {
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
    pub(crate) fn regex_str(&self) -> String {
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
    pub(crate) fn cmp_matches(&self, op: CmpOp, val: &CmpVal) -> bool {
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
