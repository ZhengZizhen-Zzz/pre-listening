# 本地运行

## 最短路径：先体验预设示例

需要 Node.js 22 或更高版本与 npm。

```bash
npm ci
cp .env.example .env
npm start
```

打开 `http://127.0.0.1:3210`，点击侧栏「查看示例」。示例不需要密钥，包括材料、发言、复盘和问答预设。它展示流程，不是现场模型生成。使用浏览器访问服务地址，不能直接双击 `public/index.html`。

## 接入真实 AI

只在本机 `.env` 填写密钥，不放进前端或提交到 GitHub。

| 配置 | 用途 |
| --- | --- |
| `LLM_PROVIDER=deepseek` | 文本分析、改稿、问答与决策 |
| `DEEPSEEK_API_KEY` | 你自己的 DeepSeek 密钥 |
| `LLM_MODEL` | 有调用权限的模型；示例为当前开发配置，若供应商不支持请替换 |
| `DASHSCOPE_API_KEY` | 百炼语音识别密钥，与文本服务独立 |
| `ASR_MODEL=fun-asr` | 语音识别模型 |
| `MAX_PAID_REQUESTS=30` | 本次服务启动的工作流调用上限，不是人民币预算；一次工作流可能多次调用模型 |

修改 `.env` 后重启服务。也可设置 `LLM_PROVIDER=qwen` 并指定可用模型。实际权限、模型名称和计费以服务商账户为准。默认自动化测试不调用这些服务。

## PPT 转换与可选 OCR

- 安装 LibreOffice 后，程序检测 macOS `/Applications/LibreOffice.app/Contents/MacOS/soffice` 与 Linux `/usr/bin/libreoffice`、`/usr/bin/soffice`，也可通过 `SOFFICE_PATH` 指定。
- PDF 文本预览不依赖 LibreOffice。PPTX 本地预览只支持部分形状与布局，完整预览仍依赖转换器；旧 `.ppt` 需要转换器。缺少字体可能造成排版差异。
- 旧 `.ppt` 的备注提取需要 Python 3，可用 `PPT_NOTES_PYTHON` 指定解释器。现代 PPTX 备注在浏览器读取。
- 图片型材料 OCR 当前使用 **macOS Vision**。仅 macOS 可选安装：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-ocr.txt
```

在 `.env` 中设置 `OCR_PYTHON` 为虚拟环境 Python 的绝对路径。Linux 可用文本提取但没有此 OCR 后端；扫描讲稿也不能保证可读取。

## 运行测试

```bash
npm test
npm run eval:validate
npm run test:release
```

需要真实模型评估时，手动选定案例和预算，例如：

```bash
node scripts/run-quality.mjs --live --ids=d02-example --max-calls=3 --out=.local/eval-example.json
```

这会产生模型费用。输出留在被忽略的 `.local/`，默认 CI 不进行真实模型调用。自动规则筛查通过还需人工判断建议是否正确、是否有用。

## 共享与部署

当前服务默认只监听 `127.0.0.1`，本地模式不用于直接公开。录音在公网环境需要 HTTPS。外部试用还需要反向代理 / 隧道、`TRIAL_DIR` 配置、访问口令及配额管理；详见 [数据与部署边界](DATA.md)。不要把本地模式直接暴露给公网，也不要公开开发者的模型账户。

GitHub Pages 只能托管静态页面，不能独立运行此项目的转换、转写、诊断和 Agent 后端。稳定运营还需独立服务、监控和数据保留策略；本仓库不承诺现成的生产级托管服务。

## 常见问题

- **没有模型也能看什么？** 完整的预设示例、界面结构和操作流程。新材料的真实 AI 反馈需要自己的密钥。
- **为什么 PPTX 先显示、后来外观变化？** 先使用本地快速预览，再换成完整转换结果；复杂图形以转换结果为准。
- **为什么发言页码待确认？** 录音期间未在网页翻页或计时信息不足，需要手动关联。
- **刷新后材料去哪了？** 同一浏览器 / 同一站点可恢复保存的记录；清理站点数据、隐私模式和更换域名可能无法恢复。
