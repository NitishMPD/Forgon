#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};

const MAX_FRAME: usize = 48 * 1024 * 1024;
type Reply = Result<Value, Value>;
struct Bridge {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    #[cfg(windows)]
    job: isize,
}

impl Bridge {
    fn call(&self, method: &str, args: Value, native: bool) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(&json!({ "request": { "v": 1, "id": id, "method": method, "args": args }, "native": native })).map_err(failure)?;
        if bytes.len() > MAX_FRAME {
            return Err(failure("Request exceeds frame limit"));
        }
        let (send, receive) = mpsc::channel();
        {
            let mut pending = self.pending.lock().map_err(failure)?;
            if pending.len() >= 64 {
                return Err(failure("Too many pending desktop requests"));
            }
            pending.insert(id.clone(), send);
        }
        let written = self.stdin.lock().map_err(failure).and_then(|mut stdin| {
            stdin
                .write_all(&bytes)
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(failure)
        });
        if let Err(error) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match receive.recv_timeout(Duration::from_secs(60)) {
            Ok(result) => result,
            Err(_) => {
                // A timed-out write has an unknown outcome: stop this connection, never retry it.
                self.stop();
                Err(failure("Desktop request timed out; connection closed. Reopen the app and inspect disk before retrying."))
            }
        }
    }
    fn stop(&self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1);
        }
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        for (_, send) in self.pending.lock().unwrap().drain() {
            let _ = send.send(Err(failure("Desktop bridge disconnected")));
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
    }
}
fn failure(error: impl std::fmt::Display) -> Value {
    json!({ "code": "DESKTOP_ERROR", "message": error.to_string() })
}

#[cfg(windows)]
fn own_child(child: &Child) -> Result<isize, Box<dyn std::error::Error>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(error.into());
        }
        Ok(job as isize)
    }
}

fn start(app: &tauri::App) -> Result<Arc<Bridge>, Box<dyn std::error::Error>> {
    let resources = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    } else {
        app.path().resource_dir()?.join("resources")
    };
    let data = app.path().app_local_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let mut command = Command::new(resources.join("node.exe"));
    command
        .arg(resources.join("bridge.mjs"))
        .arg(data)
        .current_dir(&resources)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Prevent inherited Node flags from loading arbitrary modules into the privileged host.
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let job = match own_child(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdin = child.stdin.take().ok_or("Missing Node stdin")?;
    let stdout = child.stdout.take().ok_or("Missing Node stdout")?;
    let bridge = Arc::new(Bridge {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        #[cfg(windows)]
        job,
    });
    let reader_bridge = Arc::downgrade(&bridge);
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut bytes = Vec::new();
            let count = reader
                .by_ref()
                .take((MAX_FRAME + 2) as u64)
                .read_until(b'\n', &mut bytes);
            if !matches!(count, Ok(n) if n > 0 && n <= MAX_FRAME + 1)
                || bytes.last() != Some(&b'\n')
            {
                break;
            }
            let frame: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => break,
            };
            if frame["v"] != 1 {
                break;
            }
            let Some(bridge) = reader_bridge.upgrade() else {
                return;
            };
            if let Some(event) = frame.get("event") {
                let _ = handle.emit_to("studio", "forgon:desktop", event);
            } else if let Some(id) = frame["id"].as_str() {
                if let Some(send) = bridge.pending.lock().unwrap().remove(id) {
                    let result = if let Some(error) = frame.get("error") {
                        Err(error.clone())
                    } else {
                        Ok(frame["result"].clone())
                    };
                    let _ = send.send(result);
                }
            }
        }
        if let Some(bridge) = reader_bridge.upgrade() {
            bridge.stop();
        }
        let _ = handle.emit_to(
            "studio",
            "forgon:desktop",
            json!({ "kind": "closed", "value": "Node bridge disconnected" }),
        );
    });
    Ok(bridge)
}

#[tauri::command]
async fn desktop_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Bridge>>,
    method: String,
    args: Value,
) -> Reply {
    if window.label() != "studio" {
        return Err(failure("Studio window required"));
    }
    let url = window.url().map_err(failure)?;
    let local = url.scheme() == "tauri"
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let dev =
        cfg!(debug_assertions) && url.origin().ascii_serialization() == "http://127.0.0.1:5173";
    if !local && !dev {
        return Err(failure("Local studio origin required"));
    }
    if method.starts_with("native:") {
        return Err(failure("Native-only method"));
    }
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if method == "project:pick" {
            return match rfd::FileDialog::new()
                .set_title("Choose project folder or parent for a new project")
                .pick_folder()
            {
                Some(path) => bridge.call("native:grant", json!({ "root": path }), true),
                None => Ok(Value::Null),
            };
        }
        if method == "asset:import" {
            let Some(path) = rfd::FileDialog::new()
                .set_title("Import asset — source is copied, never executed")
                .pick_file()
            else {
                return Ok(Value::Null);
            };
            let mut args = args;
            let Some(object) = args.as_object_mut() else {
                return Err(failure("Arguments required"));
            };
            object.insert("source".into(), json!(path));
            return bridge.call(&method, args, true);
        }
        bridge.call(&method, args, false)
    })
    .await
    .map_err(failure)?
}

#[tauri::command]
async fn desktop_close_blocked(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "studio" {
        return Err("Studio window required".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        rfd::MessageDialog::new().set_title("Project has unsaved work")
            .set_description("Save your work or use Close project in the editor to discard changes. Wait for any save to finish, then close the window.")
            .set_level(rfd::MessageLevel::Warning).show();
    }).await.map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let bridge = start(app)?;
            app.manage(bridge);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            desktop_close_blocked
        ])
        .build(tauri::generate_context!())
        .expect("Unable to initialize Forgon Studio")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let bridge = handle.state::<Arc<Bridge>>();
                let _ = bridge.call("bridge:shutdown", json!({}), false);
                bridge.stop();
            }
        });
}
