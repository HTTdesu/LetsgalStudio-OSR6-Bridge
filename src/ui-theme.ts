/**
 * 扩展界面的共用视觉 token。
 *
 * 游戏内的界面文档（`ui/*.json`，画布 1920×1080）和 Studio 里的编辑期设置页
 * （React，CSS 像素）共用同一套颜色与层级：改这里，两边一起变。
 */

/** 颜色：和 `ui/osr6-settings.json` 里用的值一一对应。 */
export const COLORS = {
  /** 卡片底色（对应文档里的 rgba(255,255,255,0.045) 叠在 #0b1219 上） */
  card: "rgba(15, 26, 34, 0.92)",
  cardBorder: "rgba(127, 212, 200, 0.16)",
  accent: "#5fbbae",
  accentSoft: "rgba(127, 212, 200, 0.10)",
  accentBorder: "rgba(127, 212, 200, 0.90)",
  accentText: "#06201c",
  text: "#f4f8f7",
  textMuted: "rgba(244, 248, 247, 0.58)",
  textFaint: "rgba(244, 248, 247, 0.38)",
  value: "rgba(233, 240, 244, 0.90)",
  danger: "rgba(122, 49, 57, 0.85)",
  dangerBorder: "rgba(190, 90, 100, 0.80)",
  divider: "rgba(244, 248, 247, 0.10)",
  inputBg: "rgba(255, 255, 255, 0.06)",
  inputBorder: "rgba(255, 255, 255, 0.18)",
} as const;

/**
 * 字号层级：游戏文档用设计像素（26/22/64），编辑期按同一比例缩到工具尺度
 * （同一层级约 0.55 倍，保持行高比例一致）。
 */
export const TYPE = {
  title: 20,
  section: 14,
  label: 12.5,
  value: 12.5,
  hint: 11.5,
  button: 12,
} as const;

/** 圆角与间距，和文档里的 16/12/10 对应。 */
export const SPACE = {
  cardRadius: 12,
  controlRadius: 8,
  rowMinHeight: 34,
  gap: 10,
  cardPadding: 16,
} as const;

export const FONT_STACK =
  '"Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
