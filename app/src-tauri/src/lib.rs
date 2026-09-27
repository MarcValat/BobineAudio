// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Either a dev-time `uv run` child (live Python source) or a packaged
/// build's frozen sidecar binary -- see `spawn_sidecar` for why both exist.
enum SidecarChild {
    Dev(std::process::Child),
    Packaged(CommandChild),
}

impl SidecarChild {
    fn pid(&self) -> u32 {
        match self {
            SidecarChild::Dev(c) => c.id(),
            SidecarChild::Packaged(c) => c.pid(),
        }
    }
}

struct SidecarState(Mutex<Option<SidecarChild>>);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Dev-time only: assumes the source tree layout (`../../engine` relative
/// to src-tauri's cwd).
fn engine_dir() -> PathBuf {
    std::env::current_dir()
        .expect("current dir")
        .join("..")
        .join("..")
        .join("engine")
}

/// Kill a process and its whole descendant tree.
///
/// A single `.kill()` on the handle we hold only terminates that one
/// process. Both spawn paths below are actually two-hop on Windows: `uv
/// run` spawns the real `python.exe` as a child of `uv.exe` (doesn't
/// `exec`-replace itself the way Unix does), and the packaged PyInstaller
/// "onefile" binary's bootloader likewise unpacks itself and execs the
/// actual interpreter as a *child* process (confirmed by inspecting the
/// real process tree, not assumed) -- either way, killing just the handle
/// we hold leaves the actual FastAPI server (still bound to the port)
/// orphaned. `taskkill /T` kills the whole tree instead.
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        // `taskkill` is a console-subsystem exe; this process (built
        // windowed, see tauri.conf.json) has no console of its own, so
        // without CREATE_NO_WINDOW, Windows pops one up just to run it --
        // flashing open and closed at exactly the moment the app closes.
        // Same root cause as the engine's ffmpeg calls (see
        // ffmpeg_backend._run), just on the Rust side.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

/// Launch the FastAPI sidecar. Two different paths on purpose, not just at
/// packaging time:
///
/// - In dev (`cfg!(debug_assertions)`, true for `tauri dev`), shell out to
///   `uv run syncaudio serve` against the live source tree, exactly as
///   before -- the engine's Python is edited constantly in this project,
///   and re-freezing an ~85MB PyInstaller binary (tens of seconds) on every
///   change would make that iteration loop unusably slow.
/// - In a real build, run the bundled sidecar binary instead (see
///   engine/packaging/, which freezes `syncaudio serve` via PyInstaller into
///   `app/src-tauri/binaries/syncaudio-engine-<target-triple>[.exe]`,
///   referenced by `bundle.externalBin` in tauri.conf.json) -- an installed
///   copy of the app has no Python/`uv` to shell out to at all.
///
/// A failure here (e.g. `uv` missing in dev, or the binary wasn't built for
/// a release) is logged, not fatal: the GUI window still opens, it just
/// can't reach the engine until fixed and restarted.
fn spawn_sidecar(app: &tauri::AppHandle) -> Option<SidecarChild> {
    if cfg!(debug_assertions) {
        let dir = engine_dir();
        match Command::new("uv")
            .args(["run", "syncaudio", "serve", "--port", "8756"])
            .current_dir(&dir)
            .spawn()
        {
            Ok(child) => {
                println!("[sidecar] démarré (uv run syncaudio serve) dans {:?}", dir);
                Some(SidecarChild::Dev(child))
            }
            Err(err) => {
                eprintln!("[sidecar] échec du démarrage dans {:?} : {}", dir, err);
                None
            }
        }
    } else {
        let sidecar = match app.shell().sidecar("syncaudio-engine") {
            Ok(cmd) => cmd,
            Err(err) => {
                eprintln!("[sidecar] binaire introuvable : {}", err);
                return None;
            }
        };
        match sidecar.args(["serve", "--port", "8756"]).spawn() {
            Ok((_rx, child)) => {
                println!("[sidecar] démarré (pid {})", child.pid());
                Some(SidecarChild::Packaged(child))
            }
            Err(err) => {
                eprintln!("[sidecar] échec du démarrage : {}", err);
                None
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let child = spawn_sidecar(&handle);
            app.manage(SidecarState(Mutex::new(child)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<SidecarState>();
                let mut guard = state.0.lock().unwrap();
                if let Some(child) = guard.take() {
                    kill_process_tree(child.pid());
                }
            }
        });
}
