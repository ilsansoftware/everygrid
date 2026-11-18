// ---------------------------------------------------------------------------
// describe — the column structure and value profile AI search puts in its prompt
// ---------------------------------------------------------------------------
//
// One pass over the loaded rows. Top-level scalar columns are profiled over every row; nested
// (JSON) values are parsed on an even sample of rows, since parsing millions of them would stall
// the worker for seconds. Per column: its type, the most common values (or all of them when there
// are few — the model then knows the exact spellings), and the range of numbers and dates.
//
// The output is a JSON array shaped like the library's `AiSearchField`:
//   {key, type, samples, complete?, min?, max?, keys?}

use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{json, Map, Value};

use crate::filter::is_date_like;
use crate::row::RowData;
use crate::value::FieldVal;

/// Distinct values tracked per column before counting stops admitting new ones.
const MAX_DISTINCT: usize = 1000;
/// A column with at most this many distinct values lists them all (`complete`).
const ENUM_MAX: usize = 30;
/// Rows whose nested values are parsed and profiled.
const NESTED_SAMPLE_ROWS: usize = 20_000;
const MAX_DEPTH: usize = 3;
const MAX_SAMPLE_LEN: usize = 40;

struct Stat {
    has_str: bool,
    has_num: bool,
    has_bool: bool,
    has_obj: bool,
    has_arr: bool,
    /// Every string seen looks like an ISO date.
    all_dates: bool,
    strs: HashMap<Rc<str>, u32>,
    nums: HashMap<u64, u32>,
    bools: [u32; 2],
    /// More distinct values than MAX_DISTINCT were seen.
    overflow: bool,
    num_min: f64,
    num_max: f64,
    date_min: Option<Rc<str>>,
    date_max: Option<Rc<str>>,
    /// Profiled on every row (not on a sample), so `complete` can be claimed.
    full: bool,
    children: Vec<(Rc<str>, Stat)>,
}

impl Stat {
    fn new(full: bool) -> Self {
        Stat {
            has_str: false,
            has_num: false,
            has_bool: false,
            has_obj: false,
            has_arr: false,
            all_dates: true,
            strs: HashMap::new(),
            nums: HashMap::new(),
            bools: [0, 0],
            overflow: false,
            num_min: f64::INFINITY,
            num_max: f64::NEG_INFINITY,
            date_min: None,
            date_max: None,
            full,
            children: Vec::new(),
        }
    }

    fn child(&mut self, key: &str, full: bool) -> &mut Stat {
        let pos = match self.children.iter().position(|(k, _)| k.as_ref() == key) {
            Some(p) => p,
            None => {
                self.children.push((Rc::from(key), Stat::new(full)));
                self.children.len() - 1
            }
        };
        &mut self.children[pos].1
    }

    fn add_str(&mut self, s: &str, shared: Option<&Rc<str>>) {
        if s.is_empty() {
            return;
        }
        self.has_str = true;
        if let Some(n) = self.strs.get_mut(s) {
            *n += 1;
        } else if self.strs.len() < MAX_DISTINCT {
            self.strs.insert(shared.cloned().unwrap_or_else(|| Rc::from(s)), 1);
        } else {
            self.overflow = true;
        }
        if self.all_dates {
            if is_date_like(s) {
                if self.date_min.as_deref().map_or(true, |m| s < m) {
                    self.date_min = Some(shared.cloned().unwrap_or_else(|| Rc::from(s)));
                }
                if self.date_max.as_deref().map_or(true, |m| s > m) {
                    self.date_max = Some(shared.cloned().unwrap_or_else(|| Rc::from(s)));
                }
            } else {
                self.all_dates = false;
            }
        }
    }

    fn add_num(&mut self, n: f64) {
        self.has_num = true;
        self.num_min = self.num_min.min(n);
        self.num_max = self.num_max.max(n);
        let bits = n.to_bits();
        if let Some(c) = self.nums.get_mut(&bits) {
            *c += 1;
        } else if self.nums.len() < MAX_DISTINCT {
            self.nums.insert(bits, 1);
        } else {
            self.overflow = true;
        }
    }

