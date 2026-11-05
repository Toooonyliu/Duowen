Transcript Workspace — v2 交互演示

在线网页：https://Toooonyliu.github.io/Duowen/
本地预览：npm run dev
自包含文件：Transcript-Demo.html（包含短音频、图标及中文 PDF 字体，文件较大）。本轮通过本地 HTTP 验证；工具不允许直接 file:// 浏览，因此没有声称验证双击运行。

页面流程：上传入口 → Library（历史、上传批次、文件状态）→ 单个录音详情（播放器、时间戳、说话人、笔记和提问）。

真实样本：选自 Transcript Sample 的 360 Studio Brainstorming.m4a，只取前 90 秒；原始录音 08:40。转录来自本机 WhisperX，未经人工校对，保留识别错误；四个时间戳为近似语段时间。尚未运行说话人分离，因此 Unknown speaker 表示未分配，不代表已经识别为一个人。可以手动纠正和命名。

导出：PDF、Word DOCX、Markdown、TXT、SRT、VTT、JSON。导出使用当前文本和说话人修改。DOCX 是真正的 Word 文件；PDF 完整嵌入中文字体，避免缺字，短样本文件约 6.5MB；PDF 在后台线程生成，超过 60 秒会提供可恢复的错误提示。

新上传音频/视频只在浏览器内读取和播放，可导入 SRT/VTT/TXT 字幕。自动转写服务、可靠耗时估算、自动声纹匹配和实时 AI 问答尚未接入。演示中的处理状态明确标记 Demo；预置摘要/问答也有来源标记。刷新后本地音频可能需要重新选择。

工程：src/ 是源码，public/samples/ 是短样本及数据；licenses/ 保存图标/字体许可。npm run build 构建，npm run export:html 生成独立 HTML。QA 见 design-qa.md。

源码：https://github.com/Toooonyliu/Duowen（公开）。GitHub Pages 在 main 更新时自动构建发布。只包含选定的90秒公开演示片段；排除凭证、模型缓存、环境、原始长录音及其他面试/HR 音频。Vercel 配置也保留，输出目录 dist/client。
