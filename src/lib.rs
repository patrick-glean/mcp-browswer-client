use core::slice;
use core::str;
use std::net::TcpStream;
use std::io::{Write, Read};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn handle_message(ptr: *const u8, len: usize) -> u32 {
    let input = unsafe { slice::from_raw_parts(ptr, len) };
    if let Ok(s) = str::from_utf8(input) {
        // Send message to MCP server
        if let Ok(mut stream) = TcpStream::connect("localhost:8081") {
            if let Err(e) = stream.write_all(s.as_bytes()) {
                log(&format!("Error sending message: {}", e));
                return 1;
            }

            // Read response
            let mut response = String::new();
            if let Err(e) = stream.read_to_string(&mut response) {
                log(&format!("Error reading response: {}", e));
                return 1;
            }

            log(&format!("Server response: {}", response));
        } else {
            log("Failed to connect to MCP server");
            return 1;
        }
    }
    0
}

fn log(s: &str) {
    // This will be called from JavaScript
    unsafe {
        let ptr = s.as_ptr();
        let len = s.len();
        log_js(ptr, len);
    }
}

#[no_mangle]
pub extern "C" fn log_js(ptr: *const u8, len: usize) {
    // This function will be implemented in JavaScript
}
