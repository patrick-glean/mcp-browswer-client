//! Just enough URL handling for discovery and authorization requests.

use crate::http::encode_component;

/// Splits an absolute URL into its origin ("https://host:port") and the rest (path and query),
/// dropping any fragment.
pub fn split(url: &str) -> Option<(&str, &str)> {
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    let authority_start = scheme_end + 3;
    let rest_start = url[authority_start..].find(['/', '?', '#']).map_or(url.len(), |i| authority_start + i);
    if rest_start == authority_start {
        return None;
    }
    let rest = url[rest_start..].split('#').next().unwrap_or("");
    Some((&url[..rest_start], rest))
}

/// The path of a path-and-query, without the query.
pub fn path_only(path_and_query: &str) -> &str {
    path_and_query.split('?').next().unwrap_or("")
}

/// `base` with `params` appended to its query string.
pub fn with_query(base: &str, params: &[(&str, &str)]) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    let query = params
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}{separator}{query}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_origin_from_path_and_query() {
        assert_eq!(split("https://be.glean.com/mcp/default"), Some(("https://be.glean.com", "/mcp/default")));
        assert_eq!(split("http://127.0.0.1:8081/"), Some(("http://127.0.0.1:8081", "/")));
        assert_eq!(split("https://x.test"), Some(("https://x.test", "")));
        assert_eq!(split("https://x.test/a?b=1#frag"), Some(("https://x.test", "/a?b=1")));
        assert_eq!(split("x.test/mcp"), None);
        assert_eq!(split("https:///nohost"), None);
        assert_eq!(path_only("/a?b=1"), "/a");
    }

    #[test]
    fn appends_query_parameters() {
        assert_eq!(with_query("https://x.test/authorize", &[("a", "1 2"), ("b", "x/y")]), "https://x.test/authorize?a=1%202&b=x%2Fy");
        assert_eq!(with_query("https://x.test/authorize?tenant=t", &[("a", "1")]), "https://x.test/authorize?tenant=t&a=1");
    }
}
