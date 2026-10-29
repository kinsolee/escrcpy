---
name: ui-drive
description: Drive a visible macOS GUI window (Electron desktop app or native) by screen coordinates — activate, click, paste text, screenshot, verify. Use when asked to operate, verify, or screenshot a desktop app UI on this Mac, e.g. Escrcpy's dev build. Covers window locating, click synthesis, IME-safe typing, and screenshot coordinate math.
---

# UI Drive — macOS GUI 驱动配方

用屏幕坐标驱动可见 GUI 窗口（Electron 或原生）。每个动作后**必须截图确认**再做下一个——合成点击有已知的被吞风险，盲连点会误触无关控件。

脚本在 `scripts/` 下：`click.swift`（CGEvent 点击）、`type.sh`（剪贴板粘贴输入）。

## 黄金规则

1. **每次点击前激活目标窗口**——否则点击只亮 hover 不触发事件（macOS 不给非 key 窗口派发）：
   ```bash
   osascript -e 'tell application "System Events" to set frontmost of (first application process whose unix id is <PID>) to true'
   sleep 0.5
   swift .claude/skills/ui-drive/scripts/click.swift <x> <y>
   ```
2. **文本输入永远走剪贴板粘贴**（`type.sh`），不要 `keystroke` 直打——中文输入法会把英文串打碎（"http" → 「t图片」）。
3. **一步一截图**：`screencapture -x -R<x>,<y>,<w>,<h> /tmp/shot.png` 后 Read 出图确认，再决定下一步。
4. 坐标全部是**点（points）不是像素**。retina 下截图像素 = 点 × 2。

## 坐标换算

`screencapture -R646,234,1270,847` 截出的图被 Read 显示时会缩放（如 2540px 宽显示成 2000）。要从图上某元素反推屏幕坐标：

```
screen_x = region_x + displayed_x × (region_w / displayed_w)
screen_y = region_y + displayed_y × (region_h / displayed_h)
```

## 定位与移动窗口

```bash
# 按 PID 查窗口位置/尺寸（注意同名 Electron 应用多个时用 unix id 区分）
osascript -e 'tell application "System Events" to tell (first application process whose unix id is <PID>)
  get {position, size} of window 1 end tell'

# 窗口开在屏幕外时挪回来（Escrcpy 常开在 x=-1800 之类）
osascript -e 'tell application "System Events" to set position of window 1 of (first application process whose unix id is <PID>) to {248, 130}'
```

不确定窗口在哪：先 `screencapture -x /tmp/full.png` 全屏截一张目测。

## Escrcpy 专用

```bash
cd desktop && pnpm dev        # Vite 1535 + Electron
pnpm electron-fix             # Electron 二进制损坏（path.txt 缺失）时修复
```

- 窗口 PID 用 `ps aux | grep -E "Electron.*--no-sandbox"` 从 worktree 路径认出自己的实例（本机还有 WorkBuddy 等 Electron 应用，别点错）。
- **改了 Vue/主进程代码后行为怪异（对话框打不开、状态卡死）**：先 `keystroke "r" using command down` 重载渲染层，多半是 HMR 陈旧状态，不是代码 bug。
- 主进程改动（`desktop/electron/**`、`packages/*/dist`）必须重启 dev 进程才生效。
- 常用入口：顶部 tab 设备/流程/偏好/关于；偏好页右上工具栏 MagicStick 图标 = AI 自愈模型对话框。

## Gotchas

- **点击被吞**（只显示 hover 边框、按钮无响应）→ 窗口不是 key window，激活后重试；别怀疑坐标先怀疑激活。
- **两个点击连发，第二个误触了别的控件** → 中间必须截图确认；对话框弹出/关闭会改变布局。
- **OSAScript keystroke 输入乱码** → 中文 IME 组字，用 `type.sh`。
- **el-dialog 保存后再打不开** → 先 Cmd+R 排除 HMR；仍复现才是真 bug。
