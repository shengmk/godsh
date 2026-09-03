use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, State};

struct ServerProc(Mutex<Option<Child>>);

/// 实际选定的后端端口（Tauri command 暴露给前端，保证前后端一致）。
struct BackendPort(u16);

/// 返回实际监听的后端端口（供前端动态拼接 API 基址，避免 4780 被占后偏移错位）。
#[tauri::command]
fn get_server_port(state: State<BackendPort>) -> u16 {
  state.0
}

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

/// 启动诊断日志：写入 <data>/logs/desktop-boot.log（追加），便于定位「打不开/端口拒绝」。
fn boot_log(msg: &str) {
  use std::io::Write;
  let data = data_dir();
  let dir = format!("{}\\logs", data);
  let _ = std::fs::create_dir_all(&dir);
  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(format!("{}\\desktop-boot.log", dir))
  {
    let _ = writeln!(f, "[{ts}] {msg}");
  }
}

/// 定位 node 可执行文件：先环境变量覆盖，再常见安装路径，最后回退 PATH 的 node。
fn find_node_exe() -> Option<PathBuf> {
  if let Ok(n) = std::env::var("DSH_LAUNCHER_NODE") {
    if !n.is_empty() {
      let p = PathBuf::from(n);
      if p.exists() {
        return Some(p);
      }
    }
  }
  let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
  let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let candidates = [
    format!("{}\\Program Files\\nodejs\\node.exe", sys),
    format!("{}\\Program Files (x86)\\nodejs\\node.exe", sys),
    format!("{}\\Programs\\nodejs\\node.exe", local),
    format!("{}\\Programs\\fnm\\node.exe", local),
  ];
  for c in candidates {
    let p = PathBuf::from(c);
    if p.exists() {
      return Some(p);
    }
  }
  None
}

/// 动态探测空闲端口：优先 preferred（默认 4780），若已占用则从 preferred+1 向后找，
/// 最多扫描 100 个端口。TcpListener::bind 成功即说明端口可用（绑定测试后立即释放）。
fn find_free_port(preferred: u16) -> u16 {
  for port in preferred..=preferred.saturating_add(100) {
    if TcpListener::bind(("127.0.0.1", port)).is_ok() {
      return port;
    }
  }
  // 兜底：让 OS 分配（极端情况下 4780–4880 全占满）
  if let Ok(l) = TcpListener::bind("127.0.0.1:0") {
    if let Ok(addr) = l.local_addr() {
      return addr.port();
    }
  }
  preferred
}

