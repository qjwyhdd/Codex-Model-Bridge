# Codex Model Bridge

Windows 桌面助手，把 RuiC-oc-ferry 的 OpenCode 免费模型接入 Codex。软件负责准备本地模型服务、检测模型、更新 Codex 配置并备份原配置。

## 快速开始

1. 下载并运行 `Codex-Model-Bridge-Setup-0.5.0-win-x64.exe`。
2. 等待软件扫描模型，然后选择一个可用模型。
3. 点击“接入 Codex”。
4. 完全退出并重新打开 Codex，新建对话后选择 Codex Model Bridge 模型。

软件窗口关闭后会留在系统托盘。点击托盘图标可重新打开。高级设置里可查看模型状态、打开日志、开启开机启动或设置系统代理。

## 恢复原配置

点击主界面的“恢复原配置”。软件只撤销自己管理的 Codex 设置，并保留之后新增的 MCP 和其他设置。若管理字段被手动改动，软件会停止自动恢复，避免覆盖你的修改；原配置备份位于“高级设置 → 查看配置备份”。

## 运行要求与限制

- Windows x64、Codex 桌面端和联网环境。
- 首次启动会下载 OpenCode 运行时并探测免费模型，因此启动时间取决于网络。
- 免费模型可能限流、下线或超时；软件只显示探测可用的模型。
- 当前适配 Responses API、文本/图片输入和工具转发。长对话压缩、后台任务及 Codex 内置网页搜索尚未支持。
- 自动化验证覆盖配置接入、恢复、保留其他设置及 Responses 协议；当前环境无法完成 Codex 桌面端的真实模型工具调用验收。

## 本地开发

需要 Node.js 22 或更新版本。

```powershell
npm ci
npm test
npm run test:app
npm run build:win
```

桌面预览：

```powershell
npm run desktop
```

开源协议和上游来源见 [README.md](README.md) 与 [LICENSE](LICENSE)。
