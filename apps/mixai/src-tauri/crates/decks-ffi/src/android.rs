//! Android context hand-off for cpal/AAudio (WP19-16).
//!
//! cpal reads the JavaVM + application Context from `ndk-context`; a library loaded through JNA (UniFFI's
//! Kotlin loader) never runs an `android_main`, so nothing initialises it and `Engine::start` fails with
//! "android context was not initialized". The Kotlin side calls `DecksAndroid.init(context)` once, before
//! the first engine start; it lands here as a plain JNI export (raw pointers, no `jni` crate needed).

use std::ffi::c_void;
use std::sync::Once;

static INIT: Once = Once::new();

/// JNI: `ro.mixai.decks.ffi.DecksAndroid.nativeInit(Context)`.
///
/// # Safety
/// Called by the JVM with a valid `JNIEnv*` and a local reference to an `android.content.Context`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_ro_mixai_decks_ffi_DecksAndroid_nativeInit(
    env: *mut *const JniNativeInterface,
    _class: *mut c_void,
    context: *mut c_void,
) {
    INIT.call_once(|| unsafe {
        let iface = &**env;
        let mut vm: *mut c_void = std::ptr::null_mut();
        if (iface.get_java_vm)(env, &mut vm) != 0 || vm.is_null() {
            return;
        }
        // Keep the Context alive for the process lifetime: ndk-context stores the raw pointer.
        let global = (iface.new_global_ref)(env, context);
        if global.is_null() {
            return;
        }
        ndk_context::initialize_android_context(vm, global);
    });
}

/// The two JNIEnv function-table slots we use, at their fixed JNI indices (jni.h: NewGlobalRef = 21,
/// GetJavaVM = 219). Everything before/between is padding so the layout matches the real table.
#[repr(C)]
pub struct JniNativeInterface {
    _reserved_0_20: [*const c_void; 21],
    new_global_ref:
        unsafe extern "C" fn(*mut *const JniNativeInterface, *mut c_void) -> *mut c_void,
    _reserved_22_218: [*const c_void; 197],
    get_java_vm: unsafe extern "C" fn(*mut *const JniNativeInterface, *mut *mut c_void) -> i32,
}