/// 定位 DSH Desktop 可执行文件（官方桌面应用，专门用于打开 dsh 环境界面）。
fn find_dsh_desktop() -> Option<PathBuf> {
  let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let standard = PathBuf::from(&local).join("Programs").join("DSH Desktop").join("DSH Desktop.exe");
  if standard.exists() {
    return Some(standard);
  }
  let appdata = std::env::var("APPDATA").unwrap_or_default();
  let shim = PathBuf::from(&appdata).join("DSH Desktop").join("host-commands").join("desktop").join("bin").join("dsh.cmd");
  if let Ok(text) = std::fs::read_to_string(&shim) {
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
#[tauri::command]
fn open_dsh_profile(profile: String, url: String) -> Result<String, String> {
  if let Some(exe) = find_dsh_desktop() {
    let mut cmd = Command::new(&exe);
    cmd.env("DSH_DESKTOP_DEFAULT_PROFILE", &profile);
    if let Ok(home) = std::env::var("DSH_HOME") {
      if !home.is_empty() {
        cmd.env("DSH_HOME", home);
      }
    }
    cmd.spawn().map_err(|e| format!("启动 DSH Desktop 失败: {e}"))?;
    return Ok("desktop".into());
  }
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
  Command::new("cmd")
    .args(["/c", "start", "", parsed.as_str()])
    .spawn()
    .map_err(|e| format!("打开失败: {e}"))?;
  Ok("browser".into())
}

/// 定位浏览器可执行文件（用于「网址应用化」模式：--app=URL 打开独立窗口）。
fn find_browser_exe() -> Option<PathBuf> {
  let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
  let pf = std::env::var("ProgramFiles").unwrap_or_default();
  let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
  let candidates = [
    PathBuf::from(&pf86).join("Microsoft").join("Edge").join("Application").join("msedge.exe"),
    PathBuf::from(&pf).join("Microsoft").join("Edge").join("Application").join("msedge.exe"),
    PathBuf::from(&pf).join("Google").join("Chrome").join("Application").join("chrome.exe"),
    PathBuf::from(&pf86).join("Google").join("Chrome").join("Application").join("chrome.exe"),
    PathBuf::from(&local).join("Google").join("Chrome").join("Application").join("chrome.exe"),
  ];
  for c in candidates {
    if c.exists() {
      return Some(c);
    }
  }
  None
}

/// 「网址应用化」打开 dsh web 界面（无地址栏独立窗口）。
#[tauri::command]
fn open_app_window(url: String) -> Result<(), String> {
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
  if let Some(exe) = find_browser_exe() {
    let mut cmd = Command::new(&exe);
    cmd.arg(format!("--app={}", parsed.as_str()));
    cmd.spawn().map_err(|e| format!("启动应用窗口失败: {e}"))?;
    return Ok(());
  }
  Command::new("cmd")
    .args(["/c", "start", "", parsed.as_str()])
    .spawn()
    .map_err(|e| format!("打开失败: {e}"))?;
  Ok(())
}

/// 用系统默认浏览器打开 URL。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
  let parsed: url::Url = url.parse().map_err(|e| format!("无效 URL: {e}"))?;
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
    .invoke_handler(tauri::generate_handler![
      get_server_port,
      open_dsh_profile,
      open_app_window,
      open_external
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 动态探测空闲端口（首选 4780，已占用则顺序找下一个空闲端口）
      let port = find_free_port(4780);
      eprintln!("[godsh] 后端端口: {port}");
      boot_log(&format!("godsh 启动; 探测端口: {port}; data: {}", data_dir()));
      app.manage(BackendPort(port));

      // 解析后端入口 server.mjs（env 覆盖 → 打包资源）
      let server = std::env::var("DSH_LAUNCHER_SERVER")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .map(clean_path)
        .or_else(|| resolve_resource(app, "server.mjs"));

      if let Some(server) = server {
        let server_str = server.to_string_lossy().to_string();
        boot_log(&format!("server.mjs 解析: {server_str} (exists={})", server.exists()));

        // node 定位：绝对路径优先，避免桌面环境 PATH 差异导致后端无法启动
        let node_exe = find_node_exe();
        let mut cmd = match &node_exe {
          Some(p) => {
            boot_log(&format!("node 定位(绝对路径): {p:?}"));
            let mut c = Command::new(p);
            c
          }
          None => {
            boot_log("node 未在常见路径找到，回退 PATH 'node'");
            Command::new("node")
          }
        };
        cmd.arg(&server)
          .arg("serve")
          .arg("--port")
          .arg(port.to_string())
          .env("DSH_LAUNCHER_PORT", port.to_string())
          .env("DSH_LAUNCHER_DATA_DIR", data_dir());
        if let Some(templates) = resolve_resource(app, "templates") {
          cmd.env(
            "DSH_LAUNCHER_TEMPLATES_DIR",
            templates.to_string_lossy().to_string(),
          );
        }
        match cmd.spawn() {
          Ok(child) => {
            boot_log(&format!("后端已启动 pid={}", child.id()));
            *app.state::<ServerProc>().0.lock().unwrap() = Some(child);
          }
          Err(e) => {
            let msg = format!("后端启动失败: {e}");
            eprintln!("[godsh] {msg}");
            boot_log(&msg);
          }
        }
      } else {
        let msg = "未找到 server.mjs，后端未启动";
        eprintln!("[godsh] {msg}");
        boot_log(msg);
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