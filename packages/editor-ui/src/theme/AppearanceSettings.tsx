import { useState } from 'react';
import { appearanceChoices, applyAppearance, readPreferences, saveAppearance, type Appearance } from '../model/preferences.js';

const labels = {
  theme: 'Theme', accent: 'Accent color', density: 'UI density', fontSize: 'Font size',
} satisfies Record<keyof Appearance, string>;
const choiceLabels: Record<string, string> = { oled: 'Darker / OLED', fontSize: 'Font size' };

export function AppearanceSettings() {
  const [appearance, setAppearance] = useState(() => readPreferences().appearance);
  return <>
    <header className="fg-settings-head"><h3>Appearance</h3><span className="fg-muted">Saved on this device.</span></header>
    <div className="fg-appearance">
      {(Object.keys(appearanceChoices) as (keyof Appearance)[]).map(key => <label key={key} className="fg-settings-row">
        <span>{labels[key]}</span>
        <select className="fg-select" value={appearance[key]} onChange={event => {
          const next = { ...appearance, [key]: event.currentTarget.value };
          setAppearance(next); saveAppearance(next); applyAppearance(next, document.documentElement);
        }}>
          {appearanceChoices[key].map(value => <option key={value} value={value}>{choiceLabels[value] ?? value[0]!.toUpperCase() + value.slice(1)}</option>)}
        </select>
      </label>)}
    </div>
  </>;
}
