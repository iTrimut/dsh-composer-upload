<div align="center">

# 🧰 dsh-composer-upload

#### 给 DeepSeek Harness 网页聊天的两个小工具：📎 回形针传文件、▶ 一键继续/唤醒。走官方扩展缝，dsh 怎么升级都不丢。

[![License](https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge)](./LICENSE)
[![Version](https://img.shields.io/badge/Version-0.1.0-F59E0B?style=for-the-badge)](https://github.com/iTrimut/dsh-composer-upload/releases/latest)
[![平台](https://img.shields.io/badge/Windows-%E2%9C%93-3B82F6?style=flat-square)]()

</div>

## 为什么有它

DSH 的网页聊天挺好用，但有三个坑我绕不开：

1. 想让 agent 读一个本地文件，只能**手打路径**或者让它在整个盘里搜——慢，还容易找错工作区；
2. dsh 一重启，agent 就停在那儿，想让它接着干，得**手动打字"继续"**再回车；
3. 我最初直接改 DSH 本体代码来加按钮，可 dsh **一升级改动就没了**，白干。

最后我走了 DSH 官方的插件缝（槽位 + profile client/host 插件）把它做成两个按钮。装上就是：**点 📎 选文件、点 ▶ 让它接着想**，别的不用管。

## 它和"手打路径 / 改 DSH 本体"的区别

| 维度 | 手打路径 / 改本体 | **本插件** |
|---|---|---|
| 传文件给 agent | 打字写路径，工作区错了就找不到 | **点 📎 选文件即可** |
| 消息观感 | 一长串路径占满气泡 | **只显示一个文件名** |
| 重复上传 | 目录里堆 `-1、-2…` | **内容去重**，同一文件只留一份 |
| dsh 升级 | 改过的本体代码被覆盖 | **插件随 profile 保留**，升级不丢 |
| 图片 | 原生只支持粘贴/拖拽 | **有按钮可点**，走内置图片管线 |

## 📦 安装

```bash
dsh plugin --profile web add github:iTrimut/dsh-composer-upload
```

装完重启一次 `dsh web`，你会得到：

- **📎 回形针**：图（png/jpeg/webp/gif）进图片草稿，发送时持久化成 sha256 附件；其它文件进统一目录，气泡里只剩一行 `📎 文件名`；
- **▶ 继续/唤醒**：输入框空着没在跑就显示，有任务就静默恢复，没任务就无声唤醒——聊天里不出现多余文字；
- **Obsidian 适配**：原生文件选择框、复制降级、点链接用系统浏览器打开，都不会因为 iframe 失灵。

## 🚀 快速开始

1. 跑上面的安装命令（想手动装也行，见文末）
2. 重启 `dsh web` 并刷新页面（Obsidian 内嵌就重开面板）
3. 聊天里：点 📎 选文件 → 发送；或点 ▶ 让它接着干

完事。

## ✨ 它替我解决了什么

| 痛点 | 一句话解法 |
|---|---|
| Obsidian 里点附件没反应 | iframe 拦"程序化点文件框"→ 改用原生 label+透明 input |
| 气泡里一长串路径难看 | 只显示文件名，文件统一放固定目录、按名读取 |
| 传了文件 AI 还全盘搜 | 统一目录 + 内容去重，agent 按名字直接读 |
| dsh 重启后要打字"继续" | ▶ 按钮：恢复任务或宿主 `/api/_wake` 无声唤醒 |
| 网页能复制、Obsidian 里复制没反应 | `writeText` 被拒时自动降级 `execCommand` |
| 网址点了不开浏览器 | iframe 里转发给 Obsidian 宿主，用系统浏览器打开 |

## 🔒 边界

这个插件会给 agent 一个"统一上传夹"（默认在 dsh web 进程的工作目录下，即 `<工作目录>/.dsh-uploads`，具体以你的部署为准）。写入只对回环地址 / 你声明信任的主机开放，和 DSH 其它 API 同一套信任；文件名会消毒、单文件 ≤48MB、按内容去重。它不碰账号鉴权——**能访问你 DSH 页面的人本来就等于能操作你的 agent**，本地自用很稳，别把含敏感凭据的文件长期堆在上传夹里。

## 🌟 关于

这套东西是给"拿 DSH 当日常对话台/笔记台"的人做的：上传一张表、发一个 PDF、让它接着上次的活，都不该是打字搜路径的体力活。坑都是我实际踩过的（Obsidian 文件框、复制权限、重启续跑、内容去重都在这堆代码里）。

有想法或踩了新坑，欢迎到 [Issues](https://github.com/iTrimut/dsh-composer-upload/issues) 说一声。

---

<div align="center">

[MIT License](./LICENSE) · 自由使用 / 修改 / 再分发

Made by [@iTrimut](https://github.com/iTrimut)

</div>
