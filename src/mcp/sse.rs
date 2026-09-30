//! Incremental parser for `text/event-stream` bodies (the WHATWG Server-Sent Events format).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: String,
    event: String,
    id: Option<String>,
    seen_first_line: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds raw bytes and returns every event they complete. Lines are split on bytes, so a
    /// chunk may end anywhere, including inside a multi-byte UTF-8 character.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        let mut i = 0;
        while i < self.buf.len() {
            match self.buf[i] {
                b'\n' => {
                    lines.push(String::from_utf8_lossy(&self.buf[start..i]).into_owned());
                    i += 1;
                    start = i;
                }
                b'\r' => {
                    // A trailing CR may be the first half of a CRLF split across chunks.
                    if i + 1 == self.buf.len() {
                        break;
                    }
                    lines.push(String::from_utf8_lossy(&self.buf[start..i]).into_owned());
                    i += if self.buf[i + 1] == b'\n' { 2 } else { 1 };
                    start = i;
                }
                _ => i += 1,
            }
        }
        self.buf.drain(..start);

        let mut events = Vec::new();
        for line in lines {
            self.process_line(&line, &mut events);
        }
        events
    }

    /// Flushes the stream at EOF. Unlike a strict parser this also dispatches an event whose
    /// final blank line never arrived, because some servers close right after the last data line.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&rest);
            let line = line.as_ref();
            self.process_line(line.strip_suffix('\r').unwrap_or(line), &mut events);
        }
        self.dispatch(&mut events);
        events
    }

    fn process_line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        let line = if self.seen_first_line {
            line
        } else {
            self.seen_first_line = true;
            line.strip_prefix('\u{feff}').unwrap_or(line)
        };
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(pos) => {
                let value = &line[pos + 1..];
                (&line[..pos], value.strip_prefix(' ').unwrap_or(value))
            }
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "id" if !value.contains('\0') => self.id = Some(value.to_string()),
            _ => {}
        }
    }

    fn dispatch(&mut self, events: &mut Vec<SseEvent>) {
        if self.data.is_empty() {
            self.event.clear();
            return;
        }
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
            data.pop();
        }
        let event = std::mem::take(&mut self.event);
        events.push(SseEvent {
            event: if event.is_empty() { "message".to_string() } else { event },
            data,
            id: self.id.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(input: &str) -> Vec<SseEvent> {
        let mut parser = SseParser::new();
        let mut events = parser.push(input.as_bytes());
        events.extend(parser.finish());
        events
    }

    fn data(events: &[SseEvent]) -> Vec<&str> {
        events.iter().map(|e| e.data.as_str()).collect()
    }

    #[test]
    fn parses_a_single_event() {
        let events = parse_all("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "message");
        assert_eq!(events[0].data, r#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
    }

    #[test]
    fn handles_crlf_and_bare_cr_line_endings() {
        assert_eq!(data(&parse_all("data: a\r\n\r\ndata: b\r\rdata: c\n\n")), vec!["a", "b", "c"]);
    }

    #[test]
    fn handles_every_possible_chunk_boundary() {
        let input = "id: 7\r\ndata: first\r\n\r\n: keep-alive\n\ndata: 世界\ndata: line two\n\n";
        let expected = parse_all(input);
        assert_eq!(data(&expected), vec!["first", "世界\nline two"]);
        let bytes = input.as_bytes();
        for split in 1..bytes.len() {
            let mut parser = SseParser::new();
            let mut events = parser.push(&bytes[..split]);
            events.extend(parser.push(&bytes[split..]));
            events.extend(parser.finish());
            assert_eq!(events, expected, "split at byte {split}");
        }
    }

    #[test]
    fn feeds_one_byte_at_a_time() {
        let input = "data: {\"a\":1}\r\n\r\n";
        let mut parser = SseParser::new();
        let mut events = Vec::new();
        for byte in input.as_bytes() {
            events.extend(parser.push(std::slice::from_ref(byte)));
        }
        events.extend(parser.finish());
        assert_eq!(data(&events), vec![r#"{"a":1}"#]);
    }

    #[test]
    fn ignores_comments_and_events_without_data() {
        assert!(parse_all(":\r\n: ping\n\nid: 3\nevent: noop\n\n").is_empty());
    }

    #[test]
    fn strips_exactly_one_leading_space_from_values() {
        assert_eq!(data(&parse_all("data:x\n\ndata:  y\n\n")), vec!["x", " y"]);
    }

    #[test]
    fn a_field_without_a_colon_has_an_empty_value() {
        assert_eq!(data(&parse_all("data\n\n")), vec![""]);
    }

    #[test]
    fn keeps_event_type_and_last_event_id() {
        let events = parse_all("event: update\nid: 42\ndata: x\n\ndata: y\n\n");
        assert_eq!(events[0].event, "update");
        assert_eq!(events[0].id.as_deref(), Some("42"));
        assert_eq!(events[1].event, "message");
        assert_eq!(events[1].id.as_deref(), Some("42"));
    }

    #[test]
    fn dispatches_a_trailing_event_at_eof() {
        assert_eq!(data(&parse_all("data: last")), vec!["last"]);
        assert_eq!(data(&parse_all("data: last\r")), vec!["last"]);
    }

    #[test]
    fn strips_a_byte_order_mark() {
        let events = parse_all("\u{feff}data: x\n\n");
        assert_eq!(data(&events), vec!["x"]);
    }
}
