// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `dataliq run …`: a report in the terminal, no window.
    if args.get(1).map(String::as_str) == Some("run") {
        attach_console();
        std::process::exit(dataliq_lib::cli::report::main(&args[2..]));
    }
    // `dataliq mcp`: an MCP server on stdin/stdout for AI assistants.
    if args.get(1).map(String::as_str) == Some("mcp") {
        std::process::exit(dataliq_lib::mcp::main());
    }
    dataliq_lib::run()
}

/// Release builds on Windows have no console of their own: print to the
/// terminal that started the command, if any.
#[cfg(windows)]
fn attach_console() {
    unsafe extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // SAFETY: AttachConsole only changes this process's console; failure
    // (no parent console, or already attached) leaves output where it was.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}
