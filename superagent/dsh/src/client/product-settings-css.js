import { spring, SPRING_SHAPE, SPRING_TAP } from './motion.js'

export const PRODUCT_SETTINGS_CSS = `
:root {
  --bt-ps-text: var(--bt-font-body);
  --bt-ps-small: var(--bt-font-body);
  --bt-ps-caption: var(--bt-font-caption);
  --bt-ps-title: var(--bt-font-title);
  --bt-ps-stat: 22px;
  --bt-ps-radius-card: var(--bt-radius-card);
  --bt-ps-radius-control: var(--bt-radius-input);
  --bt-ps-radius-small: var(--bt-radius-menu-item);
  --bt-ps-radius-pill: var(--bt-radius-pill);
  --bt-ps-gap: 22px;
}
.bt-ps-page { min-height: 0; color: var(--bt-ink); font-family: var(--bt-font); }
.bt-ps-page > .bt-settings-head { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 20px 56px 8px 28px; }
.bt-ps-page > .bt-settings-head h2 { flex: 1; margin: 0; font-size: var(--bt-ps-title); line-height: 24px; overflow-wrap: anywhere; }
.bt-ps-page > .bt-settings-scroll { min-height: 0; padding: 12px 28px 28px; gap: var(--bt-ps-gap); }
:is(.bt-ps-page, .bt-superagent-settings) .bt-settings-scroll { container: bt-settings-content / inline-size; }
.bt-ps-content { display: grid; align-content: start; gap: var(--bt-ps-gap); min-width: 0; }
.bt-ps-section, .bt-ps-content { font-size: var(--bt-ps-text); line-height: 18px; }
.bt-ps-section > h3 { font-size: inherit; }
.bt-ps-card {
  min-width: 0;
  background: var(--bt-card);
  border: .5px solid var(--bt-glass-rim, var(--bt-line));
  border-radius: var(--bt-ps-radius-card);
  box-shadow: var(--bt-card-shadow, none);
}
.bt-ps-card > :not(.bt-set-row, .bt-ps-empty, .bt-ps-details, .bt-ps-notice) { padding: 12px 16px; }
.bt-ps-card > p { margin: 0; }
.bt-ps-card > button.bt-soft { margin: 8px 16px; align-self: flex-start; padding: 0 16px; }
.bt-ps-row.bt-set-row { gap: 16px; min-height: 48px; padding: 12px 16px; overflow-wrap: anywhere; }
.bt-ps-row.bt-ps-stack { align-items: stretch; flex-direction: column; gap: 8px; }
.bt-ps-label { font-weight: 500; }
.bt-ps-hint, .bt-ps-description { font-size: var(--bt-ps-small); line-height: 17px; color: var(--bt-ink-2); overflow-wrap: anywhere; }
.bt-ps-section > .bt-ps-description { margin: -4px 4px 8px; }
.bt-ps-control, .bt-ps-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; }
.bt-ps-row .bt-ps-control { flex: 0 1 auto; width: fit-content; }
.bt-ps-stack .bt-ps-control { width: 100%; }
.bt-ps-stack .bt-ps-control > :is(input:not([type=checkbox]), textarea) { flex: 1 1 auto; }
.bt-ps-control > :is(input, select, textarea) { min-width: 0; max-width: 100%; }
.bt-ps-control > .bt-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 0; border: 0;
  border-radius: var(--bt-ps-radius-pill); background: var(--bt-line-2); cursor: pointer; transition: background-color .12s ease; }
.bt-ps-control > .bt-switch[aria-checked=true] { background: var(--bt-accent); }
.bt-ps-control > .bt-switch:disabled { opacity: .45; cursor: default; }
.bt-ps-control .bt-switch-knob { position: absolute; inset: 2px auto auto 2px; width: 16px; height: 16px;
  border-radius: var(--bt-ps-radius-pill); background: var(--bt-knob);
  transition: ${spring(SPRING_SHAPE, 'transform')}, ${spring(SPRING_TAP, 'width')}; }
.bt-ps-control > .bt-switch[aria-checked=true] .bt-switch-knob { transform: translateX(16px); }
.bt-ps-control > .bt-switch:active:not(:disabled) .bt-switch-knob { width: 21px; }
.bt-ps-control > .bt-switch[aria-checked=true]:active:not(:disabled) .bt-switch-knob { transform: translateX(11px); }
:is(.bt-ps-page, .bt-ps-content, .bt-ps-card) .bt-bs-input {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 34px; padding: 0 10px;
  border: .5px solid var(--bt-line-2); border-radius: var(--bt-ps-radius-control);
  background: var(--bt-card); color: var(--bt-ink); font: inherit;
}
:is(.bt-ps-page, .bt-ps-content, .bt-ps-card) textarea.bt-bs-input { padding: 8px 10px; resize: vertical; }
:is(.bt-ps-page, .bt-ps-content, .bt-ps-card) :is(button, input, select, textarea, summary, a[href]):focus-visible {
  outline: 2px solid var(--bt-accent); outline-offset: 2px;
}
.bt-ps-empty { padding: 18px 12px; text-align: center; color: var(--bt-ink-3); font-size: var(--bt-ps-text); line-height: 18px; }
.bt-ps-empty p { margin: 0; }
.bt-ps-empty > * + * { margin-top: 8px; }
.bt-ps-stats { display: grid; grid-template-columns: repeat(var(--bt-ps-columns), minmax(0, 1fr)); gap: 1px; margin: 0;
  border: 1px solid var(--bt-line); border-radius: var(--bt-ps-radius-card); background: var(--bt-main); overflow: hidden; }
.bt-ps-stat { display: flex; flex-direction: column; gap: 6px; padding: 16px 18px; background: var(--bt-card);
  box-shadow: 0 0 0 1px var(--bt-line); overflow-wrap: anywhere; }
.bt-ps-stat dt { order: 1; font-size: var(--bt-ps-small); line-height: 16px; color: var(--bt-ink-2); }
.bt-ps-stat dd { margin: 0; font-size: var(--bt-ps-stat); line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bt-ps-stat dd.bt-ps-description { order: 2; font: inherit; font-size: var(--bt-ps-small); }
.bt-ps-chip { display: inline-flex; align-items: center; align-self: flex-start; padding: 1px 7px; border-radius: var(--bt-ps-radius-pill);
  font-size: var(--bt-ps-caption); line-height: 16px; background: var(--bt-tag-bg); color: var(--bt-tag-ink); }
.bt-ps-chip[data-tone=accent] { background: var(--bt-accent-soft, var(--bt-tag-bg)); color: var(--bt-ink); }
.bt-ps-chip[data-tone=success] { background: color-mix(in srgb, var(--bt-green) 16%, transparent); color: var(--bt-ink); }
.bt-ps-chip[data-tone=warn] { background: color-mix(in srgb, var(--bt-star) 16%, transparent); color: var(--bt-warn, var(--bt-ink)); }
.bt-ps-chip[data-tone=danger] { background: color-mix(in srgb, var(--bt-danger) 10%, transparent); color: var(--bt-ink); }
.bt-ps-notice { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px; padding: 12px 14px;
  border: .5px solid var(--bt-line-2); border-radius: var(--bt-ps-radius-card); color: var(--bt-ink); background: var(--bt-tag-bg); }
.bt-ps-card > .bt-ps-notice { margin: 8px; }
.bt-ps-notice[data-tone=accent] { background: var(--bt-accent-soft, color-mix(in srgb, var(--bt-accent) 10%, transparent)); }
.bt-ps-notice[data-tone=warn] { background: color-mix(in srgb, var(--bt-star) 10%, transparent); }
.bt-ps-notice[data-tone=success] { background: color-mix(in srgb, var(--bt-green) 10%, transparent); }
.bt-ps-notice[data-tone=danger] { background: var(--bt-danger-soft, color-mix(in srgb, var(--bt-danger) 10%, transparent)); }
.bt-ps-notice-copy { flex: 1 1 180px; min-width: 0; }
.bt-ps-notice-copy strong { display: block; margin-bottom: 2px; font-size: var(--bt-ps-text); line-height: 18px; }
.bt-ps-details { margin: 0; }
.bt-ps-detail { display: flex; align-items: baseline; gap: 12px; padding: 9px 16px; font-size: var(--bt-ps-text); overflow-wrap: anywhere; }
.bt-ps-detail + .bt-ps-detail { border-top: .5px solid var(--bt-line); }
.bt-ps-detail dt { flex: 1; min-width: 0; }
.bt-ps-detail dd { margin: 0; max-width: 70%; text-align: end; font-size: var(--bt-ps-small); line-height: 16px; color: var(--bt-ink-2); }
@container bt-settings-content (max-width: 520px) {
  .bt-ps-row.bt-set-row { align-items: stretch; flex-direction: column; gap: 8px; }
  .bt-ps-row .bt-ps-control { width: 100%; }
  .bt-ps-stats { grid-template-columns: repeat(min(var(--bt-ps-columns), 2), minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .bt-ps-page > .bt-settings-head { padding-inline-start: 16px; }
  .bt-ps-page > .bt-settings-scroll { padding-inline: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .bt-ps-control > .bt-switch, .bt-ps-control .bt-switch-knob { transition: none; }
}
`
