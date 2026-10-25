import type { TableSettings, UpdateTableSettingsIntent } from '@pokerclause/shared';
import { MoneyInput } from './MoneyInput.js';

// A table's editable settings — shared by the owner menu at the table
// (OwnerMenu.tsx) and the lobby's hold-a-table editor
// (TableSettingsModal.tsx), which both save through LiveTable.updateSettings.

export type SettingsForm = {
  name: string;
  smallBlind: number | '';
  bigBlind: number | '';
  ante: number | '';
  straddleEnabled: boolean;
  minBuyIn: number | '';
  maxBuyIn: number | '';
  actionSeconds: number | '';
  timeBankSeconds: number | '';
  isPrivate: boolean;
  disableChatInHand: boolean;
  /** Open-invite tables only; null on any other table. */
  openSeatStack: number | '' | null;
};

/** The form starts from where the table is heading — pass the settings in force overlaid with anything queued for the next hand. */
export function formFromSettings(name: string, s: TableSettings): SettingsForm {
  return {
    name,
    smallBlind: s.smallBlind,
    bigBlind: s.bigBlind,
    ante: s.ante,
    straddleEnabled: s.straddleEnabled,
    minBuyIn: s.minBuyIn,
    maxBuyIn: s.maxBuyIn,
    actionSeconds: s.actionSeconds,
    timeBankSeconds: s.timeBankSeconds,
    isPrivate: s.isPrivate,
    disableChatInHand: s.disableChatInHand,
    openSeatStack: s.openSeating ? (s.openSeatStack ?? s.maxBuyIn) : null,
  };
}

/** Only the fields that actually changed — so saving a timer tweak mid-hand doesn't also re-send (and re-defer) the blinds. */
export function diffSettings(form: SettingsForm, base: SettingsForm): UpdateTableSettingsIntent | string {
  const out: UpdateTableSettingsIntent = {};
  if (form.name.trim() !== base.name) {
    if (!form.name.trim()) return 'The table needs a name.';
    out.name = form.name.trim();
  }
  for (const key of ['smallBlind', 'bigBlind', 'ante', 'minBuyIn', 'maxBuyIn', 'actionSeconds', 'timeBankSeconds'] as const) {
    if (form[key] === base[key]) continue;
    const value = form[key];
    if (value === '' || (key !== 'ante' && key !== 'timeBankSeconds' && value <= 0) || value < 0) return 'Every amount needs a value.';
    out[key] = value;
  }
  for (const key of ['straddleEnabled', 'isPrivate', 'disableChatInHand'] as const) {
    if (form[key] !== base[key]) out[key] = form[key];
  }
  if (form.openSeatStack !== null && form.openSeatStack !== base.openSeatStack) {
    if (form.openSeatStack === '' || form.openSeatStack <= 0) return 'Every amount needs a value.';
    out.openSeatStack = form.openSeatStack;
  }
  return out;
}

/**
 * The inputs themselves. `privacyExtra` renders right under the privacy
 * checkbox (the owner menu shows the table's link there).
 */
export function TableSettingsFields({
  form,
  set,
  privacyExtra,
}: {
  form: SettingsForm;
  set: <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => void;
  privacyExtra?: React.ReactNode;
}): React.JSX.Element {
  const openSeating = form.openSeatStack !== null;
  return (
    <>
      <label>
        Table name
        <input type="text" maxLength={60} value={form.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="form-row">
        <label>
          Small blind ($)
          <MoneyInput minCents={1} cents={form.smallBlind} onChange={(c) => set('smallBlind', c)} />
        </label>
        <label>
          Big blind ($)
          <MoneyInput minCents={1} cents={form.bigBlind} onChange={(c) => set('bigBlind', c)} />
        </label>
      </div>
      <div className="form-row">
        <label>
          Ante ($)
          <MoneyInput minCents={0} cents={form.ante} onChange={(c) => set('ante', c)} />
        </label>
        <label className="checkbox-label owner-menu-inline-check">
          <input type="checkbox" checked={form.straddleEnabled} onChange={(e) => set('straddleEnabled', e.target.checked)} />
          Straddle
        </label>
      </div>
      <div className="form-row">
        <label>
          Min buy-in ($)
          <MoneyInput minCents={1} cents={form.minBuyIn} onChange={(c) => set('minBuyIn', c)} />
        </label>
        <label>
          Max buy-in ($)
          <MoneyInput minCents={1} cents={form.maxBuyIn} onChange={(c) => set('maxBuyIn', c)} />
        </label>
      </div>
      {openSeating && (
        <label>
          Starting chips for each player ($)
          <MoneyInput minCents={1} cents={form.openSeatStack ?? ''} onChange={(c) => set('openSeatStack', c)} />
        </label>
      )}
      <div className="form-row">
        <label>
          Seconds per action
          <input
            type="number"
            min={5}
            max={120}
            value={form.actionSeconds}
            onChange={(e) => set('actionSeconds', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
        <label>
          Time bank (seconds)
          <input
            type="number"
            min={0}
            max={600}
            value={form.timeBankSeconds}
            onChange={(e) => set('timeBankSeconds', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </label>
      </div>
      {/* An open-invite table is always private — only its link gets anyone in. */}
      {!openSeating && (
        <label className="checkbox-label">
          <input type="checkbox" checked={form.isPrivate} onChange={(e) => set('isPrivate', e.target.checked)} />
          Private table (invite link only, hidden from the lobby)
        </label>
      )}
      {privacyExtra}
      <label className="checkbox-label">
        <input type="checkbox" checked={form.disableChatInHand} onChange={(e) => set('disableChatInHand', e.target.checked)} />
        No chat for players still in a hand
      </label>
    </>
  );
}
