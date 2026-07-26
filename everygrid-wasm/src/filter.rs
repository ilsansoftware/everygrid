// ---------------------------------------------------------------------------
// FilterExpr — global text search plus per-column groups, combined with '&&'/'||'.
//   - bare term        → substring match across all columns (case-insensitive)
//   - `col(subexpr)`   → subexpr applied to one column only (single level, no nesting)
// A column subexpr (ColExpr) supports substring terms and numeric comparisons
// (`<40`, `>=30`, or value-first `30<=`), also combined with '&&'/'||'.
// ---------------------------------------------------------------------------

use serde_json::Value;

use crate::row::RowData;
use crate::text::str_contains_ci;
use crate::value::FieldVal;

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
pub(crate) enum CmpOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

impl CmpOp {
    pub(crate) fn test_ord(self, ord: std::cmp::Ordering) -> bool {
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
pub(crate) enum CmpVal {
    Num(f64),
    Str(String),
}

/// Format a numeric operand as its plain string (integers without a decimal point).
pub(crate) fn num_to_str(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Exact/ordered comparison for plain text operands: `=` is exact, the rest are lexicographic.
pub(crate) fn text_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
    match op {
        CmpOp::Eq => field == operand,
        _ => op.test_ord(field.cmp(operand)),
    }
}

/// Prefix-range comparison: the operand is a prefix defining a period `[operand, operand+ε)`
/// (e.g. `2024` = the whole year, `2026-01-05` = that whole day). `=` matches the period;
/// `>`/`<=` are relative to its END, `>=`/`<` to its START. This makes `>2026-01-05` exclude
/// Jan 5 while `>=2026-01-05` includes it.
pub(crate) fn range_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
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
pub(crate) fn is_date_like(s: &str) -> bool {
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
pub(crate) fn date_cmp(field: &str, operand: &str, op: CmpOp) -> bool {
    range_cmp(&norm_sep(field), &norm_sep(operand), op)
}

/// True if any leaf value inside a nested JSON value satisfies the comparison.
pub(crate) fn json_leaf_cmp(v: &Value, op: CmpOp, val: &CmpVal) -> bool {
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
pub(crate) enum ColExpr {
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
    pub(crate) fn parse(input: &str) -> Self {
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
    pub(crate) fn operand(s: &str) -> CmpVal {
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
pub(crate) enum FilterExpr {
    Term(String),
    Col(String, Box<ColExpr>),
    And(Box<FilterExpr>, Box<FilterExpr>),
    Or(Box<FilterExpr>, Box<FilterExpr>),
}

impl FilterExpr {
    pub(crate) fn parse(input: &str) -> Self {
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

    pub(crate) fn is_empty(&self) -> bool {
        match self {
            FilterExpr::Term(t) => t.is_empty(),
            FilterExpr::Col(_, e) => e.is_empty(),
            FilterExpr::And(a, b) => a.is_empty() || b.is_empty(),
            FilterExpr::Or(a, b) => a.is_empty() || b.is_empty(),
        }
    }

    pub(crate) fn matches(&self, row: &RowData) -> bool {
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
