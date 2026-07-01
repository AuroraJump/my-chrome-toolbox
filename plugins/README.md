# 怎么加载插件 (开发者模式)

Chrome 扩展一般从 Chrome Web Store 安装，但自己开发的扩展需要用"开发者模式"本地加载。

## 步骤

### 1. 打开扩展管理页

地址栏输入：

```
chrome://extensions/
```

### 2. 打开右上角"开发者模式"

页面右上角有个 **"开发者模式"** 开关，点开它。
开关变蓝 = 已开启。
（如果找不到，看看是不是 Chrome 太新，把开关做成了"加载已解压的扩展程序"按钮旁的二级菜单）

### 3. 点"加载已解压的扩展程序"

顶部出现三个按钮：
- 加载已解压的扩展程序
- 打包扩展程序
- 更新

点第一个 **"加载已解压的扩展程序"**。

### 4. 选插件目录

弹出的文件选择框里，导航到插件的根目录（**注意：是包含 `manifest.json` 的那一层，不是仓库根目录**）：

| 插件 | 选择这个目录 |
|------|--------------|
| overtime-tracker | `plugins/overtime-tracker/` |
| 其他 | `plugins/<plugin-name>/` |

点"选择"。

### 5. 验证

返回 `chrome://extensions/`，应该能看到刚加载的扩展卡片：
- 名称（来自 `manifest.json` 的 `name`）
- 版本（来自 `manifest.json` 的 `version`）
- 一行说明

打开扩展对应的目标网站，验证功能是否生效。
比如 `overtime-tracker` 要去 `https://soa.com.cn/oaataticsv/attendance/index.html` 才会显示面板。

## 改完代码怎么更新

1. 在 `plugins/<name>/` 里改文件
2. 回到 `chrome://extensions/`
3. 找到对应扩展卡片，点右下角的 ⟳ **"重新加载"** 按钮
4. 刷新目标网页

## 常见问题

### Q: 点了"加载"但提示"无法加载"
- 检查目录对不对（必须包含 `manifest.json`）
- 检查 `manifest.json` 格式（JSON 不能有尾逗号）
- 看控制台报错信息

### Q: 扩展加载了但页面没反应
- 检查 `manifest.json` 的 `host_permissions` 或 `matches` 是否包含目标网站
- 打开 DevTools 控制台看 content script 有没有报错
- 部分扩展需要 `run_at: "document_idle"` 等候 DOM 渲染完

### Q: 卸载
- 在 `chrome://extensions/` 卡片上点"移除"

### Q: 改 manifest.json 后报错
- 每次改 manifest 都需要 ⟳ 重新加载扩展
- 改了 `host_permissions` / `matches` 可能要刷新目标页面才能生效

## 安全提醒

- 开发者模式下加载的扩展**有完整的页面访问权限**
- 不要加载来源不明的扩展
- 自己开发时，记得用 `<all_urls>` 这种宽匹配时考虑清楚安全性