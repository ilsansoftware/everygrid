// ---------------------------------------------------------------------------
// GridEngine
// ---------------------------------------------------------------------------

use std::collections::HashMap;

use js_sys::Uint8Array;
use serde::de::DeserializeSeed;
use wasm_bindgen::prelude::*;

use crate::filter::FilterExpr;
use crate::row::RowData;
use crate::sink::{Interner, RowSink};
use crate::sort::SortKey;
use crate::value::FieldVal;

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

    /// Appends rows without recomputing — the caller drives that via `finalize`, so a
    /// multi-chunk load doesn't pay for a recompute per chunk.
    fn append_bytes(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.parse_and_append_bytes(bytes)?;
        self.invalidate_indices();
        Ok(())
    }

    pub fn feed_chunk_bytes(&mut self, bytes: Uint8Array) -> Result<(), JsError> {
        self.append_bytes(&bytes.to_vec())
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
    // -----------------------------------------------------------------------
    // Filter + sort state
    // -----------------------------------------------------------------------

    /// Sets the filter and sort key, then recomputes once. An empty `text` clears the filter and
    /// an empty `col` clears the sort.
    fn set_filter_and_sort(&mut self, text: &str, col: &str, asc: bool) {
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

    /// Replaces rows in place. `indices` are raw (unfiltered, unsorted) row positions —
    /// the order `get_raw_page` returns, which is the order JS holds its data in — and
    /// `rows_json` is a JSON array of replacement objects, positionally matched to them.
    ///
    /// This exists so a cell edit does not have to go through `set_data`, which re-uploads
    /// and re-parses the whole dataset (and drives the indexing progress UI) to change one
    /// value. Out-of-range indices are skipped rather than failing the batch, so a stale
    /// index from a concurrent reload cannot break an otherwise valid edit.
    /// Inserts rows at `index` (clamped to the end), in the order given — the row-add path.
    pub fn insert_rows(&mut self, index: u32, rows_json: &str) -> Result<(), JsError> {
        let values: Vec<serde_json::Value> =
            serde_json::from_str(rows_json).map_err(|e| JsError::new(&e.to_string()))?;
        let mut rows = Vec::with_capacity(values.len());
        for value in &values {
            let Some(row) = RowData::from_value(value, &mut self.interner) else {
                return Err(JsError::new("insert_rows: row is not an object"));
            };
            rows.push(row);
        }
        if rows.is_empty() {
            return Ok(());
        }
        let at = (index as usize).min(self.raw_data.len());
        self.raw_data.splice(at..at, rows);
        self.invalidate_indices();
        self.recompute();
        Ok(())
    }

    /// Removes the rows at `indices` (raw positions; duplicates and out-of-range are ignored).
    pub fn remove_rows(&mut self, indices: Vec<u32>) {
        let mut sorted: Vec<usize> = indices
            .into_iter()
            .map(|i| i as usize)
            .filter(|&i| i < self.raw_data.len())
            .collect();
        if sorted.is_empty() {
            return;
        }
        sorted.sort_unstable();
        sorted.dedup();
        // Highest first, so each removal leaves the lower positions untouched.
        for &i in sorted.iter().rev() {
            self.raw_data.remove(i);
        }
        self.invalidate_indices();
        self.recompute();
    }

    pub fn update_rows(&mut self, indices: Vec<u32>, rows_json: &str) -> Result<(), JsError> {
        let values: Vec<serde_json::Value> =
            serde_json::from_str(rows_json).map_err(|e| JsError::new(&e.to_string()))?;
        if values.len() != indices.len() {
            return Err(JsError::new("update_rows: indices and rows length mismatch"));
        }

        let mut changed = false;
        for (idx, value) in indices.iter().zip(values.iter()) {
            let idx = *idx as usize;
            if idx >= self.raw_data.len() {
                continue;
            }
            let Some(row) = RowData::from_value(value, &mut self.interner) else {
                return Err(JsError::new("update_rows: row is not an object"));
            };
            self.raw_data[idx] = row;
            changed = true;
        }

        if changed {
            // A whole row was swapped, so any column's value may have moved — every sorted
            // index and the cached filtered set are stale.
            self.invalidate_indices();
            self.recompute();
        }
        Ok(())
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
        self.set_filter_and_sort(text, col, asc);

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
