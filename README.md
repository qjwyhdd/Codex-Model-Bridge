# Codex Model Bridge

Codex Model Bridge 是 Windows 桌面助手，把 OpenCode 中可用的免费模型接入 Codex。

软件会自动准备隔离的模型服务，检测模型可用性，并把选中的模型写入 Codex 配置。整个过程不需要命令行，也不需要手动填写 API Key。

## 功能

- 自动发现并筛选 OpenCode 免费模型
- 并发检测模型响应和工具调用能力
- 显示可用模型、失败原因和检测状态
- 配置上下文长度与思考程度
- 一键接入 Codex
- 自动备份 Codex 原配置
- 随时恢复原配置
- 本机 OpenAI 兼容转发服务
- 系统托盘常驻和开机启动
- 深色、浅色和跟随系统主题
- Windows 安装包包含应用、安装器和卸载器图标

## 快速开始

1. 从 [Releases](https://github.com/qjwyhdd/Codex-Model-Bridge/releases) 下载 Windows 安装包。
2. 运行 `Codex-Model-Bridge-Setup-0.5.0-win-x64.exe`。
3. 等待软件准备并检测模型。
4. 选择可用模型，设置上下文长度和思考程度。
5. 点击 **接入 Codex**。
6. 完全退出并重新打开 Codex。
7. 新建对话并选择已接入的模型。

软件窗口关闭后会继续运行在系统托盘。免费模型可能限流、下线或响应变慢，软件会显示具体检测结果。

## Codex 适配说明

详细使用方式、配置恢复、支持范围和已知限制见 [README-CODEX.md](README-CODEX.md)。

当前版本支持基础对话、图片输入和工具转发。长对话压缩、后台任务和 Codex 内置网页搜索仍需进一步验证。

## 本地开发

需要 Node.js 22 或更新版本。

```powershell
npm ci
npm test
npm run test:app
npm run build:win
```

启动桌面预览：

```powershell
npm run desktop
```

## 项目结构

```text
desktop/    Electron 窗口、托盘和控制面板
src/        模型检测、转发、配置接入和恢复逻辑
scripts/    构建、冒烟检查和打包脚本
test/       自动化测试
docs/       设计和验证文档
```

## License

[MIT](LICENSE)
