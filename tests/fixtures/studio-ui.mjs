import React from "react";

export const settings = new Map();
const listeners = new Set();
export const useSetting = (name) => [React.useSyncExternalStore(
  (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  () => settings.get(name), () => settings.get(name),
), (value) => { settings.set(name, value); for (const listener of listeners) listener(); }];
export const useStudioLocale = () => "zh-CN";
export const toast = () => {};
export const Panel = ({ children }) => React.createElement("main", null, children);
export const Section = ({ title, children }) => React.createElement("section", null, React.createElement("h2", null, title), children);
export const FieldRow = ({ label, description, children }) => React.createElement("div", null, label, description, children);
export const Button = ({ disabled, children, onClick }) => React.createElement("button", { disabled, onClick }, children);
export const Select = ({ value, options, disabled, placeholder, ariaLabel, onChange }) => React.createElement("select", {
  value, disabled, "aria-label": ariaLabel, onChange: (event) => onChange(event.target.value),
}, React.createElement("option", { value: "" }, placeholder), ...options.map((item) => React.createElement("option", { key: item.value, value: item.value }, item.label)));
export const Segmented = ({ value, options, disabled, ariaLabel, onChange }) => React.createElement("div", { role: "group", "aria-label": ariaLabel },
  ...options.map((item) => React.createElement("button", { key: item.value, disabled, "aria-pressed": item.value === value, onClick: () => onChange(item.value) }, item.label)));
export const TextInput = ({ value, ariaLabel }) => React.createElement("input", { value, "aria-label": ariaLabel, onChange() {} });
export const Switch = () => React.createElement("input", { type: "checkbox" });
export const AutoSettings = () => null;