    fn add_bool(&mut self, b: bool) {
        self.has_bool = true;
        self.bools[b as usize] += 1;
    }

    /// A parsed nested value: objects and arrays recurse (arrays fold their elements together).
    fn add_json(&mut self, v: &Value, depth: usize, full: bool) {
        match v {
            Value::String(s) => self.add_str(s, None),
            Value::Number(n) => self.add_num(n.as_f64().unwrap_or(0.0)),
            Value::Bool(b) => self.add_bool(*b),
            Value::Null => {}
            Value::Object(map) => {
                self.has_obj = true;
                if depth < MAX_DEPTH {
                    for (k, child) in map {
                        self.child(k, full).add_json(child, depth + 1, full);
                    }
                }
            }
            Value::Array(items) => {
                self.has_arr = true;
                for item in items {
                    match item {
                        // Elements' fields are this column's sub-keys, as in the filter grammar.
                        Value::Object(map) if depth < MAX_DEPTH => {
                            for (k, child) in map {
                                self.child(k, full).add_json(child, depth + 1, full);
                            }
                        }
                        Value::Object(_) | Value::Array(_) => {}
                        scalar => self.add_json(scalar, depth, full),
                    }
                }
            }
        }
    }

    fn type_name(&self) -> &'static str {
        let kinds = [self.has_str, self.has_num, self.has_bool, self.has_obj, self.has_arr]
            .iter()
            .filter(|k| **k)
            .count();
        if kinds > 1 {
            return "mixed";
        }
        if self.has_num {
            "number"
        } else if self.has_bool {
            "boolean"
        } else if self.has_obj {
            "object"
        } else if self.has_arr {
            "array"
        } else if self.has_str && self.all_dates {
            "date"
        } else {
            "string"
        }
    }

    fn to_json(&self, key: &str, sample_count: usize) -> Value {
        let mut out = Map::new();
        out.insert("key".into(), json!(key));
        let ty = self.type_name();
        out.insert("type".into(), json!(ty));

        let distinct = self.strs.len() + self.nums.len() + self.bools.iter().filter(|c| **c > 0).count();
        let complete = self.full && !self.overflow && distinct > 0 && distinct <= ENUM_MAX;
        let take = if complete { ENUM_MAX } else { sample_count };

        // Most frequent first; ties keep a stable (text / numeric) order.
        let mut samples: Vec<(u32, Value)> = Vec::new();
        let mut strs: Vec<(&Rc<str>, &u32)> = self.strs.iter().collect();
        strs.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        samples.extend(strs.into_iter().map(|(s, n)| (*n, json!(truncate(s)))));
        let mut nums: Vec<(f64, u32)> = self.nums.iter().map(|(b, n)| (f64::from_bits(*b), *n)).collect();
        nums.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.total_cmp(&b.0)));
        samples.extend(nums.into_iter().map(|(v, n)| (n, num_json(v))));
        for (b, n) in [(true, self.bools[1]), (false, self.bools[0])] {
            if n > 0 {
                samples.push((n, json!(b)));
            }
        }
        samples.sort_by(|a, b| b.0.cmp(&a.0));
        let samples: Vec<Value> = samples.into_iter().take(take).map(|(_, v)| v).collect();
        out.insert("samples".into(), Value::Array(samples));
        if complete {
            out.insert("complete".into(), json!(true));
        }

        if ty == "number" && self.num_min.is_finite() {
            out.insert("min".into(), num_json(self.num_min));
            out.insert("max".into(), num_json(self.num_max));
        } else if ty == "date" {
            if let (Some(lo), Some(hi)) = (&self.date_min, &self.date_max) {
                out.insert("min".into(), json!(lo.as_ref()));
                out.insert("max".into(), json!(hi.as_ref()));
            }
        }

        if !self.children.is_empty() {
            let keys: Vec<Value> = self.children.iter().map(|(k, s)| s.to_json(k, sample_count)).collect();
            out.insert("keys".into(), Value::Array(keys));
        }
        Value::Object(out)
    }
}

