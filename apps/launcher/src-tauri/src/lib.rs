use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProc(Mutex<Option<Child>>);

/// 去掉 Windows 的 `\\?\`（verbatim）前缀，node 无法解析带该前缀的路径。
fn clean_path(p: PathBuf) -> PathBuf {
  let s = p.to_string_lossy();
  match s.strip_prefix(r"\\?\") {
    Some(rest) => PathBuf::from(rest),
    None => p,
  }
}

/// 从资源目录解析打包的运行时资源（resources/ 子目录）。
fn resolve_resource(app: &tauri::App, rel: &str) -> Option<PathBuf> {
  if let Ok(res) = app.path().resource_dir() {
    let direct = res.join("resources").join(rel);
    if direct.exists() {
      return Some(clean_path(direct));
    }
    let legacy = res.join("_up_").join(rel);
    if legacy.exists() {
      return Some(clean_path(legacy));
    }
  }
  None
}

/// 运行时数据目录：优先 DSH_LAUNCHER_DATA_DIR，否则 %APPDATA%\godsh\data。
fn data_dir() -> String {
  std::env::var("DSH_LAUNCHER_DATA_DIR").unwrap_or_else(|_| {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    format!("{}\\godsh\\data", appdata)
  })
}

/// 定位 DSH Desktop 可执行文件（官方桌面应用，专门用于打开 dsh 环境界面）。
/// 查找顺序：标准安装路径 → DSH Desktop shim（dsh.cmd）里引用的 exe 路径。
fn find_dsh_desktop() -> Option<PathBuf> {
  let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let standard = PathBuf::from(&local).join("Programs").join("DSH Desktop").join("DSH Desktop.exe");
  if standard.exists() {
    return Some(standard);
  }
  // 从 shim 解析：%APPDATA%\DSH Desktop\host-commands\desktop\bin\dsh.cmd
  let appdata = std::env::var("APPDATA").unwrap_or_default();
  let shim = PathBuf::from(&appdata).join("DSH Desktop").join("host-commands").join("desktop").join("bin").join("dsh.cmd");
  if let Ok(text) = std::fs::read_to_string(&shim) {
    // shim 内形如 "C:\...\DSH Desktop\DSH Desktop.exe" 的引用
    if let Some(start) = text.find("DSH Desktop.exe") {
      let before = &text[..start];
      if let Some(quote) = before.rfind('"') {
        let exe = &before[quote + 1..start + "DSH Desktop.exe".len()];
        let p = PathBuf::from(exe.replace("\\\\", "\\"));
        if p.exists() {
          return Some(p);
        }
      }
    }
  }
  None
}

/// 「打开环境」：优先用独立的 DSH Desktop 桌面软件打开指定 profile；
/// 未安装 DSH Desktop 时回退系统浏览器打开 web URL。
/// 返回实际使用的打开方式：desktop | browser。
#[tauri::command]
fn open_dsh_profile(profile: String, url: String) -> Result<String, String> {
  if let Some(exe) = find_dsh_desktop() {
    let mut cmd = Command::new(&exe);
    // DSH Desktop 通过该环境变量决定启动哪个 profile（与官方 shim 一致）
    cmd.env("DSH_DESKTOP_DEFAULT_PROFILE", &profile);
    // 沿用当前 DSH_HOME（若已设置）
    if let Ok(home) = std::env::var("DSH_HOME") {
      if !home.is_empty() {
        cmd.env("DSH_HOME", home);
      }
    }
    cmd.spawn().map_err(|e| format!("启动 DSH Desktop 失败: {e}"))?;
    return Ok("desktop".into());
  }
  // 无 DSH Desktop → 系统浏览器打开 web
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
  Command::new("cmd")
    .args(["/c", "start", "", parsed.as_str()])
    .spawn()
    .map_err(|e| format!("打开失败: {e}"))?;
  Ok("browser".into())
}

/// 用系统默认浏览器打开 URL（桌面端「复制地址」之外的备选入口）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
  // Windows: cmd /c start "" <url>（无需额外依赖；open crate 离线不可用）
  Command::new("cmd")
    .args(["/c", "start", "", parsed.as_str()])
    .spawn()
    .map_err(|e| format!("打开失败: {e}"))?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ServerProc(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![open_dsh_profile, open_external])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 优先 DSH_LAUNCHER_SERVER（开发用），否则资源目录
      let server = std::env::var("DSH_LAUNCHER_SERVER")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .map(clean_path)
        .or_else(|| resolve_resource(app, "server.mjs"));

      if let Some(server) = server {
        let mut cmd = Command::new("node");
        cmd.arg(&server)
          .arg("serve")
          .arg("--port")
          .arg("4780")
          .env("DSH_LAUNCHER_DATA_DIR", data_dir());
        if let Some(templates) = resolve_resource(app, "templates") {
          cmd.env(
            "DSH_LAUNCHER_TEMPLATES_DIR",
            templates.to_string_lossy().to_string(),
          );
        }
        match cmd.spawn() {
          Ok(child) => {
            *app.state::<ServerProc>().0.lock().unwrap() = Some(child);
          }
          Err(e) => {
            eprintln!("[godsh] 启动后端失败: {e}");
          }
        }
      } else {
        eprintln!("[godsh] 未找到 server.mjs，后端未启动");
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let tauri::RunEvent::Exit = event {
        if let Some(mut child) = app_handle.state::<ServerProc>().0.lock().unwrap().take() {
          let _ = child.kill();
          let _ = child.wait();
        }
      }
    });
}
