/**
 * 编辑期设置页的控件，按 `ui-theme` 的 token 渲染。
 *
 * 与游戏内界面文档保持同一套视觉语言：深色卡片、青色强调、统一的字号层级。
 * 只做这个页面需要的最小集合，不引入新的依赖。
 */
import type { CSSProperties, ReactNode } from "react";
import { COLORS, FONT_STACK, SPACE, TYPE } from "./ui-theme";

const base: CSSProperties = {
  fontFamily: FONT_STACK,
  fontSize: TYPE.label,
  color: COLORS.text,
  boxSizing: "border-box",
};

/** 一整块带标题的深色卡片。 */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section
      style={{
        ...base,
        background: COLORS.card,
        border: `1px solid ${COLORS.cardBorder}`,
        borderRadius: SPACE.cardRadius,
        padding: SPACE.cardPadding,
        marginBottom: 12,
      }}
    >
      {title ? (
        <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ width: 3, height: 14, borderRadius: 2, background: COLORS.accent }} />
          <h2
            style={{
              margin: 0,
              fontSize: TYPE.section,
              fontWeight: 600,
              letterSpacing: 1,
              color: COLORS.text,
            }}
          >
            {title}
          </h2>
        </header>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: SPACE.gap }}>{children}</div>
    </section>
  );
}

/** 左标签、右控件的行。 */
export function Row({
  label,
  description,
  children,
  disabled = false,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        ...base,
        display: "flex",
        alignItems: "center",
        gap: SPACE.gap,
        minHeight: SPACE.rowMinHeight,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <div style={{ width: 104, flex: "0 0 104px" }}>
        <div style={{ fontSize: TYPE.label, color: COLORS.textMuted, letterSpacing: 0.5 }}>{label}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{children}</div>
        {description ? (
          <div style={{ marginTop: 3, fontSize: TYPE.hint, color: COLORS.textFaint, lineHeight: 1.5 }}>
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 只读值。 */
export function Value({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: TYPE.value, color: COLORS.value }}>{children}</span>;
}

type ButtonTone = "primary" | "ghost" | "danger";

export function Btn({
  children,
  onClick,
  tone = "ghost",
  disabled = false,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  title?: string;
}) {
  const toneStyle: CSSProperties =
    tone === "primary"
      ? { background: COLORS.accent, borderColor: COLORS.accentBorder, color: COLORS.accentText }
      : tone === "danger"
        ? { background: COLORS.danger, borderColor: COLORS.dangerBorder, color: COLORS.text }
        : { background: COLORS.inputBg, borderColor: COLORS.inputBorder, color: COLORS.text };
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...base,
        ...toneStyle,
        fontSize: TYPE.button,
        letterSpacing: 0.5,
        borderWidth: 1,
        borderStyle: "solid",
        borderRadius: SPACE.controlRadius,
        padding: "6px 12px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  width = 160,
  inputMode,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  width?: number;
  inputMode?: "text" | "numeric";
}) {
  return (
    <input
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
      style={{
        ...base,
        width,
        fontSize: TYPE.value,
        padding: "6px 10px",
        background: COLORS.inputBg,
        color: COLORS.value,
        border: `1px solid ${COLORS.inputBorder}`,
        borderRadius: SPACE.controlRadius,
        outline: "none",
      }}
    />
  );
}

/** 单选分段控件（等价文档里的多颗互斥按钮）。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              ...base,
              fontSize: TYPE.button,
              letterSpacing: 0.5,
              padding: "6px 12px",
              borderRadius: SPACE.controlRadius,
              border: `1px solid ${active ? COLORS.accentBorder : COLORS.inputBorder}`,
              background: active ? COLORS.accent : COLORS.inputBg,
              color: active ? COLORS.accentText : COLORS.text,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...base,
        width: 42,
        height: 22,
        padding: 2,
        borderRadius: 11,
        border: `1px solid ${checked ? COLORS.accentBorder : COLORS.inputBorder}`,
        background: checked ? COLORS.accent : COLORS.inputBg,
        display: "flex",
        justifyContent: checked ? "flex-end" : "flex-start",
        alignItems: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: checked ? COLORS.accentText : COLORS.textMuted,
        }}
      />
    </button>
  );
}

/** 下拉框：原生 select，样式对齐 token。 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
}: {
  value: T | "";
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      style={{
        ...base,
        minWidth: 260,
        fontSize: TYPE.value,
        padding: "6px 10px",
        background: COLORS.inputBg,
        color: COLORS.value,
        border: `1px solid ${COLORS.inputBorder}`,
        borderRadius: SPACE.controlRadius,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <option value="">{placeholder ?? "请选择…"}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value} style={{ color: "#111" }}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
