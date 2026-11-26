# 原型验证产品页与 DS-Bot 视觉系统的一致性：待决问题

对应决策：[原型验证产品页与 DS-Bot 视觉系统的一致性](https://github.com/IceFireIcer/DS-SuperAgent/issues/134)。

## 问题

用 DS-Bot 0.3.8 的视觉系统重做一张 SuperAgent 产品设置页（建议“记忆”或“日程”）：只使用 `--bt-*` token 与上游 `SectionCard`/`FieldRow` 等形态，不写死颜色/圆角/字号。验证 4 套主题 × 浅/深、7 强调色、3 动效档位、字号 12–18px 下的一致性，并据此确定 8 个共享组件（SettingsPage/SectionCard/FieldRow/EmptyState/StatGrid/StatusChip/InlineNotice/DetailList）的接口与样式边界。

## 约束与已知依据

- 上游实际是 4 套主题（DeepSeek/Mono/Paper/Moonlight）+ 6 个外观控制项。
- 当前产品 CSS 有 18 个上游类未定义、33 个 `--bt-*` token 缺失；硬编码集中在 `product.js`、`styles.js`、`product-memory.js`。
- CSS 顺序：DS-Bot 基础/组件 → 设置壳 → `sa-foundation` → `sa-pages`；产品 CSS 不重新声明主题变量。

## 产出

原型页面或可运行片段、样式映射表、共享组件接口草案、与上游设置页并排的视觉对比。