fn truncate(s: &str) -> String {
    match s.char_indices().nth(MAX_SAMPLE_LEN) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn num_json(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// Profiles `rows` and returns the field list as a JSON array string.
pub(crate) fn describe(rows: &[RowData], sample_count: usize) -> String {
    let mut root = Stat::new(true);
    let stride = rows.len().div_ceil(NESTED_SAMPLE_ROWS).max(1);
    // Nested values seen on every row (a small dataset) can list all their values too.
    let nested_full = stride == 1;
    for (i, row) in rows.iter().enumerate() {
        let parse_nested = i % stride == 0;
        for (pos, (key, val)) in row.fields.iter().enumerate() {
            // Rows from one source share a layout: try the same position first.
            let at_pos = matches!(root.children.get(pos), Some((k, _)) if Rc::ptr_eq(k, key) || k.as_ref() == key.as_ref());
            let col = if at_pos { &mut root.children[pos].1 } else { root.child(key, true) };
            match val {
                FieldVal::Str(s) => col.add_str(s, Some(s)),
                FieldVal::Num(n) => col.add_num(*n),
                FieldVal::Bool(b) => col.add_bool(*b),
                FieldVal::Null => {}
                FieldVal::Json(text) => {
                    // The shape is known without parsing; the contents only on sampled rows.
                    if text.starts_with('[') { col.has_arr = true; } else { col.has_obj = true; }
                    if parse_nested {
                        if let Ok(v) = serde_json::from_str::<Value>(text) {
                            col.add_json(&v, 0, nested_full);
                        }
                    }
                }
            }
        }
    }
    let fields: Vec<Value> = root.children.iter().map(|(k, s)| s.to_json(k, sample_count)).collect();
    Value::Array(fields).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::Interner;

    fn rows(json: &str) -> Vec<RowData> {
        let mut interner = Interner::default();
        let v: Value = serde_json::from_str(json).unwrap();
        v.as_array().unwrap().iter().filter_map(|r| RowData::from_value(r, &mut interner)).collect()
    }

    #[test]
    fn profiles_columns_over_every_row() {
        let data = rows(r#"[
            {"city":"Seoul","age":25,"joined":"2024-01-01","ok":true,"role":[{"team":"front","years":2}]},
            {"city":"Busan","age":30,"joined":"2023-05-15","ok":false,"role":[{"team":"back","years":1}]},
            {"city":"Seoul","age":28,"joined":"2024-02-10","ok":true,"role":{"team":"ops"}}
        ]"#);
        let out: Value = serde_json::from_str(&describe(&data, 2)).unwrap();
        let by = |k: &str| out.as_array().unwrap().iter().find(|f| f["key"] == k).unwrap().clone();

        let city = by("city");
        assert_eq!(city["type"], "string");
        assert_eq!(city["samples"], json!(["Seoul", "Busan"]));
        assert_eq!(city["complete"], true);

        let age = by("age");
        assert_eq!(age["type"], "number");
        assert_eq!((age["min"].clone(), age["max"].clone()), (json!(25), json!(30)));

        let joined = by("joined");
        assert_eq!(joined["type"], "date");
        assert_eq!((joined["min"].clone(), joined["max"].clone()), (json!("2023-05-15"), json!("2024-02-10")));

        assert_eq!(by("ok")["samples"], json!([true, false]));

        let role = by("role");
        assert_eq!(role["type"], "mixed");
        let team = role["keys"].as_array().unwrap().iter().find(|f| f["key"] == "team").unwrap();
        assert_eq!(team["samples"], json!(["back", "front", "ops"]));
        // A small dataset is parsed on every row, so nested values can be the full list too.
        assert_eq!(team["complete"], true);
        let years = role["keys"].as_array().unwrap().iter().find(|f| f["key"] == "years").unwrap();
        assert_eq!(years["type"], "number");
    }
}
