//! PKCE (RFC 7636) with S256, and the `state` value that ties a callback to its sign-in.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["self", "crypto"], js_name = getRandomValues)]
    fn get_random_values(array: &js_sys::Uint8Array);
}

/// Cryptographically random bytes from Web Crypto.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let array = js_sys::Uint8Array::new_with_length(N as u32);
    get_random_values(&array);
    let mut bytes = [0u8; N];
    array.copy_to(&mut bytes);
    bytes
}

/// 32 random bytes in base64url: a 43-character verifier, the shortest RFC 7636 allows.
pub fn verifier(random: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(random)
}

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn state(random: &[u8; 16]) -> String {
    URL_SAFE_NO_PAD.encode(random)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_7636_example() {
        let random = [
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
            91, 88, 5, 88, 83, 132, 141, 121,
        ];
        let verifier = verifier(&random);
        assert_eq!(verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(challenge(&verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn states_are_url_safe() {
        let state = state(&[0xff; 16]);
        assert_eq!(state.len(), 22);
        assert!(state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
