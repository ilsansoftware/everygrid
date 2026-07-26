// Everygrid WASM engine — split into feature modules. `wasm-pack` compiles the whole crate, so
// the generated `pkg/` is identical to when this all lived in one file; the split is organisational.
//
//   value   FieldVal — the typed cell value
//   row     RowData — the compact per-row representation
//   sink    JSON streaming ingestion (RowSink) + the string Interner
//   filter  the query grammar: ColExpr / FilterExpr and their comparisons
//   sort    SortKey
//   engine  GridEngine — the `#[wasm_bindgen]` surface tying it all together

mod engine;
mod filter;
mod row;
mod sink;
mod sort;
mod text;
mod value;

pub use engine::GridEngine;
