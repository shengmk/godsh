use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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

/// 在独立窗口中打开一个 URL（如 dsh Web UI）。
/// 用于「打开环境」：不依赖 target=_blank（WebView2 下不可靠），
/// 而是新建一个原生 WebView 窗口加载 dsh 页面，体验与 DSH Desktop 一致。
#[tauri::command]
fn open_dsh_window(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
  let label = format!(
    "dsh-{}",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis())
      .unwrap_or(0)
  );
  WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
    .title(if title.is_empty() { "dsh" } else { &title })
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .build()
    .map_err(|e| format!("创建窗口失败: {e}"))?;
  Ok(())
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
    .invoke_handler(tauri::generate_handler![open_dsh_window, open_external])
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
