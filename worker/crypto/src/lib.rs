//! Only the byte-level primitive crosses the Worker/DO boundary. No Odoo decisions or I/O.
use sha2::Sha512;
use zeroize::Zeroize;

#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// The JS adapter owns each allocation and releases it exactly once, with its original length.
#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    let mut bytes = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
    bytes.zeroize();
}

/// All pointers must be live, disjoint allocations; output has exactly 64 bytes.
#[no_mangle]
pub unsafe extern "C" fn derive(
    password: *const u8, password_len: usize,
    salt: *const u8, salt_len: usize,
    rounds: u32, output: *mut u8,
) {
    assert!(rounds > 0);
    pbkdf2::pbkdf2_hmac::<Sha512>(
        std::slice::from_raw_parts(password, password_len),
        std::slice::from_raw_parts(salt, salt_len),
        rounds,
        std::slice::from_raw_parts_mut(output, 64),
    );
}
