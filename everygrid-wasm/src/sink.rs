// ---------------------------------------------------------------------------
// Row ingestion
// ---------------------------------------------------------------------------

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

use crate::row::RowData;

/// Deserializes a JSON document straight into `rows`, one element at a time.
///
/// Deliberately avoids `Deserializer::into_iter::<Value>()`: for a top-level array that
/// builds the WHOLE document as a Value tree before a single row exists. The tree is
/// several times the size of the JSON text, and on wasm32 the resulting allocator
/// pressure is superlinear — 200k rows (76MB) took ~30s that way versus ~1.3s when the
/// same rows arrive in chunks. Streaming each element keeps peak memory at one row and
/// makes ingest cost linear regardless of how the caller batches it.
pub(crate) struct RowSink<'a> {
    pub(crate) rows: &'a mut Vec<RowData>,
    pub(crate) interner: &'a mut Interner,
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
pub(crate) struct Interner {
    /// Column names — a small, bounded set repeated on every row.
    keys: HashMap<Box<str>, Rc<str>>,
    /// Cell values. `HashSet<Rc<str>>` rather than a `HashMap<Box<str>, _>` because
    /// `Rc<str>: Borrow<str>` allows lookup by `&str` without storing the text twice.
    values: HashSet<Rc<str>>,
}

impl Interner {
    /// Returns the shared `Rc<str>` for a column name, inserting it on first sight.
    pub(crate) fn key(&mut self, key: &str) -> Rc<str> {
        if let Some(rc) = self.keys.get(key) {
            return rc.clone();
        }
        let rc: Rc<str> = Rc::from(key);
        self.keys.insert(Box::from(key), rc.clone());
        rc
    }

    /// Returns a shared `Rc<str>` for a cell value. Repeated values collapse onto one
    /// allocation, which both shrinks the heap and lets `FieldVal::cmp` settle them by pointer.
    pub(crate) fn value(&mut self, s: &str) -> Rc<str> {
        if let Some(rc) = self.values.get(s) {
            return rc.clone();
        }
        let rc: Rc<str> = Rc::from(s);
        if self.values.len() < VALUE_INTERN_CAP {
            self.values.insert(rc.clone());
        }
        rc
    }

    pub(crate) fn clear(&mut self) {
        self.keys.clear();
        self.values.clear();
    }
}
