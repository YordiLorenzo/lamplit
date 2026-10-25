fn main() {
    // `lamplit.exe --setup` runs with admin rights from wherever the player put Lamplit, a folder they can write to.
    // Windows looks for a DLL that isn't a KnownDLL (hid.dll, for one) in the exe's folder first, so a DLL planted
    // there would run as administrator. LOAD_LIBRARY_SEARCH_SYSTEM32 makes Windows take the exe's imports from System32
    // only.
    println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    tauri_build::build();
}
