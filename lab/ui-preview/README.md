# UI 预览沙盒

在浏览器里直接渲染真实的 `lib/client.js`（不是复制品），用假数据驱动各个界面状态，便于视觉迭代和截图对比。

## 一次性准备

把 React 18 UMD 复制进来（任何本地 node_modules 都可以）：

```bash
mkdir -p vendor
cp <某项目>/node_modules/react/umd/react.production.min.js vendor/
cp <某项目>/node_modules/react-dom/umd/react-dom.production.min.js vendor/
```

## 使用

```bash
open "lab/ui-preview/index.html?view=setup"
```

可选 `view`：`setup` / `practice` / `speaking` / `shadow` / `starting` / `entry`（不打开面板，只看输入框入口图标）。

## 截图（无头 Chrome）

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-prefers-reduced-motion \
  --window-size=1400,900 --virtual-time-budget=3000 \
  --screenshot="lab/ui-preview/shot-setup.png" \
  "file://$PWD/lab/ui-preview/index.html?view=setup"
```

`--force-prefers-reduced-motion` 会冻结呼吸动画，保证截图稳定。