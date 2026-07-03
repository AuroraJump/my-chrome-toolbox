# My Chrome Toolbox

个人 Chrome 扩展集合。每个扩展独立成目录，按需加载。

## 目录结构

```
my-chrome-toolbox/
├── README.md                      <- 你正在看这个
├── .gitignore
└── plugins/
    ├── README.md                  <- 怎么加载插件 (开发者模式)
    └── <plugin-name>/             <- 每个扩展一个目录
        ├── manifest.json
        ├── content.js / content.css
        ├── popup.html / popup.js / popup.css
        ├── icons/
        └── README.md              <- 扩展自己的说明
```

## 当前插件

| 插件 | 说明 | 版本 |
|------|------|------|
| [overtime-tracker](./plugins/overtime-tracker/) | 加班工时实时统计，支持固定/弹性排班、周末节假日规则、交通补贴按天统计、多月统计 | v2.4.5 |

## 怎么加载插件

👉 看 [plugins/README.md](./plugins/README.md)，写了完整的开发者模式加载步骤。

## 怎么加新插件

每个插件就是一个独立的 Chrome 扩展目录，按 Manifest V3 标准组织即可：

```bash
mkdir -p plugins/<new-plugin-name>
# 然后按 Chrome 扩展规范写 manifest.json + content script / popup 等
```

约定：
- 插件目录名用 kebab-case（如 `overtime-tracker`）
- 每个插件自己带 `README.md` 说明用途和配置项
- 涉及图标的话放 `icons/` 子目录
- 不需要的临时文件（`.DS_Store` 等）已在 `.gitignore` 拦了

## 仓库约定

- 主分支：`main`
- 远程：`git@github.com:AuroraJump/my-chrome-toolbox.git`（SSH）
- Commit message 用 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:`
