// ---------------------------------------------------------------------------
// RowData — compact row representation
// ---------------------------------------------------------------------------

use std::rc::Rc;

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::Value;

use crate::sink::Interner;
use crate::value::FieldVal;

#[derive(Clone)]
pub(crate) struct RowData {
    /// Column names and values in insertion order.
    /// Column-name keys are interned as `Rc<str>` so the (heavily repeated) name
    /// text is stored once and shared across every row instead of being cloned
    /// per row — a major memory saving on multi-million-row datasets.
    pub(crate) fields: Vec<(Rc<str>, FieldVal)>,
}

impl RowData {
    /// Builds a row, interning each column name through `interner` so identical
    /// names across rows share a single allocation. Returns None for non-objects.
    pub(crate) fn from_value(v: &Value, interner: &mut Interner) -> Option<Self> {
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

    pub(crate) fn get(&self, col: &str) -> Option<&FieldVal> {
        self.fields
            .iter()
            .find(|(k, _)| k.as_ref() == col)
            .map(|(_, v)| v)
    }

    /// Case-insensitive column lookup (used by the filter so `role` matches a `Role` column).
    pub(crate) fn get_ci(&self, col: &str) -> Option<&FieldVal> {
        self.fields
            .iter()
            .find(|(k, _)| k.as_ref().eq_ignore_ascii_case(col))
            .map(|(_, v)| v)
    }

    /// Position of `col` within this row's fields, if present.
    pub(crate) fn col_pos(&self, col: &str) -> Option<usize> {
        self.fields.iter().position(|(k, _)| k.as_ref() == col)
    }

    /// O(1) column access when `hint` is the column's position (uniform schema —
    /// the common case, since all rows come from the same JSON source). Falls back
    /// to a linear scan when the row's layout differs from the hint.
    pub(crate) fn get_at(&self, col: &str, hint: usize) -> Option<&FieldVal> {
        if let Some((k, v)) = self.fields.get(hint) {
            if k.as_ref() == col {
                return Some(v);
            }
        }
        self.get(col)
    }

    pub(crate) fn contains_term(&self, term: &str) -> bool {
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
